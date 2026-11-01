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

import { KVStorageAccessor } from "../../interfaces.js";
import { getId } from "../../utils/id.js";
import TokenManager from "../token-manager.js";

export class SyncDevices {
  constructor(
    private readonly kv: KVStorageAccessor,
    private readonly tokenManager: TokenManager
  ) {}

  // Ryte: devices only need an id of their own, used to name their sync
  // logs in the cloud folder. Nothing is registered anywhere.
  async register() {
    const deviceId = getId();
    await this.kv().write("deviceId", deviceId);
  }

  async unregister() {
    await this.kv().delete("deviceId");
  }

  get() {
    return this.kv().read("deviceId");
  }
}
