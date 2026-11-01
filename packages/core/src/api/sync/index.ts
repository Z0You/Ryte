/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

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
  checkSyncStatus,
  CURRENT_DATABASE_VERSION,
  EVENTS,
  sendSyncProgressEvent,
  SYNC_CHECK_IDS
} from "../../common.js";
import Constants from "../../utils/constants.js";
import Collector from "./collector.js";
import Merger, { handleInboxItems } from "./merger.js";
import { AutoSync } from "./auto-sync.js";
import { logger } from "../../logger.js";
import { Mutex } from "async-mutex";
import Database from "../index.js";
import { migrateItem, migrateVaultKey } from "../../migrations.js";
import { SerializedKey } from "@notesnook/crypto";
import {
  Attachment,
  isDeleted,
  isTrashItem,
  Item,
  MaybeDeletedItem,
  Monograph,
  Note,
  Notebook
} from "../../types.js";
import {
  KEY_VERSION,
  KeyVersion,
  SYNC_COLLECTIONS_MAP,
  SyncableItemType,
  SyncInboxItem,
  SyncTransferItem
} from "./types.js";
import { DownloadableFile } from "../../database/fs.js";
import { SyncDevices } from "./devices.js";
import { DefaultColors } from "../../collections/colors.js";
import { CloudSync } from "../ryte/cloud-sync.js";

export type SyncOptions = {
  type: "full" | "fetch" | "send";
  force?: boolean;
  offlineMode?: boolean;
};

export default class SyncManager {
  sync;
  devices;
  constructor(private readonly db: Database) {
    this.sync = new Sync(db);
    this.devices = this.sync.devices;
  }

  async start(options: SyncOptions) {
    try {
      if (await checkSyncStatus(this.db.eventManager, SYNC_CHECK_IDS.autoSync))
        await this.sync.autoSync.start();
      await this.sync.start(options);
      return true;
    } catch (e) {
      const isHubException = (e as Error).message.includes("HubException:");
      if (isHubException) {
        const actualError = /HubException: (.*)/gm.exec((e as Error).message);
        const errorText =
          actualError && actualError.length > 1
            ? actualError[1]
            : (e as Error).message;

        // NOTE: sometimes there's the case where the user has already
        // confirmed their email but the server still thinks that it
        // isn't confirmed. This check is added to trigger a force
        // update of the access token.
        if (
          (errorText.includes("Please confirm your email ") ||
            errorText.includes("Invalid token.")) &&
          (await this.db.user.getUser())?.isEmailConfirmed
        ) {
          await this.db.tokenManager._refreshToken(true);
          return false;
        }

        throw new Error(errorText);
      }
      throw e;
    }
  }

  async acquireLock(callback: () => Promise<void>) {
    try {
      this.sync.autoSync.stop();
      await callback();
    } finally {
      await this.sync.autoSync.start();
    }
  }

  async stop() {
    await this.sync.cancel();
  }
}

export class Sync {
  collector;
  merger;
  autoSync;
  logger = logger.scope("Sync");
  syncMutex = new Mutex();
  cloud: CloudSync;
  private cancelled = false;
  devices;
  private conflictedNoteIds: string[] = [];
  private uncachedAttachments: DownloadableFile[] = [];

  constructor(private readonly db: Database) {
    this.collector = new Collector(db);
    this.merger = new Merger(db);
    this.autoSync = new AutoSync(db, 1000);
    this.devices = new SyncDevices(db.kv, db.tokenManager);
    this.cloud = new CloudSync(db);

    db.eventManager.subscribe(EVENTS.userLoggedOut, async () => {
      this.cancelled = true;
      this.autoSync.stop();
    });
  }

  async start(options: SyncOptions) {
    // Ryte: one sync at a time; there is no live connection to a server,
    // every sync reads and writes the "Ryte" folder of the user's drive.
    await this.syncMutex.runExclusive(() => this.run(options));
  }

  private async run(options: SyncOptions) {
    this.cancelled = false;
    if (!(await checkSyncStatus(this.db.eventManager, SYNC_CHECK_IDS.sync)))
      return;
    if (!(await this.db.user.getUser())) return;

    this.logger.info("Starting sync", options);

    await this.cloud.open();
    // keys added by other devices (e.g. the attachments key)
    await this.db.ryte.refresh().catch((e) =>
      this.logger.error(e, "Could not refresh Ryte account")
    );

    const { deviceId } = await this.init(options.force);
    this.logger.info("Initialized sync", { deviceId });

    if (options.type === "fetch" || options.type === "full") {
      await this.fetch(deviceId, options);
      this.logger.info("Data fetched");
    }

    if (options.type === "send" || options.type === "full") {
      const forcePush =
        options.force || !!(await this.db.kv().read("ryteForcePush"));
      if (await this.send(deviceId, forcePush))
        this.logger.info("New data sent");
      if (forcePush) await this.db.kv().delete("ryteForcePush");
    }

    if (options.type === "full" && !this.cancelled) {
      await this.cloud
        .compactIfNeeded(deviceId, async () => {
          const chunks: SyncTransferItem[] = [];
          for await (const chunk of this.collector.collect(500, true))
            chunks.push(chunk);
          return chunks;
        })
        .catch((e) => this.logger.error(e, "Could not compact sync folder"));
    }

    await this.stop(options);
  }

