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

import { Cipher } from "@notesnook/crypto";
import { EVENTS } from "../../common.js";
import {
  SubscriptionPlan,
  SubscriptionProvider,
  SubscriptionStatus,
  User,
  UserKeys
} from "../../types.js";
import { getId } from "../../utils/id.js";
import type Database from "../index.js";
import {
  CloudDrive,
  decodeJSON,
  DriveFolder,
  encodeJSON,
  newestEntry,
  replaceFile,
  RYTE_ACCOUNT_FILE,
  RYTE_DATA_FOLDER
} from "./drive.js";

const KEY_CHECK = "ryte-key-check-v1";

/**
 * Stored in the "Ryte" folder of the user's drive. It holds nothing secret:
 * the salt, a value encrypted with the user's key (to tell a wrong password
 * apart from a right one) and the user's other keys, each wrapped with the
 * user's key. All devices signed in to the same drive share it.
 */
export type RyteAccountFile = {
  app: "ryte";
  version: 1;
  userId: string;
  salt: string;
  keyCheck: Cipher<"base64">;
  keys: UserKeys;
  createdAt: number;
};

export class RyteAccount {
  constructor(private readonly db: Database) {}

  async drive(): Promise<CloudDrive> {
    const drive = await this.db.options.cloud?.();
    if (!drive)
      throw new Error(
        "No cloud storage is connected. Connect MEGA or Filen to sync."
      );
    return drive;
  }

  async dataFolder(): Promise<DriveFolder> {
    const folder = await (
      await this.drive()
    ).openFolder(RYTE_DATA_FOLDER, true);
    if (!folder) throw new Error("Could not open the Ryte folder.");
    return folder;
  }

  /** Whether the connected drive already holds Ryte data from another device. */
  async exists(): Promise<boolean> {
    const drive = await this.drive();
    const folder = await drive.openFolder(RYTE_DATA_FOLDER, false);
    if (!folder) return false;
    return !!newestEntry(await folder.list(), RYTE_ACCOUNT_FILE);
  }

  private async readAccount(
    folder: DriveFolder
  ): Promise<RyteAccountFile | undefined> {
    const entry = newestEntry(await folder.list(), RYTE_ACCOUNT_FILE);
    if (!entry) return;
    const account = decodeJSON<RyteAccountFile>(await folder.read(entry));
    if (account.app !== "ryte" || !account.salt || !account.keyCheck)
      throw new Error(
        "The Ryte folder in your cloud storage is damaged (account.json is not valid)."
      );
    account.keys = account.keys || {};
    return account;
  }

  /**
   * Signs this device in. On the first device this creates the account in
   * the drive; on every other device the same encryption password must be
   * used, otherwise the notes could not be decrypted.
   */
  async signIn(password: string) {
    if (!password) throw new Error("Enter your encryption password.");
    const storage = this.db.storage();
    const drive = await this.drive();
    const folder = await this.dataFolder();

    let account = await this.readAccount(folder);
    if (account) {
      const key = await storage.generateCryptoKey(password, account.salt);
      const correct = await storage
        .decrypt(key, account.keyCheck)
        .then(
          (text) => text === KEY_CHECK,
          () => false
        );
      if (!correct)
        throw new Error(
          "Wrong encryption password. Use the password you chose when you first set up Ryte."
        );
    } else {
      const key = await storage.generateCryptoKey(password);
      if (!key.salt) throw new Error("Could not create an encryption key.");
      account = {
        app: "ryte",
        version: 1,
        userId: getId(),
        salt: key.salt,
        keyCheck: await storage.encrypt(key, KEY_CHECK),
        keys: {},
        createdAt: Date.now()
      };
      await replaceFile(folder, RYTE_ACCOUNT_FILE, encodeJSON(account));
    }

    // a new sign-in always starts a fresh sync history on this device
    await this.db.setLastSynced(0);
    await this.db.kv().delete("deviceId");
    await this.db.kv().delete("ryteCursors");
    await this.db.kv().delete("ryteSeq");
    await this.db.kv().delete("ryteSnapshot");
    // the drive may not have this device's notes yet (new account, another
    // account, or notes written while offline): send everything once
    await this.db.kv().write("ryteForcePush", true);

    const user = toUser(account, drive);
    await this.db.user.setUser(user);
    await storage.deriveCryptoKey({ password, salt: account.salt });
    this.db.eventManager.publish(EVENTS.userLoggedIn, user);
    return user;
  }

  /** Checks a password against the account (used by "verify password" prompts). */
  async verifyPassword(password: string) {
    const user = await this.db.user.getUser();
    if (!user) return false;
    const key = await this.db
      .storage()
      .generateCryptoKey(password, user.salt);
    const account = await this.readAccount(await this.dataFolder()).catch(
      () => undefined
    );
    if (!account) {
      // offline: compare against the key on this device
      const current = await this.db.storage().getCryptoKey();
      return !!current && current === key.key;
    }
    return await this.db
      .storage()
      .decrypt(key, account.keyCheck)
      .then(
        (text) => text === KEY_CHECK,
        () => false
      );
  }

  /**
   * Adds keys the account doesn't have yet. When another device already
   * added the same key, that one wins, so every device uses the same key.
   */
  async addKeys(keys: UserKeys): Promise<User> {
    const drive = await this.drive();
    const folder = await this.dataFolder();
    const account = await this.readAccount(folder);
    if (!account) throw new Error("Ryte account not found in cloud storage.");

    let changed = false;
    for (const [id, value] of Object.entries(keys) as [
      keyof UserKeys,
      UserKeys[keyof UserKeys]
    ][]) {
      if (!value || account.keys[id]) continue;
      (account.keys as Record<string, unknown>)[id] = value;
      changed = true;
    }
    if (changed)
      await replaceFile(folder, RYTE_ACCOUNT_FILE, encodeJSON(account));

    const user = toUser(account, drive);
    await this.db.user.setUser(user);
    return user;
  }

  /** Re-reads the account so keys added by other devices are known here. */
  async refresh(): Promise<User | undefined> {
    const current = await this.db.user.getUser();
    if (!current) return;
    const drive = await this.drive();
    const account = await this.readAccount(await this.dataFolder());
    if (!account) return current;
    if (account.salt !== current.salt) {
      // The account in the drive was recreated with another password.
      this.db.eventManager.publish(EVENTS.userSessionExpired);
      return current;
    }
    const user = toUser(account, drive);
    user.storageUsed = current.storageUsed;
    user.totalStorage = current.totalStorage;
    const quota = await drive.quota?.().catch(() => undefined);
    if (quota) {
      user.storageUsed = quota.used;
      user.totalStorage = quota.total;
    }
    await this.db.user.setUser(user);
    return user;
  }
}

function toUser(account: RyteAccountFile, drive: CloudDrive): User {
  return {
    id: account.userId,
    email: drive.accountEmail,
    cloudProvider: drive.provider,
    isEmailConfirmed: true,
    salt: account.salt,
    ...account.keys,
    mfa: {
      isEnabled: false,
      primaryMethod: "app",
      remainingValidCodes: 0
    },
    subscription: {
      appId: 0,
      cancelURL: null,
      expiry: Date.UTC(2999, 0, 1),
      productId: null,
      provider: SubscriptionProvider.STREETWRITERS,
      start: account.createdAt,
      plan: SubscriptionPlan.BELIEVER,
      status: SubscriptionStatus.ACTIVE,
      updateURL: null,
      googlePurchaseToken: null
    }
  };
}
