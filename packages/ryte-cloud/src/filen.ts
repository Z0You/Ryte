/*
This file is part of the Ryte project. Filen support is adapted from Rite.

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

import {
  CloudAuthRequiredError,
  CloudDrive,
  DriveEntry,
  DriveFolder,
  KeyValueStore
} from "./types";

export type FilenCloudItem =
  | {
      type: "directory";
      uuid: string;
      name: string;
      timestamp: number;
      lastModified: number;
      parent: string;
    }
  | {
      type: "file";
      uuid: string;
      name: string;
      timestamp: number;
      lastModified: number;
      parent: string;
      size: number;
      mime: string;
      version: number;
      chunks: number;
      key: string;
      bucket: string;
      region: string;
    };

/** The session part of the SDK config kept on the device (never the password). */
export type FilenSessionConfig = {
  email?: string;
  masterKeys?: string[];
  apiKey?: string;
  publicKey?: string;
  privateKey?: string;
  authVersion?: number;
  baseFolderUUID?: string;
  userId?: number;
};

export interface FilenSDKInstance {
  config: FilenSessionConfig & Record<string, unknown>;
  login(params: {
    email: string;
    password: string;
    twoFactorCode?: string;
  }): Promise<void>;
  cloud(): {
    listDirectory(params: {
      uuid: string;
      onlyDirectories?: boolean;
    }): Promise<FilenCloudItem[]>;
    createDirectory(params: {
      name: string;
      parent: string;
      renameIfExists?: boolean;
    }): Promise<string>;
    uploadWebFile(params: {
      file: File;
      parent: string;
      name?: string;
    }): Promise<FilenCloudItem>;
    downloadFileToReadableStream(params: {
      uuid: string;
      bucket: string;
      region: string;
      version: number;
      key: string;
      size: number;
      chunks: number;
    }): ReadableStream<Uint8Array>;
    deleteFile(params: { uuid: string }): Promise<void>;
  };
  api(version: 3): {
    user(): {
      account(): Promise<{ storage?: number; maxStorage?: number }>;
    };
  };
}

export interface FilenModule {
  FilenSDK: new (config: Record<string, unknown>) => FilenSDKInstance;
}

export type FilenModuleLoader = () => Promise<FilenModule>;

const SessionStorageKey = "ryte.filen.session.v1";

const SessionFields: (keyof FilenSessionConfig)[] = [
  "email",
  "masterKeys",
  "apiKey",
  "publicKey",
  "privateKey",
  "authVersion",
  "baseFolderUUID",
  "userId"
];

/**
 * The connection to the user's Filen account through Filen's official SDK.
 * Only Filen's session (API key and master keys) is kept on the device,
 * never the Filen password.
 */
export class FilenAccount {
  private sdk: FilenSDKInstance | undefined;

  constructor(
    private readonly store: KeyValueStore,
    private readonly loadModule: FilenModuleLoader
  ) {}

  get connectedEmail(): string | undefined {
    return this.readSession()?.email;
  }

  async connect(email: string, password: string, twoFactorCode?: string) {
    const { FilenSDK } = await this.loadModule();
    const sdk = new FilenSDK({ metadataCache: true, connectToSocket: false });

    try {
      await sdk.login({
        email: email.trim(),
        password,
        twoFactorCode: twoFactorCode?.trim() || undefined
      });
    } catch (error) {
      throw new Error(describeFilenError(error));
    }

    const session: FilenSessionConfig = {};
    for (const field of SessionFields) {
      const value = sdk.config[field];
      if (value !== undefined)
        (session as Record<string, unknown>)[field] = value;
    }
    session.email = email.trim().toLowerCase();

    if (
      !session.apiKey ||
      !session.masterKeys?.length ||
      !session.baseFolderUUID
    )
      throw new Error("Filen sign-in did not complete. Please try again.");

    this.store.setItem(SessionStorageKey, JSON.stringify(session));
    this.sdk = sdk;
  }

  async disconnect() {
    this.sdk = undefined;
    this.store.removeItem(SessionStorageKey);
  }

  async open(): Promise<{ sdk: FilenSDKInstance; rootFolder: string }> {
    const session = this.readSession();
    if (!session)
      throw new CloudAuthRequiredError(
        "Your Filen account is not connected on this device. Connect it again to resume syncing."
      );
    if (!this.sdk) {
      const { FilenSDK } = await this.loadModule();
      this.sdk = new FilenSDK({
        ...session,
        metadataCache: true,
        connectToSocket: false
      });
    }
    return { sdk: this.sdk, rootFolder: session.baseFolderUUID as string };
  }

  async handleRequestError(error: unknown): Promise<never> {
    if (isSessionError(error)) {
      await this.disconnect();
      throw new CloudAuthRequiredError(
        "Your Filen session has ended. Please connect your Filen account again."
      );
    }
    throw new Error(describeFilenError(error));
  }

