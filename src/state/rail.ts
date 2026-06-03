import { useSyncExternalStore } from 'react';
import { railStore, type RailTile, type RailTileInput } from '../lib/rail';

// Rail tiles persist in the encrypted backend store. localStorage is read only
// once as a legacy migration path, then cleared.
interface State {
  tiles: RailTile[];
}

const STORAGE_KEY = 'tablerelay:rail:v1';
const OLD_STORAGE_KEY = 'dbtable:rail:v1';

function readLegacyLocalStorage(): RailTile[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(OLD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { tiles?: RailTile[] };
    if (!parsed || !Array.isArray(parsed.tiles)) return [];
    // Basic shape check — drop anything that doesn't have the required
    // identity fields so we don't crash later on stale/garbled entries.
    return parsed.tiles.filter(
      t => t && typeof t.id === 'string' && typeof t.serverId === 'string' && typeof t.databaseName === 'string',
    );
  } catch {
    return [];
  }
}

let state: State = { tiles: [] };
let hydrated = false;

const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
function getSnapshot() { return state; }
function mutate(fn: (s: State) => State) { state = fn(state); emit(); }

export function useRail() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getRailSnapshot(): RailTile[] {
  return state.tiles;
}

export async function refreshRail(): Promise<void> {
  let tiles = await railStore.list();
  if (!hydrated && tiles.length === 0) {
    const legacy = readLegacyLocalStorage();
    if (legacy.length > 0) {
      const migrated: RailTile[] = [];
      for (const tile of legacy.sort((a, b) => a.orderIndex - b.orderIndex)) {
        migrated.push(await railStore.pin({
          serverId: tile.serverId,
          databaseName: tile.databaseName,
          label: tile.label ?? undefined,
        }));
      }
      await railStore.reorder(migrated.map(t => t.id));
      try {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(OLD_STORAGE_KEY);
      } catch { /* noop */ }
      tiles = await railStore.list();
    }
  }
  hydrated = true;
  mutate(() => ({ tiles }));
}

export async function pinTile(input: RailTileInput): Promise<RailTile> {
  const existing = state.tiles.find(t => t.serverId === input.serverId && t.databaseName === input.databaseName);
  if (existing) return existing;
  const tile = await railStore.pin(input);
  mutate(s => ({ tiles: [...s.tiles, tile] }));
  return tile;
}

export async function unpinTile(id: string): Promise<void> {
  await railStore.unpin(id);
  mutate(s => ({ tiles: s.tiles.filter(t => t.id !== id) }));
}

/** Bulk-unpin: drops every tile whose id is in the set. No-op on unknown ids. */
export async function unpinManyTiles(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const set = new Set(ids);
  for (const id of ids) await railStore.unpin(id);
  mutate(s => ({ tiles: s.tiles.filter(t => !set.has(t.id)) }));
}

/** Reorder tiles by providing a new ordered array of tile ids. */
export function reorderTiles(orderedIds: string[]): void {
  mutate(s => {
    const byId = new Map(s.tiles.map(t => [t.id, t]));
    const now = Date.now();
    const reordered = orderedIds
      .map((id, i) => {
        const t = byId.get(id);
        return t ? { ...t, orderIndex: i, updatedAt: now } : null;
      })
      .filter((t): t is RailTile => t !== null);
    void railStore.reorder(reordered.map(t => t.id));
    return { tiles: reordered };
  });
}
