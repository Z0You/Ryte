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

import { RyteCloud, KeyValueStore } from "@ryte/cloud";

function safeLocalStorage(): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    getItem(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    },
    removeItem(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        memory.delete(key);
      }
    }
  };
}

/**
 * The MEGA / Filen storage this browser syncs through. The libraries of each
 * service are only downloaded when that service is used.
 */
export const ryteCloud = new RyteCloud(safeLocalStorage(), {
  mega: async () =>
    (await import("@ryte/megajs")) as unknown as Awaited<
      ReturnType<ConstructorParameters<typeof RyteCloud>[1]["mega"]>
    >,
  filen: async () =>
    (await import("@ryte/filen-sdk")) as unknown as Awaited<
      ReturnType<ConstructorParameters<typeof RyteCloud>[1]["filen"]>
    >
});

if (IS_TESTING) {
  // end-to-end tests provide an in-memory drive before the app loads
  const testDrive = (globalThis as Record<string, unknown>).__ryteTestDrive;
  if (testDrive)
    ryteCloud.useTestDrive(
      testDrive as Parameters<typeof ryteCloud.useTestDrive>[0]
    );
  (globalThis as Record<string, unknown>).__ryteCloud = ryteCloud;
}