  private readSession(): FilenSessionConfig | undefined {
    try {
      const raw = this.store.getItem(SessionStorageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as FilenSessionConfig;
      return parsed?.apiKey &&
        parsed.masterKeys?.length &&
        parsed.baseFolderUUID
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Filen adapter. Every listing is fetched from Filen (no cache), so each
 * device sees what the others saved. Filen keeps older versions of a file
 * when one with the same name is uploaded.
 */
export class FilenDrive implements CloudDrive {
  readonly provider = "filen" as const;
  readonly displayName = "Filen";

  constructor(private readonly account: FilenAccount) {}

  get accountEmail() {
    return this.account.connectedEmail || "";
  }

  async openFolder(
    name: string,
    create: boolean
  ): Promise<DriveFolder | undefined> {
    const { sdk, rootFolder } = await this.account.open();
    try {
      const items = await sdk
        .cloud()
        .listDirectory({ uuid: rootFolder, onlyDirectories: true });
      let folder = items.find(
        (item) => item.type === "directory" && item.name === name
      )?.uuid;
      if (!folder && create)
        folder = await sdk.cloud().createDirectory({ name, parent: rootFolder });
      return folder ? new FilenFolder(sdk, folder, this.account) : undefined;
    } catch (error) {
      return this.account.handleRequestError(error);
    }
  }

  async quota() {
    try {
      const { sdk } = await this.account.open();
      const info = await sdk.api(3).user().account();
      if (
        typeof info?.storage === "number" &&
        typeof info?.maxStorage === "number"
      )
        return { used: info.storage, total: info.maxStorage };
    } catch {
      // quota is informational only
    }
    return undefined;
  }
}

class FilenFolder implements DriveFolder {
  private items = new Map<string, FilenCloudItem>();

  constructor(
    private readonly sdk: FilenSDKInstance,
    private readonly uuid: string,
    private readonly account: FilenAccount
  ) {}

  async list(): Promise<DriveEntry[]> {
    try {
      const items = await this.sdk.cloud().listDirectory({ uuid: this.uuid });
      return items.map((item) => this.entryFor(item));
    } catch (error) {
      return this.account.handleRequestError(error);
    }
  }

  async read(entry: DriveEntry): Promise<Uint8Array> {
    const item = this.items.get(entry.id);
    if (!item || item.type !== "file")
      throw new Error(`Filen file ${entry.name} is no longer available.`);
    try {
      const stream = this.sdk.cloud().downloadFileToReadableStream({
        uuid: item.uuid,
        bucket: item.bucket,
        region: item.region,
        version: item.version,
        key: item.key,
        size: item.size,
        chunks: item.chunks
      });
      return await readAll(stream);
    } catch (error) {
      return this.account.handleRequestError(error);
    }
  }

  async write(name: string, data: Uint8Array): Promise<DriveEntry> {
    try {
      const file = new File([data], name, {
        type: "application/octet-stream"
      });
      const uploaded = await this.sdk
        .cloud()
        .uploadWebFile({ file, parent: this.uuid, name });
      return this.entryFor(uploaded);
    } catch (error) {
      return this.account.handleRequestError(error);
    }
  }

  async remove(entry: DriveEntry): Promise<void> {
    try {
      await this.sdk.cloud().deleteFile({ uuid: entry.id });
    } catch (error) {
      return this.account.handleRequestError(error);
    }
  }

  private entryFor(item: FilenCloudItem): DriveEntry {
    this.items.set(item.uuid, item);
    return {
      id: item.uuid,
      name: item.name,
      isFolder: item.type === "directory",
      size: item.type === "file" ? item.size : undefined,
      modified: item.lastModified || item.timestamp
    };
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function errorParts(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "",
    message: error instanceof Error ? error.message : String(error)
  };
}

function isSessionError(error: unknown): boolean {
  const { code, message } = errorParts(error);
  return /api_key_not_found|invalid_api_key|unauthorized/i.test(
    `${code} ${message}`
  );
}

/** Turns Filen's error codes into messages people can act on. */
export function describeFilenError(error: unknown): string {
  const { code, message } = errorParts(error);
  const text = `${code} ${message}`;
  if (/enter_2fa|2fa.*required|two.?factor.*required/i.test(text))
    return "Your Filen account uses two-factor authentication. Enter the 6-digit code from your authenticator app.";
  if (/wrong_2fa|invalid.*2fa|2fa.*(wrong|invalid)/i.test(text))
    return "That two-factor code was not accepted. Check the code and try again.";
  if (
    /email_or_password_wrong|wrong.*password|invalid.*(email|password|credentials)|account_not_found/i.test(
      text
    )
  )
    return "Filen did not accept that email and password.";
  if (/storage|quota|max_storage/i.test(code))
    return "Your Filen storage is full. Free up space on filen.io to keep syncing.";
  if (/rate|too.?many/i.test(text))
    return "Filen is limiting requests right now. Please try again in a few minutes.";
  if (/Failed to fetch|NetworkError|Network Error|ECONN|timeout/i.test(text))
    return "Could not reach Filen. Check your internet connection.";
  return `Filen error: ${message}`;
}
