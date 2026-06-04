import { invoke } from '@tauri-apps/api/core';
import type { Driver } from '../types';

/** One importable connection decoded from a TablePlus export. */
export interface TablePlusCandidate {
  name: string;
  driver: Driver;
  host: string;
  port: number;
  user?: string | null;
  password?: string | null;
  database?: string | null;
  sslMode?: string | null;
  sshEnabled: boolean;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuthKind?: 'password' | 'key' | null;
  sshKeyPath?: string | null;
  sshPassword?: string | null;
  color?: string | null;
  environment?: string | null;
}

export interface TablePlusSkipped {
  name: string;
  driver: string;
  reason: string;
}

export interface TablePlusImportResult {
  candidates: TablePlusCandidate[];
  skipped: TablePlusSkipped[];
}

/**
 * Decrypt + parse a `.tableplusconnection` export (RNCryptor v3, AES-256-CBC).
 * Throws a structured error `{ kind, message }` — `kind: "BadPassword"` when the
 * password is wrong, `"BadFormat"` for a non-TablePlus file.
 */
export function tableplusImport(path: string, password: string) {
  return invoke<TablePlusImportResult>('tableplus_import', { path, password });
}
