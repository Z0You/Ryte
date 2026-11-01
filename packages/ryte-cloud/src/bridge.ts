/*
This file is part of the Ryte project.

Copyright (C) 2026 Ryte contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * The page side of the Android cloud bridge.
 *
 * The Android app is React Native (Hermes), which has no WebCrypto, so the
 * MEGA and Filen libraries run here, inside a hidden WebView. The app sends
 * requests with `window.__ryteBridge.receive(json)`; answers go back through
 * `window.ReactNativeWebView.postMessage(json)`.
 *
 * Binary data crosses the bridge as base64 in pieces ("blobs"), so large
 * attachments never have to fit in a single message.
 */

import { RyteCloud } from "./index";
import { CloudDrive, DriveEntry, DriveFolder, KeyValueStore } from "./types";

type Request = { id: number; method: string; args: unknown[] };
type Response =
  | { id: number; result: unknown }
  | { id: number; error: { message: string; authRequired?: boolean } };
type Event = { event: "ready" } | { event: "store"; key: string; value: string | null };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __ryteBridge: { receive(message: string): void };
    __ryteTestDrive?: CloudDrive;
  }
}

function post(message: Response | Event) {
  const text = JSON.stringify(message);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
  else window.parent?.postMessage(text, "*");
}

/** Sessions live in the app (MMKV); every change is sent back to it. */
const memory = new Map<string, string>();
const store: KeyValueStore = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
    post({ event: "store", key, value });
  },
  removeItem: (key) => {
    memory.delete(key);
    post({ event: "store", key, value: null });
  }
};

const cloud = new RyteCloud(store, {
  // both are bundled into this page by scripts/build-bridge.mjs
  mega: async () => (await import("@ryte/megajs")) as never,
  filen: async () => (await import("@ryte/filen-sdk")) as never
});

const folders = new Map<number, DriveFolder>();
const blobs = new Map<number, Uint8Array[] | Uint8Array>();
let nextHandle = 1;

function toBase64(data: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < data.length; i += step)
    binary += String.fromCharCode(...data.subarray(i, i + step));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function joinBlob(id: number): Uint8Array {
  const value = blobs.get(id);
  if (!value) throw new Error(`Unknown blob ${id}`);
  if (value instanceof Uint8Array) return value;
  let total = 0;
  for (const part of value) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of value) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  blobs.set(id, out);
  return out;
}

function storeBlob(data: Uint8Array) {
  const id = nextHandle++;
  blobs.set(id, data);
  return { blob: id, size: data.byteLength };
}

function folderFor(handle: number) {
  const folder = folders.get(handle);
  if (!folder) throw new Error("This folder is no longer open.");
  return folder;
}

function drive(): CloudDrive {
  const value = cloud.drive();
  if (!value)
    throw new Error(
      "No cloud storage is connected. Connect MEGA or Filen to sync."
    );
  return value;
}

const methods: Record<string, (...args: never[]) => unknown> = {
  init(sessions: Record<string, string>) {
    memory.clear();
    for (const [key, value] of Object.entries(sessions || {}))
      memory.set(key, value);
    if (window.__ryteTestDrive) cloud.useTestDrive(window.__ryteTestDrive);
    return cloud.status() ?? null;
  },
  status: () => cloud.status() ?? null,
  connect: (provider: "mega" | "filen", email: string, password: string, code?: string) =>
    cloud.connect(provider, email, password, code),
  disconnect: () => cloud.disconnect(),
  quota: async () => (await drive().quota?.()) ?? null,

  async openFolder(name: string, create: boolean, fresh?: boolean) {
    const folder = await drive().openFolder(name, create, fresh);
    if (!folder) return null;
    const handle = nextHandle++;
    folders.set(handle, folder);
    return handle;
  },
  list: (handle: number) => folderFor(handle).list(),
  async read(handle: number, entry: DriveEntry) {
    return storeBlob(await folderFor(handle).read(entry));
  },
  write: (handle: number, name: string, blob: number) => {
    const data = joinBlob(blob);
    blobs.delete(blob);
    return folderFor(handle).write(name, data);
  },
  remove: (handle: number, entry: DriveEntry) =>
    folderFor(handle).remove(entry),
  closeFolder: (handle: number) => {
    folders.delete(handle);
  },

  filesSize: (hash: string) => cloud.files().size(hash),
  filesUpload: (hash: string, blob: number) => {
    const data = joinBlob(blob);
    blobs.delete(blob);
    return cloud.files().upload(hash, data);
  },
  async filesDownload(hash: string) {
    const data = await cloud.files().download(hash);
    return data ? storeBlob(data) : null;
  },
  filesRemove: (hashes: string[]) => cloud.files().remove(hashes),

  blobCreate() {
    const id = nextHandle++;
    blobs.set(id, []);
    return id;
  },
  blobAppend(id: number, base64: string) {
    const value = blobs.get(id);
    if (!Array.isArray(value)) throw new Error(`Unknown blob ${id}`);
    value.push(fromBase64(base64));
    return true;
  },
  blobRead(id: number, offset: number, length: number) {
    const data = joinBlob(id);
    return toBase64(data.subarray(offset, offset + length));
  },
  blobFree(id: number) {
    blobs.delete(id);
    return true;
  }
};

window.__ryteBridge = {
  receive(message: string) {
    let request: Request;
    try {
      request = JSON.parse(message) as Request;
    } catch {
      return;
    }
    const method = methods[request.method];
    Promise.resolve()
      .then(() => {
        if (!method) throw new Error(`Unknown method ${request.method}`);
        return (method as (...args: unknown[]) => unknown)(...request.args);
      })
      .then(
        (result) => post({ id: request.id, result: result ?? null }),
        (error: unknown) =>
          post({
            id: request.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
              authRequired: !!(error as { authRequired?: boolean })
                ?.authRequired
            }
          })
      );
  }
};

post({ event: "ready" });
