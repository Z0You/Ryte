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
 * The app side of the cloud bridge. MEGA and Filen run in a hidden WebView
 * (see packages/ryte-cloud/src/bridge.ts and RyteBridgeHost); this module
 * sends it requests and exposes the result as a CloudDrive for sync and as
 * attachment upload / download helpers.
 */

import type {
  CloudDrive,
  CloudProvider,
  DriveEntry,
  DriveFolder
} from "@notesnook/core";
import { Buffer } from "buffer";
import { MMKV } from "../common/database/mmkv";

export type CloudStatus = {
  provider: CloudProvider;
  displayName: string;
  email: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const SESSIONS_KEY = "ryte:cloud-sessions";
/** Size of one piece of binary data sent over the bridge. */
export const PIECE_SIZE = 1024 * 1024;

export class CloudAuthRequiredError extends Error {
  readonly authRequired = true;
}

class Bridge {
  private send?: (script: string) => void;
  private ready = false;
  private waiting: (() => void)[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private listeners = new Set<(status?: CloudStatus) => void>();
  status?: CloudStatus;

  /** Called by RyteBridgeHost when the WebView is mounted. */
  attach(send: (script: string) => void) {
    this.send = send;
  }

  /** Called by RyteBridgeHost when the WebView (re)loaded the page. */
  detach() {
    this.ready = false;
    for (const pending of this.pending.values())
      pending.reject(new Error("The cloud bridge was restarted."));
    this.pending.clear();
  }

  /** Called with every message the WebView posts. */
  async onMessage(text: string) {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.event === "ready") {
      this.ready = true;
      const status = await this.call<CloudStatus | null>(
        "init",
        readSessions()
      ).catch(() => null);
      this.setStatus(status || undefined);
      const waiting = this.waiting;
      this.waiting = [];
      waiting.forEach((resume) => resume());
      return;
    }
    if (message.event === "store") {
      const sessions = readSessions();
      if (message.value === null) delete sessions[message.key];
      else sessions[message.key] = message.value;
      MMKV.setString(SESSIONS_KEY, JSON.stringify(sessions));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = message.error.authRequired
        ? new CloudAuthRequiredError(message.error.message)
        : new Error(message.error.message);
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  /** Resolves once the page has started and the saved session is loaded. */
  whenReady() {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("The cloud bridge did not start.")),
        30000
      );
      this.waiting.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (method !== "init") await this.whenReady();
    if (!this.send) throw new Error("The cloud bridge is not running.");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, args });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.send!(
        `window.__ryteBridge.receive(${JSON.stringify(payload)});true;`
      );
    });
  }

  setStatus(status?: CloudStatus) {
    this.status = status;
    this.listeners.forEach((listener) => listener(status));
  }

  onStatus(listener: (status?: CloudStatus) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function readSessions(): Record<string, string> {
  try {
    return JSON.parse(MMKV.getString(SESSIONS_KEY) || "{}");
  } catch {
    return {};
  }
}

export const bridge = new Bridge();

/* ------------------------------ binary data ------------------------------ */

export async function sendBytes(data: Uint8Array): Promise<number> {
  const blob = await bridge.call<number>("blobCreate");
  for (let offset = 0; offset < data.byteLength; offset += PIECE_SIZE) {
    const piece = Buffer.from(
      data.buffer,
      data.byteOffset + offset,
      Math.min(PIECE_SIZE, data.byteLength - offset)
    ).toString("base64");
    await bridge.call("blobAppend", blob, piece);
  }
  return blob;
}

export async function receiveBytes(blob: {
  blob: number;
  size: number;
}): Promise<Uint8Array> {
  const out = new Uint8Array(blob.size);
  try {
    for (let offset = 0; offset < blob.size; offset += PIECE_SIZE) {
      const piece = await bridge.call<string>(
        "blobRead",
        blob.blob,
        offset,
        PIECE_SIZE
      );
      out.set(Buffer.from(piece, "base64"), offset);
    }
  } finally {
    await bridge.call("blobFree", blob.blob).catch(() => undefined);
  }
  return out;
}

/* --------------------------------- drive --------------------------------- */

class BridgeFolder implements DriveFolder {
  constructor(private readonly handle: number) {}

  list() {
    return bridge.call<DriveEntry[]>("list", this.handle);
  }

  async read(entry: DriveEntry) {
    const blob = await bridge.call<{ blob: number; size: number }>(
      "read",
      this.handle,
      entry
    );
    return receiveBytes(blob);
  }

  async write(name: string, data: Uint8Array) {
    const blob = await sendBytes(data);
    return bridge.call<DriveEntry>("write", this.handle, name, blob);
  }

  async remove(entry: DriveEntry) {
    await bridge.call("remove", this.handle, entry);
  }
}

/** The connected MEGA / Filen drive, used by sync (db.options.cloud). */
export function getBridgeDrive(): CloudDrive | undefined {
  const status = bridge.status;
  if (!status) return undefined;
  return {
    provider: status.provider,
    displayName: status.displayName,
    accountEmail: status.email,
    async openFolder(name: string, create: boolean, fresh?: boolean) {
      const handle = await bridge.call<number | null>(
        "openFolder",
        name,
        create,
        fresh
      );
      return handle ? new BridgeFolder(handle) : undefined;
    },
    async quota() {
      return (
        (await bridge.call<{ used: number; total: number } | null>("quota")) ||
        undefined
      );
    }
  };
}

/* ------------------------------ connection ------------------------------- */

export const RyteCloud = {
  status: () => bridge.status,
  onStatus: (listener: (status?: CloudStatus) => void) =>
    bridge.onStatus(listener),
  async connect(
    provider: CloudProvider,
    email: string,
    password: string,
    code?: string
  ) {
    const status = await bridge.call<CloudStatus>(
      "connect",
      provider,
      email,
      password,
      code
    );
    bridge.setStatus(status);
    return status;
  },
  async disconnect() {
    await bridge.call("disconnect").catch(() => undefined);
    bridge.setStatus(undefined);
  },
  async refreshStatus() {
    const status = await bridge.call<CloudStatus | null>("status");
    bridge.setStatus(status || undefined);
    return status || undefined;
  }
};

/* ------------------------------ attachments ------------------------------ */

export const RyteFiles = {
  /** Encrypted size in the drive; 0 when missing. */
  size: (hash: string) => bridge.call<number>("filesSize", hash),
  /** Uploads base64 pieces (each one decodes on its own) as the file `hash`. */
  async upload(
    hash: string,
    readPieces: (onPiece: (base64: string) => Promise<void>) => Promise<void>
  ) {
    const blob = await bridge.call<number>("blobCreate");
    try {
      await readPieces(async (piece) => {
        await bridge.call("blobAppend", blob, piece);
      });
      await bridge.call("filesUpload", hash, blob);
    } catch (e) {
      await bridge.call("blobFree", blob).catch(() => undefined);
      throw e;
    }
  },
  async download(
    hash: string,
    writePiece: (base64: string) => Promise<void>,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<number | undefined> {
    const blob = await bridge.call<{ blob: number; size: number } | null>(
      "filesDownload",
      hash
    );
    if (!blob) return undefined;
    try {
      for (let offset = 0; offset < blob.size; offset += PIECE_SIZE) {
        const piece = await bridge.call<string>(
          "blobRead",
          blob.blob,
          offset,
          PIECE_SIZE
        );
        await writePiece(piece);
        onProgress?.(Math.min(offset + PIECE_SIZE, blob.size), blob.size);
      }
    } finally {
      await bridge.call("blobFree", blob.blob).catch(() => undefined);
    }
    return blob.size;
  },
  remove: (hashes: string[]) => bridge.call("filesRemove", hashes)
};
