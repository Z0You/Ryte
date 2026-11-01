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

import { RequestOptions } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import NetInfo from "@react-native-community/netinfo";
import RNFetchBlob from "react-native-blob-util";
import { ToastManager } from "../../services/event-manager";
import { useAttachmentStore } from "../../stores/use-attachment-store";
import { DatabaseLogger, db } from "../database";
import { createCacheDir, exists } from "./io";
import { ABYTES, cacheDir, getUploadedFileSize } from "./utils";
import { RyteFiles } from "../../ryte/bridge";

export async function downloadFile(
  filename: string,
  requestOptions: RequestOptions,
  cancelToken: {
    cancel: (reason?: string) => Promise<void>;
  }
) {
  if (!requestOptions) {
    DatabaseLogger.log(
      `Error downloading file: ${filename}, reason: No requestOptions`
    );
    return false;
  }

  DatabaseLogger.log(`Downloading ${filename}`);
  await createCacheDir();

  const { url, chunkSize } = requestOptions;
  const tempFilePath = `${cacheDir}/${filename}_temp`;
  const originalFilePath = `${cacheDir}/${filename}`;

  try {
    if (await exists(filename)) {
      DatabaseLogger.log(`File Exists already: ${filename}`);
      return true;
    }

    const attachment = await db.attachments.attachment(filename);
    if (!attachment) return false;

    const size = await getUploadedFileSize(filename);

    if (size === -1) {
      const error = `${strings.fileVerificationFailed()} (File hash: ${filename})`;
      throw new Error(error);
    }

    if (size === 0) {
      const error = `${strings.fileLengthError()} (File hash: ${filename})`;
      await db.attachments.markAsFailed(attachment.id, error);
      throw new Error(error);
    }

    const totalChunks = Math.ceil(size / (chunkSize + ABYTES));
    const decryptedLength = size - totalChunks * ABYTES;

    if (attachment && attachment.size !== decryptedLength) {
      const error = `${strings.fileLengthMismatch(
        attachment.size,
        decryptedLength
      )} (File hash: ${filename})`;
      await db.attachments.markAsFailed(attachment.id, error);
      throw new Error(error);
    }

    // Ryte: download from the "Ryte Files" folder of the user's drive,
    // through the cloud bridge, in 1 MB pieces appended to the temp file
    DatabaseLogger.log(`Download starting: ${filename}`);
    let canceled = false;
    cancelToken.cancel = async (reason) => {
      canceled = true;
      useAttachmentStore.getState().remove(filename);
      DatabaseLogger.log(`Download cancelled: ${reason} ${filename}`);
    };
    await RNFetchBlob.fs.writeFile(tempFilePath, "", "utf8");
    const downloaded = await RyteFiles.download(
      filename,
      async (piece) => {
        if (canceled) throw new Error("canceled");
        await RNFetchBlob.fs.appendFile(tempFilePath, piece, "base64");
      },
      (loaded, total) =>
        useAttachmentStore
          .getState()
          .setProgress(0, total, filename, loaded, "download")
    );
    if (downloaded === undefined)
      throw new Error(
        `This attachment was not found in your cloud storage. (File hash: ${filename})`
      );

    useAttachmentStore.getState().remove(filename);

    if (await exists(originalFilePath)) {
      await RNFetchBlob.fs.unlink(originalFilePath).catch(() => {
        /* empty */
      });
    }

    await RNFetchBlob.fs.mv(tempFilePath, originalFilePath).catch(() => {
      /* empty */
    });

    if (!(await exists(filename))) {
      throw new Error("File size mismatch");
    }

    return true;
  } catch (e) {
    if (
      (e as Error).message !== "canceled" &&
      !(e as Error).message.includes("NoSuchKey")
    ) {
      const toast = {
        heading: strings.downloadError((e as Error).message),
        message: (e as Error).message,
        type: "error" as const,
        context: "global"
      };
      ToastManager.show(toast);
      toast.context = "local";
      ToastManager.show(toast);
    }

    useAttachmentStore.getState().remove(filename);
    RNFetchBlob.fs.unlink(tempFilePath).catch(() => {
      /* empty */
    });
    RNFetchBlob.fs.unlink(originalFilePath).catch(() => {
      /* empty */
    });
    DatabaseLogger.error(e, "Download failed: ", {
      url
    });
    return false;
  }
}

export async function checkAttachment(hash: string) {
  const internetState = await NetInfo.fetch();
  const isInternetReachable =
    internetState.isConnected && internetState.isInternetReachable;
  if (!isInternetReachable) return;
  const attachment = await db.attachments.attachment(hash);
  if (!attachment) return { failed: "Attachment not found." };

  try {
    const size = await getUploadedFileSize(hash);

    if (size === -1) return { success: true };

    if (size === 0)
      return {
        failed: `File length is 0. Please upload this file again from the attachment manager. (File hash: ${hash})`
      };
  } catch (e) {
    return { failed: (e as Error)?.message };
  }
  return { success: true };
}
