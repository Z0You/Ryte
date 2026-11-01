/*
This file is part of the Ryte project. MEGA support is adapted from Rite.

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

/** The small part of the `megajs` API that Ryte uses. */
export interface MegaNode {
  nodeId?: string;
  name: string | null;
  /** Seconds since epoch */
  timestamp?: number;
  size?: number;
  directory: boolean;
  children?: MegaNode[];
  downloadBuffer(options: Record<string, unknown>): Promise<Uint8Array>;
  delete(permanent?: boolean): Promise<void>;
  upload(
    options: { name: string; size: number },
    data: Uint8Array
  ): { complete: Promise<MegaNode> };
  mkdir(name: string): Promise<MegaNode>;
}

export interface MegaStorage {
  root: MegaNode;
  user?: string;
  ready: Promise<unknown>;
  reload(force?: boolean): Promise<unknown>;
  toJSON(): MegaSessionJSON;
  close(): Promise<void>;
  api?: { request(json: object): Promise<Record<string, unknown>> };
}

export type MegaSessionJSON = {
  key: string;
  sid: string;
  name: string;
  user: string;
  options: Record<string, unknown>;
};

export interface MegaModule {
  Storage: {
    new (options: {
      email: string;
      password: string;
      secondFactorCode?: string;
      keepalive?: boolean;
      autoload?: boolean;
    }): MegaStorage;
    fromJSON(json: MegaSessionJSON): MegaStorage;
  };
}

export type MegaModuleLoader = () => Promise<MegaModule>;

const SessionStorageKey = "ryte.mega.session.v1";
/** How long a loaded file tree is reused before it is fetched again. */
const TREE_MAX_AGE_MS = 15_000;

type PersistedSession = { email: string; session: MegaSessionJSON };

/**
 * The connection to the user's MEGA account. Only MEGA's session id and
 * session key are kept on the device, never the MEGA password.
 */
export class MegaAccount {
  private cached?: { storage: MegaStorage; loadedAt: number };
  private loading?: Promise<MegaStorage>;

  constructor(
    private readonly store: KeyValueStore,
    private readonly loadModule: MegaModuleLoader
  ) {}

  get connectedEmail(): string | undefined {
    return this.readSession()?.email;
  }

  async connect(email: string, password: string, secondFactorCode?: string) {
    const mega = await this.loadModule();
    const storage = new mega.Storage({
      email: email.trim(),
      password,
      secondFactorCode: secondFactorCode?.trim() || undefined,
      keepalive: false,
      autoload: true
    });

    try {
      await storage.ready;
    } catch (error) {
      throw new Error(describeMegaError(error, true));
    }

    const session = storage.toJSON();
    this.store.setItem(
      SessionStorageKey,
      JSON.stringify({
        email: email.trim().toLowerCase(),
        session: {
          key: session.key,
          sid: session.sid,
          name: session.name,
          user: session.user,
          // megajs keeps the login options (including the password) here;
          // never persist them.
          options: { email: email.trim(), keepalive: false }
        }
      } satisfies PersistedSession)
    );
    // Never call storage.close() here: it logs the session out on MEGA's side.
    this.cached = { storage, loadedAt: Date.now() };
  }

  async disconnect() {
    const persisted = this.readSession();
    this.store.removeItem(SessionStorageKey);
    this.cached = undefined;
    if (persisted) {
      try {
        const mega = await this.loadModule();
        await mega.Storage.fromJSON({
          ...persisted.session,
          options: { ...persisted.session.options }
        }).close();
      } catch {
        // ending the session on MEGA's side is best effort
      }
    }
  }

