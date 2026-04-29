/**
 * In-memory cache for data-tab grid contents. Scoped to a tab id so switching
 * between open tabs is instant — we only hit the DB when the user explicitly
 * refreshes or commits changes. The cache lives for the lifetime of the app
 * window; a full reload flushes it, which matches the "persist except on
 * reload" behavior the rest of the grid follows.
 *
 * We intentionally avoid putting this in React state or localStorage:
 *   - React state would force the cache to live on WorkspaceView and thread
 *     through every data-tab render, adding coupling with no benefit.
 *   - localStorage would leak megabytes of row data and defeat the point of
 *     reducing bandwidth on reload (users typically *want* fresh data after
 *     restarting the app).
 */
import type { TableStructure } from '../lib/db';

export interface CachedGridData {
  cols: string[];
  rows: Array<Record<string, unknown> & { __rowId: string }>;
  structure: TableStructure | null;
  executionMs: number | null;
  /** Limit the cached data was fetched with — so a stale cache doesn't mask
   *  the fact that the user has since bumped the row limit. */
  limit: string;
  /** 1-based page index the cached rows are from. */
  page?: number;
  /** Total row count for the current filter set. null = not known yet (the
   *  COUNT(*) probe is still in flight or was skipped for perf). */
  totalRows?: number | null;
}

const cache = new Map<string, CachedGridData>();

export function readCachedGrid(tabId: string): CachedGridData | undefined {
  return cache.get(tabId);
}

export function writeCachedGrid(tabId: string, data: CachedGridData): void {
  cache.set(tabId, data);
}

export function clearCachedGrid(tabId: string): void {
  cache.delete(tabId);
}

/** Drop every cached grid whose tab id matches the predicate. */
export function clearCachedGridsWhere(pred: (tabId: string) => boolean): void {
  for (const id of Array.from(cache.keys())) {
    if (pred(id)) cache.delete(id);
  }
}

