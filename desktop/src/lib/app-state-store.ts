import { invoke } from '@tauri-apps/api/core';

interface AppStateEntry {
  key: string;
  valueJson: string;
  updatedAt: string;
}

export async function getAppState<T>(key: string): Promise<T | null> {
  const entry = await invoke<AppStateEntry | null>('app_state_get', { key });
  if (!entry) return null;
  return JSON.parse(entry.valueJson) as T;
}

export async function setAppState<T>(key: string, value: T): Promise<void> {
  await invoke<AppStateEntry>('app_state_set', {
    key,
    valueJson: JSON.stringify(value),
  });
}

export async function deleteAppState(key: string): Promise<void> {
  await invoke<void>('app_state_delete', { key });
}
