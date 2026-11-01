/*
This file is part of the Ryte project, a fork of Notesnook
(https://notesnook.com/).

Copyright (C) 2023 Streetwriters (Private) Limited
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
 * The few operations Ryte needs from a cloud drive (MEGA, Filen, …).
 *
 * Ryte has no server of its own: everything is kept, end-to-end encrypted,
 * in two folders at the top of the user's drive:
 *
 *  - "Ryte"        → account.json + the sync log of every device
 *  - "Ryte Files"  → encrypted attachments, one file per attachment hash
 *
 * Every app (web, Android) provides a `CloudDrive` for the service the user
 * connected. The adapters only move bytes; nothing here ever sees plaintext.
 */

export type CloudProvider = "mega" | "filen";

export type DriveEntry = {
  /** Stable id of this exact file (a new upload gets a new id). */
  id: string;
  name: string;
  isFolder: boolean;
  /** Size in bytes, when the service reports it. */
  size?: number;
  /** Milliseconds since epoch, used only for ordering. */
  modified: number;
};

export interface DriveFolder {
  /** Up-to-date list of the folder's direct children. */
  list(): Promise<DriveEntry[]>;
  read(entry: DriveEntry): Promise<Uint8Array>;
  /** Uploads a file. Services may replace an existing file of the same name or keep both. */
  write(name: string, data: Uint8Array): Promise<DriveEntry>;
  remove(entry: DriveEntry): Promise<void>;
}

export interface CloudDrive {
  readonly provider: CloudProvider;
  /** Shown to people, e.g. "MEGA" or "Filen". */
  readonly displayName: string;
  /** The email of the connected account. */
  readonly accountEmail: string;
  /** The named folder at the top of the drive; created when `create` is true and it is missing. */
  /** `fresh: false` lets a service reuse a recently loaded file list. */
  openFolder(
    name: string,
    create: boolean,
    fresh?: boolean
  ): Promise<DriveFolder | undefined>;
  /** Used / total bytes of the drive, when the service reports them. */
  quota?(): Promise<{ used: number; total: number } | undefined>;
}

export type CloudDriveAccessor = () => Promise<CloudDrive | undefined>;

export const RYTE_DATA_FOLDER = "Ryte";
export const RYTE_FILES_FOLDER = "Ryte Files";
export const RYTE_ACCOUNT_FILE = "account.json";

export function encodeJSON(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJSON<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Some services keep both copies when a file with the same name is uploaded
 * again. Returns the newest entry with the given name.
 */
export function newestEntry(
  entries: DriveEntry[],
  name: string
): DriveEntry | undefined {
  let newest: DriveEntry | undefined;
  for (const entry of entries) {
    if (entry.isFolder || entry.name !== name) continue;
    if (!newest || entry.modified > newest.modified) newest = entry;
  }
  return newest;
}

/** Writes a file, then removes older copies with the same name. */
export async function replaceFile(
  folder: DriveFolder,
  name: string,
  data: Uint8Array
): Promise<DriveEntry> {
  const before = (await folder.list()).filter(
    (e) => !e.isFolder && e.name === name
  );
  const written = await folder.write(name, data);
  for (const old of before) {
    if (old.id === written.id) continue;
    await folder.remove(old).catch(() => undefined);
  }
  return written;
}
