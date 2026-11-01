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

import { FilenAccount, FilenDrive, FilenModuleLoader } from "./filen";
import { MegaAccount, MegaDrive, MegaModuleLoader } from "./mega";
import {
  CloudDrive,
  CloudProvider,
  DriveEntry,
  DriveFolder,
  KeyValueStore,
  PROVIDER_NAMES
} from "./types";

export * from "./types";
export { describeMegaError } from "./mega";
export { describeFilenError } from "./filen";

const ProviderKey = "ryte.cloud.provider.v1";
export const RYTE_FILES_FOLDER = "Ryte Files";

export type CloudStatus = {
  provider: CloudProvider;
  displayName: string;
  email: string;
};

/**
 * The cloud storage this device syncs through: one of MEGA or Filen.
 * Sessions are kept in `store` (never passwords).
 */
export class RyteCloud {
  private readonly mega: MegaAccount;
  private readonly filen: FilenAccount;
  private readonly drives: Record<CloudProvider, CloudDrive>;
  private readonly listeners = new Set<() => void>();
  private filesStore?: AttachmentStore;
  private testDrive?: CloudDrive;

  constructor(
    private readonly store: KeyValueStore,
    loaders: { mega: MegaModuleLoader; filen: FilenModuleLoader }
  ) {
    this.mega = new MegaAccount(store, loaders.mega);
    this.filen = new FilenAccount(store, loaders.filen);
    this.drives = {
      mega: new MegaDrive(this.mega),
      filen: new FilenDrive(this.filen)
    };
  }

  /** For automated tests only: sync through the given (fake) drive. */
  useTestDrive(drive: CloudDrive | undefined) {
    this.testDrive = drive;
    this.filesStore?.reset();
    this.notify();
  }

  get provider(): CloudProvider | undefined {
    if (this.testDrive) return this.testDrive.provider;
    const value = this.store.getItem(ProviderKey);
    if (value !== "mega" && value !== "filen") return undefined;
    const email =
      value === "mega" ? this.mega.connectedEmail : this.filen.connectedEmail;
    return email ? value : undefined;
  }

  status(): CloudStatus | undefined {
    const provider = this.provider;
    if (!provider) return undefined;
    const drive = this.drive() as CloudDrive;
    return {
      provider,
      displayName: PROVIDER_NAMES[provider],
      email: drive.accountEmail
    };
  }

  /** The connected drive, or undefined when none is connected. */
  drive(): CloudDrive | undefined {
    if (this.testDrive) return this.testDrive;
    const provider = this.provider;
    return provider ? this.drives[provider] : undefined;
  }

  files(): AttachmentStore {
    return (this.filesStore ||= new AttachmentStore(() => this.drive()));
  }

  async connect(
    provider: CloudProvider,
    email: string,
    password: string,
    twoFactorCode?: string
  ): Promise<CloudStatus> {
    if (!email.trim() || !password)
      throw new Error("Enter your email and password.");
    const current = this.provider;
    if (current && current !== provider) await this.disconnect();

    if (provider === "mega") await this.mega.connect(email, password, twoFactorCode);
    else await this.filen.connect(email, password, twoFactorCode);
    this.store.setItem(ProviderKey, provider);
    this.filesStore?.reset();
    this.notify();
    return this.status() as CloudStatus;
  }

  async disconnect() {
    const provider = this.provider;
    if (provider === "mega") await this.mega.disconnect();
    if (provider === "filen") await this.filen.disconnect();
    this.store.removeItem(ProviderKey);
    this.filesStore?.reset();
    this.notify();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * Encrypted attachments, one file per attachment hash, in the "Ryte Files"
 * folder. The files are encrypted on the device before they get here.
 */
export class AttachmentStore {
  private folder?: { value: DriveFolder; entries: DriveEntry[]; at: number };
  private opening?: Promise<{ value: DriveFolder; entries: DriveEntry[] }>;

  constructor(private readonly getDrive: () => CloudDrive | undefined) {}

  reset() {
    this.folder = undefined;
  }

  private async open(fresh = false) {
    if (!fresh && this.folder && Date.now() - this.folder.at < 30_000)
      return this.folder;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const drive = this.getDrive();
      if (!drive)
        throw new Error(
          "No cloud storage is connected. Connect MEGA or Filen to sync attachments."
        );
      const value = await drive.openFolder(RYTE_FILES_FOLDER, true, fresh);
      if (!value) throw new Error("Could not open the Ryte Files folder.");
      const entries = await value.list();
      this.folder = { value, entries, at: Date.now() };
      return this.folder;
    })().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private find(entries: DriveEntry[], hash: string) {
    let newest: DriveEntry | undefined;
    for (const entry of entries)
      if (!entry.isFolder && entry.name === hash)
        if (!newest || entry.modified > newest.modified) newest = entry;
    return newest;
  }

  /** Size of the uploaded file in bytes; 0 when it isn't uploaded. */
  async size(hash: string): Promise<number> {
    let { entries } = await this.open();
    let entry = this.find(entries, hash);
    if (!entry) {
      ({ entries } = await this.open(true));
      entry = this.find(entries, hash);
    }
    if (!entry) return 0;
    return entry.size ?? 1;
  }

  async upload(hash: string, data: Uint8Array) {
    const { value, entries } = await this.open();
    const existing = this.find(entries, hash);
    if (existing && existing.size === data.byteLength) return;
    const written = await value.write(hash, data);
    entries.push(written);
  }

  async download(hash: string): Promise<Uint8Array | undefined> {
    let folder = await this.open();
    let entry = this.find(folder.entries, hash);
    if (!entry) {
      folder = await this.open(true);
      entry = this.find(folder.entries, hash);
    }
    if (!entry) return undefined;
    return await folder.value.read(entry);
  }

  async remove(hashes: string[]) {
    const { value, entries } = await this.open(true);
    const names = new Set(hashes);
    for (const entry of entries) {
      if (entry.isFolder || !names.has(entry.name)) continue;
      await value.remove(entry);
    }
    this.reset();
  }
}
