import { invoke } from '@tauri-apps/api/core';

export type SecurityState = 'unlocked';

export interface SecurityStatus {
  state: SecurityState;
}

export const security = {
  status: () => invoke<SecurityStatus>('security_status'),
  removeBackup: () => invoke<SecurityStatus>('security_remove_backup'),
};
