import { invoke } from '@tauri-apps/api/core';
import { loadSettings } from './settings-store';
import { clearAllCachedGrids } from '../state/tab-data-cache';
import { clearAllQueryResultSnapshots } from '../state/query-result-cache';

interface AppStateEntry {
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface PurgeCacheResult {
  success: boolean;
  storeSizeBytes: number;
}

export async function getAppState<T>(key: string): Promise<T | null> {
  const entry = await invoke<AppStateEntry | null>('app_state_get', { key });
  if (!entry) return null;
  return JSON.parse(entry.valueJson) as T;
}

export async function setAppState<T>(key: string, value: T, customMaxBytes?: number): Promise<void> {
  const valueJson = JSON.stringify(value);
  const thresholdMb = loadSettings().cacheMaxThresholdMb ?? 2;
  const maxBytes = customMaxBytes ?? (thresholdMb * 1024 * 1024);

  // If payload exceeds the configured cache threshold, keep it in local state only
  if (valueJson.length > maxBytes) {
    console.warn(`[app-state] Skipping persistence for '${key}': ${valueJson.length} bytes exceeds ${maxBytes} bytes threshold`);
    return;
  }

  await invoke<AppStateEntry>('app_state_set', {
    key,
    valueJson,
  });
}

export async function deleteAppState(key: string): Promise<void> {
  await invoke<void>('app_state_delete', { key });
}

export async function getStoreSizeBytes(): Promise<number> {
  return await invoke<number>('app_state_store_size').catch(() => 0);
}

export async function purgeCache(): Promise<PurgeCacheResult> {
  // Clear in-memory caches
  clearAllCachedGrids();
  clearAllQueryResultSnapshots();

  // Clear persisted tab caches and compact the SQLite database
  return await invoke<PurgeCacheResult>('app_state_purge_cache');
}

