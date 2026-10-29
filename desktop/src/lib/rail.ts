import { invoke } from '@tauri-apps/api/core';

export interface RailTile {
  id: string;
  serverId: string;
  databaseName: string;
  label: string | null;
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface RailTileInput {
  serverId: string;
  databaseName: string;
  label?: string;
}

export const railStore = {
  list: () => invoke<RailTile[]>('rail_list'),
  pin: (input: RailTileInput) => invoke<RailTile>('rail_pin', { input }),
  unpin: (id: string) => invoke<void>('rail_unpin', { id }),
  rename: (id: string, label: string | null) =>
    invoke<RailTile>('rail_rename', { id, label }),
  reorder: (orderedIds: string[]) => invoke<void>('rail_reorder', { orderedIds }),
};
