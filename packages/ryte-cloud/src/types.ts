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

// Same shapes as in @notesnook/core (api/ryte/drive.ts). Declared here too so
// this package can be bundled on its own (Android loads it in a WebView).

export type CloudProvider = "mega" | "filen";

export type DriveEntry = {
  id: string;
  name: string;
  isFolder: boolean;
  size?: number;
  modified: number;
};

export interface DriveFolder {
  list(): Promise<DriveEntry[]>;
  read(entry: DriveEntry): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<DriveEntry>;
  remove(entry: DriveEntry): Promise<void>;
}

export interface CloudDrive {
  readonly provider: CloudProvider;
  readonly displayName: string;
  readonly accountEmail: string;
  /** `fresh: false` lets a service reuse a recently loaded file list. */
  openFolder(
    name: string,
    create: boolean,
    fresh?: boolean
  ): Promise<DriveFolder | undefined>;
  quota?(): Promise<{ used: number; total: number } | undefined>;
}

export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Thrown when the saved session of the cloud service is missing or ended. */
export class CloudAuthRequiredError extends Error {
  readonly authRequired = true;
  constructor(message: string) {
    super(message);
    this.name = "CloudAuthRequiredError";
  }
}

export const PROVIDER_NAMES: Record<CloudProvider, string> = {
  mega: "MEGA",
  filen: "Filen"
};
