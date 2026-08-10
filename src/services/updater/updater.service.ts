import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  date: string | null;
  body: string | null;
};

export type UpdateProgress = {
  downloadedBytes: number;
  contentLength: number | null;
  percent: number | null;
};

export type UpdateCheckResult =
  | {
      available: false;
      currentVersion: string;
    }
  | {
      available: true;
      update: UpdateInfo;
    };

let pendingUpdate: Update | null = null;

function normalizeUpdate(update: Update): UpdateInfo {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date ?? null,
    body: update.body ?? null,
  };
}

function isUpdaterEnabled() {
  return isTauri() && import.meta.env.PROD;
}

export async function getInstalledVersion() {
  if (!isTauri()) {
    return "desenvolvimento";
  }

  return getVersion();
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = await getInstalledVersion();

  if (!isUpdaterEnabled()) {
    return { available: false, currentVersion };
  }

  pendingUpdate?.close().catch(() => undefined);
  pendingUpdate = await check();

  if (!pendingUpdate) {
    return { available: false, currentVersion };
  }

  return {
    available: true,
    update: normalizeUpdate(pendingUpdate),
  };
}

export async function downloadAndInstallUpdate(onProgress: (progress: UpdateProgress) => void) {
  if (!pendingUpdate) {
    throw new Error("Nenhuma atualizacao pendente.");
  }

  let downloadedBytes = 0;
  let contentLength: number | null = null;

  await pendingUpdate.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      contentLength = event.data.contentLength ?? null;
    }

    if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
    }

    const percent =
      contentLength && contentLength > 0
        ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
        : null;

    onProgress({
      downloadedBytes,
      contentLength,
      percent,
    });
  });
}

export async function installUpdate() {
  await relaunch();
}

