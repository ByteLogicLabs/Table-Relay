import { useSyncExternalStore } from 'react';
import type { RailTile, RailTileInput } from '../lib/rail';

// Rail tiles persist across launches via localStorage so the user's pinned
// databases come back on reopen. The app still shows a boot/empty screen when
// the stored list is empty so new users aren't dumped into an arbitrary tile.
interface State {
  tiles: RailTile[];
}

const STORAGE_KEY = 'dbtable:rail:v1';

function loadInitial(): State {
  if (typeof window === 'undefined') return { tiles: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tiles: [] };
    const parsed = JSON.parse(raw) as { tiles?: RailTile[] };
    if (!parsed || !Array.isArray(parsed.tiles)) return { tiles: [] };
    // Basic shape check — drop anything that doesn't have the required
    // identity fields so we don't crash later on stale/garbled entries.
    const cleaned = parsed.tiles.filter(
      t => t && typeof t.id === 'string' && typeof t.serverId === 'string' && typeof t.databaseName === 'string',
    );
    return { tiles: cleaned };
  } catch {
    return { tiles: [] };
  }
}

function persist(s: State) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tiles: s.tiles }));
  } catch {
    // Quota / private-mode: silently fall back to in-memory only.
  }
}

let state: State = loadInitial();

const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
function getSnapshot() { return state; }
function mutate(fn: (s: State) => State) { state = fn(state); persist(state); emit(); }

export function useRail() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getRailSnapshot(): RailTile[] {
  return state.tiles;
}

export async function refreshRail(): Promise<void> {
  // No-op: session-only rail, nothing to refresh from.
}

function tileId(serverId: string, databaseName: string): string {
  return `${serverId}::${databaseName}`;
}

export async function pinTile(input: RailTileInput): Promise<RailTile> {
  const id = tileId(input.serverId, input.databaseName);
  const existing = state.tiles.find(t => t.id === id);
  if (existing) return existing;
  const now = Date.now();
  const tile: RailTile = {
    id,
    serverId: input.serverId,
    databaseName: input.databaseName,
    label: input.label ?? null,
    orderIndex: state.tiles.length,
    createdAt: now,
    updatedAt: now,
  };
  mutate(s => ({ tiles: [...s.tiles, tile] }));
  return tile;
}

export async function unpinTile(id: string): Promise<void> {
  mutate(s => ({ tiles: s.tiles.filter(t => t.id !== id) }));
}

/** Bulk-unpin: drops every tile whose id is in the set. No-op on unknown ids. */
export async function unpinManyTiles(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const set = new Set(ids);
  mutate(s => ({ tiles: s.tiles.filter(t => !set.has(t.id)) }));
}