  async init(isForceSync?: boolean) {
    if (isForceSync) {
      await this.devices.unregister();
      await this.devices.register();
    }

    let deviceId = await this.devices.get();
    if (!deviceId) {
      await this.devices.register();
      deviceId = await this.devices.get();
    }

    if (!deviceId) throw new Error("Sync device not registered.");

    return { deviceId };
  }

  async fetch(deviceId: string, options: SyncOptions) {
    const keys = await this.db.user.getDataEncryptionKeys();
    if (!keys || !keys.length) {
      this.db.eventManager.publish(EVENTS.userSessionExpired);
      throw new Error("User encryption keys not generated. Please relogin.");
    }

    await this.cloud.fetch(
      deviceId,
      async (chunk) => {
        if (this.cancelled) throw new Error("Sync canceled.");
        this.logger.info(
          `Received chunk for type ${chunk.type} with ${chunk.items.length} items.`
        );
        await this.processChunk(chunk, keys, options);
      },
      (count) => sendSyncProgressEvent(this.db.eventManager, `download`, count)
    );

    if (this.conflictedNoteIds.length > 0) {
      await this.db
        .sql()
        .updateTable("notes")
        .where("id", "in", this.conflictedNoteIds)
        .set({ conflicted: true })
        .execute();
      this.conflictedNoteIds = [];
    }

    if (this.uncachedAttachments.length > 0 && options.offlineMode) {
      await this.db
        .fs()
        .queueDownloads(this.uncachedAttachments, "offline-mode", {
          readOnDownload: false
        });
      this.uncachedAttachments = [];
    }
  }

  async send(deviceId: string, isForceSync?: boolean) {
    await this.uploadAttachments();

    const chunks: SyncTransferItem[] = [];
    let total = 0;
    for await (const chunk of this.collector.collect(100, isForceSync)) {
      chunks.push(chunk);
      total += chunk.items.length;
    }
    if (total === 0) return false;

    try {
      await this.cloud.push(deviceId, chunks);
    } catch (e) {
      // the collector already marked these items as synced; undo that so
      // they are sent again next time
      for (const chunk of chunks) {
        const collection = this.db[SYNC_COLLECTIONS_MAP[chunk.type]].collection;
        await this.db
          .sql()
          .updateTable(collection.type)
          .where(
            "id",
            "in",
            chunk.items.map((i) => i.id)
          )
          .set({ synced: false })
          .execute();
      }
      throw e;
    }
    sendSyncProgressEvent(this.db.eventManager, "upload", total);
    this.logger.info(`Sync send completed. Sent ${total} items.`);
    return true;
  }

  async stop(options: SyncOptions) {
    if (
      (options.type === "send" || options.type === "full") &&
      (await this.collector.hasUnsyncedChanges())
    ) {
      this.logger.info("Changes made during last sync. Syncing again...");
      await this.run({ type: "send" });
      return;
    }
    // refresh monographs
    await this.db.monographs.refresh().catch(this.logger.error);
    // update trash cache
    await this.db.trash.cleanup();

    this.logger.info("Stopping sync");
    await this.db.setLastSynced(Date.now());
    this.db.eventManager.publish(EVENTS.syncCompleted);
  }

  async cancel() {
    this.logger.info("Sync canceled");
    this.cancelled = true;
  }

  /**
   * @private
   */
  async uploadAttachments() {
    const attachments = await this.db.attachments.pending.items();
    this.logger.info("Uploading attachments...", { total: attachments.length });

    await this.db.fs().queueUploads(
      attachments.map<DownloadableFile>((a) => ({
        filename: a.hash,
        chunkSize: a.chunkSize
      })),
      "sync-uploads"
    );
  }

  /**
   * @private
   */
  async onPushCompleted(deviceId: string) {
    this.db.eventManager.publish(
      EVENTS.databaseSyncRequested,
      true,
      false,
      deviceId
    );
  }

