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

import { isImage, RequestOptions, hosts } from "@notesnook/core";
import { PermissionsAndroid, Platform } from "react-native";
import RNFetchBlob from "react-native-blob-util";
import { ToastManager } from "../../services/event-manager";
import { useAttachmentStore } from "../../stores/use-attachment-store";
import { IOS_APPGROUPID } from "../../utils/constants";
import { DatabaseLogger, db } from "../database";
import { createCacheDir } from "./io";
import {
  cacheDir,
  checkUpload,
  FileSizeResult,
  getUploadedFileSize
} from "./utils";
import { useUserStore } from "../../stores/use-user-store";
import { sleep } from "../../utils/time";
import { isFeatureAvailable } from "@notesnook/common";
import { strings } from "@notesnook/intl";
import { PIECE_SIZE, RyteFiles } from "../../ryte/bridge";

/**
 * Reads a file as base64 pieces of about PIECE_SIZE bytes; each piece
 * decodes on its own. Calls are made one after another.
 */
export function readFileInPieces(
  path: string,
  onPiece: (base64: string, bytes: number) => Promise<void>
) {
  // a multiple of 3, so pieces never split a base64 group
  const bufferSize = PIECE_SIZE - (PIECE_SIZE % 3);
  return new Promise<void>((resolve, reject) => {
    RNFetchBlob.fs
      .readStream(path, "base64", bufferSize, 0)
      .then((stream) => {
        let chain = Promise.resolve();
        let failed = false;
        stream.open();
        stream.onData((chunk) => {
          const piece = chunk as string;
          chain = chain.then(() =>
            failed
              ? undefined
              : onPiece(piece, Math.floor((piece.length * 3) / 4)).catch(
                  (e) => {
                    failed = true;
                    reject(e);
                  }
                )
          );
        });
        stream.onError(reject);
        stream.onEnd(() => {
          chain.then(() => !failed && resolve(), reject);
        });
      })
      .catch(reject);
  });
}

export async function uploadFile(
  filename: string,
  requestOptions: RequestOptions,
  cancelToken: {
    cancel: (reason?: string) => Promise<void>;
  }
) {
  if (!requestOptions) return false;
  await createCacheDir();
  DatabaseLogger.info(`Preparing to upload file: ${filename}`);

  try {
    let filePath = `${cacheDir}/${filename}`;
    let exists = await RNFetchBlob.fs.exists(filePath);
    // Check for file in appGroupPath if it doesn't exist in cacheDir
    if (!exists && Platform.OS === "ios") {
      const iosAppGroup =
        Platform.OS === "ios"
          ? await (RNFetchBlob.fs as any).pathForAppGroup(IOS_APPGROUPID)
          : null;
      const appGroupPath = `${iosAppGroup}/${filename}`;
      filePath = appGroupPath;
      exists = await RNFetchBlob.fs.exists(filePath);
    }

    if (!exists) {
      throw new Error(
        `Trying to upload file at path ${filePath} that doest not exist.`
      );
    }

    const fileInfo = await RNFetchBlob.fs.stat(filePath);

    const remoteFileSize = await getUploadedFileSize(filename);
    if (remoteFileSize === FileSizeResult.Error) return false;

    const featureResult = await isFeatureAvailable(
      "fileSize",
      fileInfo.size || 0
    );

    if (!featureResult.isAllowed) {
      ToastManager.show({
        heading: strings.fileTooLarge(),
        message: featureResult.error,
        type: "error"
      });
      return false;
    }

    if (
      remoteFileSize > FileSizeResult.Empty &&
      remoteFileSize === fileInfo.size
    ) {
      DatabaseLogger.log(`File ${filename} is already uploaded.`);
      return true;
    }

    let attachmentInfo = await db.attachments.attachment(filename);

    DatabaseLogger.info(
      `Starting upload of ${filename} at path: ${fileInfo.path} ${fileInfo.size}`
    );

    // Ryte: the encrypted file goes to the "Ryte Files" folder of the user's
    // MEGA / Filen drive, through the cloud bridge, in 1 MB pieces.
    let uploadedBytes = 0;
    cancelToken.cancel = async () => {
      useAttachmentStore.getState().remove(filename);
    };
    await RyteFiles.upload(filename, (onPiece) =>
      readFileInPieces(filePath, async (piece, bytes) => {
        await onPiece(piece);
        uploadedBytes += bytes;
        useAttachmentStore
          .getState()
          .setProgress(uploadedBytes, fileInfo.size, filename, 0, "upload");
      })
    );
    const uploaded = true;

    useAttachmentStore.getState().remove(filename);

    if (uploaded) {
      attachmentInfo = await db.attachments.attachment(filename);
      if (!attachmentInfo) return false;
      await checkUpload(
        filename,
        requestOptions.chunkSize,
        attachmentInfo.size
      );
      DatabaseLogger.info(`File upload status: ${filename}, success`);
    }

    return uploaded;
  } catch (e) {
    useAttachmentStore.getState().remove(filename);
    ToastManager.error(e as Error, "File upload failed");
    DatabaseLogger.error(e, "File upload failed", {
      filename
    });
    return false;
  }
}