  /**
   * A MEGA storage with an up-to-date file tree. Within one megajs Storage,
   * deleted files are only noticed over a live connection (which Ryte does
   * not keep open), so the tree is reloaded when it is older than a few
   * seconds.
   */
  async openStorage(fresh = false): Promise<MegaStorage> {
    if (
      !fresh &&
      this.cached &&
      Date.now() - this.cached.loadedAt < TREE_MAX_AGE_MS
    )
      return this.cached.storage;
    if (this.loading) return this.loading;

    this.loading = this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  /** Forgets the cached file tree, so the next use sees the latest files. */
  invalidate() {
    this.cached = undefined;
  }

  private async load(): Promise<MegaStorage> {
    const persisted = this.readSession();
    if (!persisted)
      throw new CloudAuthRequiredError(
        "Your MEGA account is not connected on this device. Connect it again to resume syncing."
      );

    const mega = await this.loadModule();
    const storage = mega.Storage.fromJSON({
      ...persisted.session,
      options: { ...persisted.session.options }
    });
    try {
      await storage.reload(true);
    } catch (error) {
      if (isSessionError(error)) {
        this.store.removeItem(SessionStorageKey);
        this.cached = undefined;
        throw new CloudAuthRequiredError(
          "Your MEGA session has ended. Please connect your MEGA account again."
        );
      }
      throw new Error(describeMegaError(error));
    }
    this.cached = { storage, loadedAt: Date.now() };
    return storage;
  }

  private readSession(): PersistedSession | undefined {
    try {
      const raw = this.store.getItem(SessionStorageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as PersistedSession;
      return parsed?.session?.sid && parsed.session.key ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

/** MEGA keeps both files when one with the same name is uploaded. */
export class MegaDrive implements CloudDrive {
  readonly provider = "mega" as const;
  readonly displayName = "MEGA";

  constructor(private readonly account: MegaAccount) {}

  get accountEmail() {
    return this.account.connectedEmail || "";
  }

  async openFolder(
    name: string,
    create: boolean,
    fresh = true
  ): Promise<DriveFolder | undefined> {
    // a folder is opened at the start of every sync: fetch the latest tree
    // then, so other devices' files are seen
    const storage = await this.account.openStorage(fresh);
    let folder = storage.root.children?.find(
      (child) => child.directory && child.name === name
    );
    if (!folder && create) folder = await storage.root.mkdir(name);
    return folder ? new MegaFolder(folder, this.account) : undefined;
  }

  async quota() {
    try {
      const storage = await this.account.openStorage();
      const quota = await storage.api?.request({ a: "uq", strg: 1 });
      if (typeof quota?.cstrg === "number" && typeof quota?.mstrg === "number")
        return { used: quota.cstrg, total: quota.mstrg };
    } catch {
      // quota is informational only
    }
    return undefined;
  }
}

class MegaFolder implements DriveFolder {
  private nodes = new Map<string, MegaNode>();

  constructor(
    private readonly node: MegaNode,
    private readonly account: MegaAccount
  ) {}

  async list(): Promise<DriveEntry[]> {
    return (this.node.children ?? [])
      .filter((child) => child.nodeId && child.name)
      .map((child) => this.entryFor(child));
  }

  async read(entry: DriveEntry): Promise<Uint8Array> {
    try {
      return await this.nodeFor(entry).downloadBuffer({});
    } catch (error) {
      throw new Error(describeMegaError(error));
    }
  }

  async write(name: string, data: Uint8Array): Promise<DriveEntry> {
    try {
      const uploaded = await this.node.upload(
        { name, size: data.byteLength },
        data
      ).complete;
      return this.entryFor(uploaded);
    } catch (error) {
      throw new Error(describeMegaError(error));
    }
  }

  async remove(entry: DriveEntry): Promise<void> {
    try {
      await this.nodeFor(entry).delete(true);
    } catch (error) {
      throw new Error(describeMegaError(error));
    } finally {
      this.account.invalidate();
    }
  }

  private entryFor(node: MegaNode): DriveEntry {
    const id = node.nodeId as string;
    this.nodes.set(id, node);
    return {
      id,
      name: node.name ?? "",
      isFolder: node.directory,
      size: node.size,
      modified: (node.timestamp ?? 0) * 1000
    };
  }

  private nodeFor(entry: DriveEntry): MegaNode {
    const node = this.nodes.get(entry.id);
    if (!node)
      throw new Error(`MEGA file ${entry.name} is no longer available.`);
    return node;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionError(error: unknown): boolean {
  return /ESID|\(-15\)|EBLOCKED|\(-16\)/.test(errorText(error));
}

/** Turns megajs' terse error codes into messages people can act on. */
export function describeMegaError(error: unknown, duringLogin = false): string {
  const text = errorText(error);
  if (/EMFAREQUIRED|\(-26\)/.test(text))
    return "Your MEGA account uses two-factor authentication. Enter the 6-digit code from your authenticator app.";
  if (duringLogin && /ENOENT|\(-9\)|EINCOMPLETE|EARGS|\(-2\)/.test(text))
    return "MEGA did not accept that email and password.";
  if (/EBLOCKED|\(-16\)/.test(text))
    return "This MEGA account is blocked. Check your account on mega.nz.";
  if (/EOVERQUOTA|\(-17\)/.test(text))
    return "Your MEGA storage is full. Free up space on mega.nz to keep syncing.";
  if (/ETOOMANY|ERATELIMIT|\(-4\)|\(-6\)/.test(text))
    return "MEGA is limiting requests right now. Please try again in a few minutes.";
  if (/Failed to fetch|NetworkError|network/i.test(text))
    return "Could not reach MEGA. Check your internet connection.";
  if (text.startsWith("MEGA ") || text.startsWith("Your MEGA")) return text;
  return `MEGA error: ${text}`;
}
