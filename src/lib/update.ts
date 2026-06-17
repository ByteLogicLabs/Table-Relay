import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { flog } from './flog';

const CURRENT_VERSION = process.env.APP_VERSION || '0.0.0';

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

function parts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

let pendingUpdate: Update | null = null;

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      return {
        current: update.currentVersion || CURRENT_VERSION,
        latest: update.version,
        hasUpdate: true,
      };
    }
    pendingUpdate = null;
    return { current: CURRENT_VERSION, latest: CURRENT_VERSION, hasUpdate: false };
  } catch (e) {
    flog('update', 'updater check failed, falling back to release check:', String(e));
    return checkViaReleases();
  }
}

async function checkViaReleases(): Promise<UpdateInfo | null> {
  try {
    const latest = await invoke<{ version: string } | null>('check_latest_version');
    const current = CURRENT_VERSION;
    if (!latest?.version) {
      flog('update', 'release check returned no version');
      return null;
    }
    return { current, latest: latest.version, hasUpdate: isNewer(latest.version, current) };
  } catch (e) {
    flog('update', 'release check failed:', String(e));
    return null;
  }
}

export interface InstallProgress {
  downloaded: number;
  total: number | null;
}

export function canAutoInstall(): boolean {
  return pendingUpdate !== null;
}

export async function downloadAndInstallUpdate(
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  if (!pendingUpdate) throw new Error('No update available to install');
  let downloaded = 0;
  let total: number | null = null;
  await pendingUpdate.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null;
        onProgress?.({ downloaded: 0, total });
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress?.({ downloaded, total });
        break;
      case 'Finished':
        onProgress?.({ downloaded, total });
        break;
    }
  });
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}
