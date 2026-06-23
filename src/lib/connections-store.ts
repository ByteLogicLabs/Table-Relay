import { invoke } from '@tauri-apps/api/core';
import type { Driver } from '../types';

export interface ConnectionProfileRecord {
  id: string;
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
  sshKeyPassphrase?: string | null;
  color?: string | null;
  isFavorite: boolean;
  tag?: string | null;
  tagColor?: string | null;
  /** JSON-encoded array of { name, color }. */
  tags?: string | null;
}

export interface ConnectionProfileInput {
  id?: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  sslMode?: string;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthKind?: 'password' | 'key';
  sshKeyPath?: string;
  sshPassword?: string;
  sshKeyPassphrase?: string;
  color?: string;
  isFavorite?: boolean;
  tag?: string;
  tagColor?: string;
  /** JSON-encoded array of { name, color }. */
  tags?: string;
}

export const connectionsStore = {
  list: () => invoke<ConnectionProfileRecord[]>('connections_list'),
  save: (profile: ConnectionProfileInput) =>
    invoke<ConnectionProfileRecord>('connections_save', { profile }),
  remove: (id: string) => invoke<void>('connections_delete', { id }),
};
