import { invoke } from '@tauri-apps/api/core';
import { flog } from './flog';

/** Running app version, injected from package.json at build time (see
 *  vite.config). package.json is the single source we bump per release. */
const CURRENT_VERSION = process.env.APP_VERSION || '0.0.0';

/** Result of an update check. `hasUpdate` is true only when a strictly-newer
 *  version is published. All fields absent on failure (offline, etc.). */
export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

/** Parse a semver-ish string ("0.2.3", "v1.0.0-beta") into comparable numeric
 *  parts. Non-numeric/pre-release suffixes are ignored for the comparison —
 *  good enough to decide "is the published version newer". */
function parts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

/** True when `latest` is strictly greater than `current` (major.minor.patch). */
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

/**
 * Check GitHub for a newer published version. Never throws — returns `null` on
 * any failure so the caller can simply skip the notice. The fetch happens in
 * Rust (CORS-free); we only compare here.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const latest = await invoke<{ version: string } | null>('check_latest_version');
    const current = CURRENT_VERSION;
    if (!latest?.version) {
      flog('update', 'update check returned no version');
      return null;
    }
    const hasUpdate = isNewer(latest.version, current);
    return { current, latest: latest.version, hasUpdate };
  } catch (e) {
    flog('update', 'update check failed:', String(e));
    return null;
  }
}
