export type Driver = 'MySQL' | 'SQLite' | 'Redis' | 'PostgreSQL' | 'MongoDB';

export type SshAuthKind = 'password' | 'key';

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
  sshHost?: string;
  sshPort?: string | number;
  sshUser?: string;
  sshAuthKind?: SshAuthKind;
  sshKeyPath?: string;
  sshPassword?: string;
  sshKeyPassphrase?: string;
  color?: string;
  isFavorite?: boolean;
  tag?: string;
  tagColor?: string;
}

export type TabType = 'data' | 'structure' | 'query' | 'erd' | 'routine' | 'trigger' | 'realtime';

export type DataViewMode = 'table' | 'json' | 'diagram' | 'schema';

export interface QueryLogEntry {
  id: string;
  timestamp: number;
  connectionId: string;
  statement: string;
  source: 'editor' | 'grid' | 'system';
  durationMs?: number;
  status: 'ok' | 'error';
  message?: string;
}

export interface AppTab {
  id: string;
  title: string;
  type: TabType;
  connectionId: string;
  /** Target schema for data/structure/erd tabs. */
  schema?: string;
  /** Connection-scoped database the tab belongs to (Postgres only, where one
   *  pool targets one database and many databases share a `public` schema).
   *  Disambiguates otherwise-identical `(connection, schema, table)` tabs across
   *  databases so a `public.users` tab in DB-A isn't confused with DB-B's.
   *  Undefined for MySQL/Mongo/SQLite where schema already identifies the DB. */
  database?: string;
  table?: string; // For data and structure tabs
  query?: string; // For query tab
  schemaName?: string; // For erd tab (legacy alias for schema)
  isNew?: boolean; // Indicates if the structure represents a new table
  /** True when the tab's editor has unsaved edits. Editors report this up via
   *  `onTabDirtyChange` so the tab strip can show a VSCode-style unsaved dot. */
  dirty?: boolean;
  dataViewMode?: DataViewMode; // Persisted per-tab for `data` tabs
  /** Routine tabs carry their identity so we can dedupe + refetch. `view` is
   *  routed through the same RoutineView shell since both are "CREATE … AS …"
   *  single-buffer objects. */
  routine?: { schema: string; name: string; kind: 'function' | 'procedure' | 'view' };
  /** Trigger tabs carry their identity so we can dedupe + refetch.
   *  `initialSql` optionally prefills the editor buffer (used by the AI's
   *  `open_object_tab` tool when it supplies a CREATE TRIGGER statement).
   *  `draft` persists the in-progress editor buffer across tab switches so
   *  unsaved edits survive the unmount that happens when another tab is
   *  focused. */
  trigger?: {
    schema: string;
    name: string;
    isNew?: boolean;
    initialSql?: string;
    draft?: string;
  };
  /** Marks query tabs opened by the AI via `write_query_tab`. Subsequent
   *  AI writes with mode='replace' against a non-query focus (e.g. the user
   *  is staring at a function/view tab) reuse the most-recent AI-owned tab
   *  on the same connection instead of stacking new ones. */
  aiOwned?: boolean;
  /** Realtime tab: persists the last-used pattern so reopening the tab
   *  pre-fills the input. Subscription state itself is in-memory only — a
   *  stream doesn't survive a reload. */
  realtimePattern?: string;
}
