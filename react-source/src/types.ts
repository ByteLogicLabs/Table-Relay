export type Driver = 'MySQL' | 'PostgreSQL' | 'MongoDB';

export interface ConnectionProfile {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: string | number;
  user: string;
  password?: string;
  database?: string;
  sslMode?: 'Disable' | 'Require' | 'Verify-CA';
  sshEnabled?: boolean;
  color?: string;
  isFavorite?: boolean;
}

export interface TableNode {
  name: string;
  type: 'table' | 'view';
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
}

export type TabType = 'data' | 'structure' | 'query' | 'erd';

export interface AppTab {
  id: string;
  title: string;
  type: TabType;
  connectionId: string;
  table?: string; // For data and structure tabs
  query?: string; // For query tab
  schemaName?: string; // For erd tab
  isNew?: boolean; // Indicates if the structure represents a new table
}
