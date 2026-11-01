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

import { logger } from "../../logger.js";
import type Database from "../index.js";
import type { SyncTransferItem } from "../sync/types.js";
import { decodeJSON, DriveEntry, DriveFolder, encodeJSON } from "./drive.js";

/**
 * Sync through a plain cloud folder.
 *
 * Every device appends what it changed as numbered, append-only log files:
 *
 *   log-<deviceId>-<seq>.json   { chunks: SyncTransferItem[] }
 *
 * Items inside are encrypted exactly like Notesnook sends them to its sync
 * server (one cipher per item), so the drive only ever sees ciphertext.
 * Each device remembers, per other device, the last log it applied
 * ("cursors") and applies newer ones in order. Merging is the same as with
 * Notesnook's server (newest change wins, conflicting notes are flagged).
 *
 * To keep the folder small, a device that sees many logs writes a snapshot
 * of everything it has (snap-<deviceId>-<time>.json) and deletes the logs
 * the snapshot covers. Every other device applies a new snapshot once, so a
 * device that was behind gets the changes from logs that are gone.
 */

const LOG_PATTERN = /^log-(.+)-(\d{10})\.json$/;
const SNAPSHOT_PATTERN = /^snap-(.+)-(\d{13,})\.json$/;
const COMPACT_AFTER_LOGS = 120;

type LogFile = {
  app: "ryte";
  kind: "log";
  deviceId: string;
  seq: number;
  createdAt: number;
  chunks: SyncTransferItem[];
};

type SnapshotFile = {
  app: "ryte";
  kind: "snapshot";
  deviceId: string;
  createdAt: number;
  /** For every device: the last log whose changes are in this snapshot. */
  covers: Record<string, number>;
  chunks: SyncTransferItem[];
};

type LogRef = { entry: DriveEntry; deviceId: string; seq: number };
type SnapshotRef = { entry: DriveEntry; deviceId: string; time: number };

export function logFileName(deviceId: string, seq: number) {
  return `log-${deviceId}-${String(seq).padStart(10, "0")}.json`;
}

function parseEntries(entries: DriveEntry[]) {
  const logs: LogRef[] = [];
  const snapshots: SnapshotRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.isFolder) continue;
    // services that keep duplicate names: only use one copy
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);

    const log = LOG_PATTERN.exec(entry.name);
    if (log) {
      logs.push({ entry, deviceId: log[1], seq: parseInt(log[2]) });
      continue;
    }
    const snap = SNAPSHOT_PATTERN.exec(entry.name);
    if (snap)
      snapshots.push({ entry, deviceId: snap[1], time: parseInt(snap[2]) });
  }
  logs.sort((a, b) => a.seq - b.seq);
  snapshots.sort((a, b) => b.time - a.time);
  return { logs, snapshots };
}

export class CloudSync {
  private logger = logger.scope("RyteCloudSync");
  private folder?: DriveFolder;
  private entries: DriveEntry[] = [];

  constructor(private readonly db: Database) {}

  /** Opens the drive folder and lists it once for this sync. */
  async open() {
    this.folder = await this.db.ryte.dataFolder();
    this.entries = await this.folder.list();
    return this.folder;
  }

  private get dataFolder() {
    if (!this.folder) throw new Error("Cloud sync folder is not open.");
    return this.folder;
  }

  /**
   * Applies every change other devices made since the last sync.
   * `apply` is called for each chunk, in order.
   */
  async fetch(
    deviceId: string,
    apply: (chunk: SyncTransferItem) => Promise<void>,
    onProgress?: (count: number) => void
  ) {
    const folder = this.dataFolder;
    const { logs, snapshots } = parseEntries(this.entries);
    const cursors = { ...((await this.db.kv().read("ryteCursors")) || {}) };
    const appliedSnapshot = await this.db.kv().read("ryteSnapshot");

    const remoteLogs = logs.filter((l) => l.deviceId !== deviceId);
    const latest = snapshots.find((s) => s.deviceId !== deviceId);

    if (latest && latest.entry.name !== appliedSnapshot) {
      // Another device folded the logs into a snapshot. Logs this device
      // still needed may be gone, so apply the snapshot once (merging is
      // idempotent: items this device already has are left as they are).
      const snapshot = decodeJSON<SnapshotFile>(
        await folder.read(latest.entry)
      );
      this.logger.info("Applying snapshot", {
        name: latest.entry.name,
        chunks: snapshot.chunks.length
      });
      for (const chunk of snapshot.chunks) {
        await apply(chunk);
        onProgress?.(chunk.items.length);
      }
      for (const [id, seq] of Object.entries(snapshot.covers)) {
        if (id === deviceId) continue;
        cursors[id] = Math.max(cursors[id] || 0, seq);
      }
      await this.db.kv().write("ryteCursors", cursors);
      await this.db.kv().write("ryteSnapshot", latest.entry.name);
    }

    for (const log of remoteLogs) {
      if (log.seq <= (cursors[log.deviceId] || 0)) continue;
      const file = decodeJSON<LogFile>(await folder.read(log.entry));
      for (const chunk of file.chunks) {
        await apply(chunk);
        onProgress?.(chunk.items.length);
      }
      cursors[log.deviceId] = log.seq;
      await this.db.kv().write("ryteCursors", cursors);
    }
  }

  /** Writes the given chunks as this device's next log file. */
  async push(deviceId: string, chunks: SyncTransferItem[]) {
    if (!chunks.length) return;
    const folder = this.dataFolder;
    const seq = ((await this.db.kv().read("ryteSeq")) || 0) + 1;
    const file: LogFile = {
      app: "ryte",
      kind: "log",
      deviceId,
      seq,
      createdAt: Date.now(),
      chunks
    };
    const entry = await folder.write(logFileName(deviceId, seq), encodeJSON(file));
    this.entries.push(entry);
    await this.db.kv().write("ryteSeq", seq);
  }

  /**
   * When the folder has many logs, folds everything this device knows into
   * a snapshot and deletes the logs (and older snapshots) it replaces.
   */
  async compactIfNeeded(
    deviceId: string,
    collectAll: () => Promise<SyncTransferItem[]>
  ) {
    const folder = this.dataFolder;
    this.entries = await folder.list();
    const { logs, snapshots } = parseEntries(this.entries);
    if (logs.length < COMPACT_AFTER_LOGS) return;

    this.logger.info("Compacting cloud sync folder", { logs: logs.length });
    const covers: Record<string, number> = {
      ...((await this.db.kv().read("ryteCursors")) || {})
    };
    covers[deviceId] = (await this.db.kv().read("ryteSeq")) || 0;

    const time = Date.now();
    const snapshot: SnapshotFile = {
      app: "ryte",
      kind: "snapshot",
      deviceId,
      createdAt: time,
      covers,
      chunks: await collectAll()
    };
    const name = `snap-${deviceId}-${time}.json`;
    await folder.write(name, encodeJSON(snapshot));
    await this.db.kv().write("ryteSnapshot", name);

    for (const log of logs) {
      if (log.seq > (covers[log.deviceId] || 0)) continue;
      await folder.remove(log.entry).catch((e) =>
        this.logger.error(e, "Could not delete old sync log")
      );
    }
    for (const old of snapshots) {
      await folder.remove(old.entry).catch((e) =>
        this.logger.error(e, "Could not delete old snapshot")
      );
    }
  }
}
