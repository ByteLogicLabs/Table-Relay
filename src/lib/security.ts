import { invoke } from '@tauri-apps/api/core';

export type SecurityState = 'uninitialized' | 'needsMigration' | 'locked' | 'unlocked';

export interface SecurityStatus {
  state: SecurityState;
  encryptedStoreExists: boolean;
  plaintextStoreExists: boolean;
  plaintextBackupExists: boolean;
}

export const security = {
  status: () => invoke<SecurityStatus>('security_status'),
  initialize: (password: string) =>
    invoke<SecurityStatus>('security_initialize', { password }),
  unlock: (password: string) =>
    invoke<SecurityStatus>('security_unlock', { password }),
  lock: () => invoke<SecurityStatus>('security_lock'),
  removeBackup: () => invoke<SecurityStatus>('security_remove_backup'),
};

/**
 * Backend errors come across as `{ kind, message }` (see StoreError's serde
 * impl), so `String(err)` yields "[object Object]". Pull out the readable
 * message, falling back to a plain string for anything else.
 */
export function securityErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  if (typeof err === 'string') return err;
  return String(err);
}
