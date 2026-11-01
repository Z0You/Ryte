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

import hosts from "../utils/constants.js";

export type IssueReportResponse =
  | { error: string }
  | { url: string; type: "issue" | "discussion" }
  | { type: "email" };
export class Debug {
  static async report(reportData: {
    title: string;
    body: string;
    userId?: string;
  }): Promise<IssueReportResponse | undefined> {
    // Ryte: never send reports to Notesnook's issue server; open a
    // pre-filled issue on Ryte's GitHub repository instead.
    const { title, body } = reportData;
    void hosts;
    const url = `https://github.com/Z0You/Ryte/issues/new?title=${encodeURIComponent(
      title
    )}&body=${encodeURIComponent(body.slice(0, 6000))}`;
    return { url, type: "issue" };
  }
}
