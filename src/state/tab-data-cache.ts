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
  // --- Unsaved work ---------------------------------------------------------
  // Persisted so an in-progress add/edit survives leaving the tab (switching
  // connections unmounts the grid, which would otherwise drop the component's
  // useState). Restored on the next mount so the user's draft is exactly where
  // they left it.
  /** Draft rows queued for INSERT (each carries its synthetic `new:` __rowId). */
  pendingInserts?: Array<Record<string, unknown> & { __rowId: string }>;
  /** Pending per-cell edits, keyed the same way the grid keys them in memory. */
  editedCells?: Record<string, unknown>;
  /** Row ids queued for deletion (a Set serialized as an array). */
  pendingDeletes?: string[];
}

const cache = new Map<string, CachedGridData>();

export function readCachedGrid(tabId: string): CachedGridData | undefined {
  return cache.get(tabId);
}

export function writeCachedGrid(tabId: string, data: CachedGridData): void {
  // Preserve any unsaved work already stashed for this tab. The fetched-rows
  // writer (ingestBrowseResult) doesn't know about drafts, so without this a
  // background refresh would clobber the user's pending insert/edit/delete.
  const prev = cache.get(tabId);
  cache.set(tabId, {
    ...data,
    pendingInserts: data.pendingInserts ?? prev?.pendingInserts,
    editedCells: data.editedCells ?? prev?.editedCells,
    pendingDeletes: data.pendingDeletes ?? prev?.pendingDeletes,
  });
}

/**
 * Merge unsaved-work fields into a tab's cache entry without disturbing the
 * cached rows/structure. Creates a minimal skeleton entry if the tab has no
 * cached rows yet (e.g. the user started a draft before the first fetch
 * landed). Pass an empty insert list / edits / deletes to clear them.
 */
export function patchCachedGridDraft(
  tabId: string,
  draft: Pick<CachedGridData, 'pendingInserts' | 'editedCells' | 'pendingDeletes'>,
): void {
  const prev = cache.get(tabId);
  if (prev) {
    cache.set(tabId, { ...prev, ...draft });
    return;
  }
  cache.set(tabId, {
    cols: [],
    rows: [],
    structure: null,
    executionMs: null,
    limit: '',
    ...draft,
  });
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