  async processChunk(
    chunk: SyncTransferItem,
    keys: {
      version: KeyVersion;
      key: SerializedKey;
    }[],
    options: SyncOptions
  ) {
    const itemType = chunk.type;
    const decrypted: string[] = [];

    // Pre-group items by keyVersion for O(1) lookups
    const itemsByKeyVersion = new Map<KeyVersion, typeof chunk.items>();
    const versionMap = new Map<string, number>();

    for (const item of chunk.items) {
      const keyVersion = item.keyVersion ?? KEY_VERSION.LEGACY;
      const group = itemsByKeyVersion.get(keyVersion);
      if (group) {
        group.push(item);
      } else {
        itemsByKeyVersion.set(keyVersion, [item]);
      }
      versionMap.set(item.id, item.v);
    }

    for (const keyInfo of keys) {
      const itemsToDecrypt = itemsByKeyVersion.get(keyInfo.version);
      if (!itemsToDecrypt || itemsToDecrypt.length === 0) continue;

      this.logger.info("Decrypting using key", {
        keyInfo: keyInfo.version,
        items: itemsToDecrypt.length
      });
      decrypted.push(
        ...(await this.db.storage().decryptMulti(keyInfo.key, itemsToDecrypt))
      );
    }

    const deserialized: MaybeDeletedItem<Item>[] = [];
    for (let i = 0; i < decrypted.length; ++i) {
      const decryptedItem = JSON.parse(decrypted[i]) as MaybeDeletedItem<Item>;
      const version = versionMap.get(decryptedItem.id);
      if (version === undefined) {
        this.logger.error(
          new Error(
            `Version not found for item ${decryptedItem.id}. Skipping item.`
          )
        );
        continue;
      }
      const item = await deserializeItem(
        decryptedItem,
        itemType,
        version,
        this.db
      );
      if (item) deserialized.push(item);
    }

    const collectionType = SYNC_COLLECTIONS_MAP[itemType];

    if (!collectionType) {
      this.logger.error(
        new Error(
          `Unknown collection type for item type ${itemType}. Skipping chunk.`
        )
      );
      return;
    }

    const collection = this.db[collectionType].collection;
    const localItems = await collection.records(chunk.items.map((i) => i.id));
    let items: (MaybeDeletedItem<Item> | undefined)[] = [];
    if (itemType === "content") {
      items = deserialized.map((item) =>
        this.merger.mergeContent(item, localItems[item.id])
      );
    } else {
      items =
        itemType === "attachment"
          ? await Promise.all(
              deserialized.map((item) =>
                this.merger.mergeAttachment(
                  item as MaybeDeletedItem<Attachment>,
                  localItems[item.id] as MaybeDeletedItem<Attachment>
                )
              )
            )
          : deserialized.map((item) =>
              this.merger.mergeItem(item, localItems[item.id])
            );
    }

    if (itemType === "note" || itemType === "content") {
      items.forEach((item) =>
        this.db.eventManager.publish(EVENTS.syncItemMerged, item)
      );

      for (const item of items)
        if (!item?.deleted && item?.type === "tiptap" && !!item.conflicted)
          this.conflictedNoteIds.push(item.noteId);
    }

    if (itemType === "attachment" && options.offlineMode)
      for (const item of items)
        if (!item?.deleted && item?.type === "attachment")
          this.uncachedAttachments.push({
            filename: item.hash,
            chunkSize: item.chunkSize
          });

    this.logger.debug(`Merged ${items.length} items for type ${itemType}`, {
      ids: items.map((i) => i?.id)
    });
    await collection.put(items as any);
  }

}

async function deserializeItem(
  item: MaybeDeletedItem<Item>,
  type: SyncableItemType,
  version: number,
  database: Database
): Promise<MaybeDeletedItem<Item> | undefined> {
  item.remote = true;
  item.synced = true;

  let migrationResult = await migrateItem(
    item,
    version,
    CURRENT_DATABASE_VERSION,
    isDeleted(item) ? type : item.type,
    database,
    "sync"
  );
  if (migrationResult === "skip") return;

  // since items in trash can have their own set of migrations,
  // we have to run the migration again to account for that.
  if (isTrashItem(item)) {
    migrationResult = await migrateItem(
      item as unknown as Note | Notebook,
      version,
      CURRENT_DATABASE_VERSION,
      item.itemType,
      database,
      "sync"
    );
    if (migrationResult === "skip") return;
  }

  const itemType = isDeleted(item)
    ? type
    : // colors are naively of type "tag" instead of "color" so we have to fix that.
    item.type === "tag" && DefaultColors[item.title.toLowerCase()]
    ? "color"
    : item.type === "trash" && "itemType" in item && item.itemType
    ? item.itemType
    : item.type;

  if (!itemType || itemType === "topic" || itemType === "settings") return;

  if (migrationResult) item.synced = false;

  return item;
}
