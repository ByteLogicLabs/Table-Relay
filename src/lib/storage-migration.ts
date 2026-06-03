/**
 * One-time migration of persisted state from the old `dbtable:` key prefix to
 * the current `tablerelay:` prefix (the app was renamed db-table → Table Relay).
 *
 * Runs before any store reads so saved tabs, settings, rail tiles and AI
 * credentials survive the rename instead of resetting to defaults. It only
 * copies keys that don't already exist under the new prefix (so it's safe to
 * call repeatedly and never clobbers fresher data), then drops a sentinel so it
 * short-circuits on subsequent launches.
 */

const SENTINEL = 'tablerelay:migrated:v1';
const OLD_PREFIX = 'dbtable:';
const NEW_PREFIX = 'tablerelay:';

export function migrateLegacyStorage(): void {
  let ls: Storage;
  try {
    ls = window.localStorage;
  } catch {
    return; // storage unavailable (private mode / sandbox) — nothing to do
  }

  try {
    if (ls.getItem(SENTINEL)) return;

    // Snapshot the old keys first — mutating localStorage while iterating its
    // indices is fragile.
    const legacyKeys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(OLD_PREFIX)) legacyKeys.push(k);
    }

    for (const oldKey of legacyKeys) {
      const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
      // Don't overwrite anything already written under the new prefix.
      if (ls.getItem(newKey) !== null) continue;
      const val = ls.getItem(oldKey);
      if (val !== null) ls.setItem(newKey, val);
    }

    ls.setItem(SENTINEL, '1');
  } catch {
    // A storage error mid-migration shouldn't crash boot; the app falls back
    // to defaults, which is the pre-rename behavior anyway.
  }
}
