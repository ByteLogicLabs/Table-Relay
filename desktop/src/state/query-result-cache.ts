import type { StatementResult } from '../lib/db';

export interface QueryResultSnapshot {
  statements: StatementResult[];
  runError: string | null;
  activeResultIndex: number;
  resultViewMode: 'table' | 'json';
  resultsHeight: number;
}

const cache = new Map<string, QueryResultSnapshot>();

export function readQueryResultSnapshot(tabId: string): QueryResultSnapshot | null {
  return cache.get(tabId) ?? null;
}

export function writeQueryResultSnapshot(tabId: string, snapshot: QueryResultSnapshot) {
  cache.set(tabId, snapshot);
}

export function clearQueryResultSnapshot(tabId: string) {
  cache.delete(tabId);
}

