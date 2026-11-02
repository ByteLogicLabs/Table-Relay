/**
 * Module-level mirror of recent query-log entries, keyed by connection id.
 *
 * The workspace owns the query log in React state (for the bottom panel), but
 * the AI chat lives in a different part of the tree and needs read access to
 * recent activity — especially failures — so it can diagnose and retry. Rather
 * than prop-drill, the workspace mirrors each entry here and the chat reads the
 * tail synchronously when assembling a turn.
 */
import type { QueryLogEntry } from '../types';

const MAX_PER_CONN = 50;
const byConnection = new Map<string, QueryLogEntry[]>();

/** Record one entry (called from the workspace's appendQueryLog). */
export function recordQueryLog(entry: QueryLogEntry): void {
  const list = byConnection.get(entry.connectionId) ?? [];
  list.push(entry);
  if (list.length > MAX_PER_CONN) list.splice(0, list.length - MAX_PER_CONN);
  byConnection.set(entry.connectionId, list);
}

/** Clear a connection's mirrored log (called when the panel is cleared). */
export function clearQueryLogStore(connectionId: string): void {
  byConnection.delete(connectionId);
}

/** Most recent entries for a connection, oldest→newest, capped at `limit`. */
export function recentQueryLog(connectionId: string, limit = 10): QueryLogEntry[] {
  const list = byConnection.get(connectionId) ?? [];
  return list.slice(-limit);
}
