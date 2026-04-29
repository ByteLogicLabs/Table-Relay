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
