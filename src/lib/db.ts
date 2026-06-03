import { invoke, Channel } from '@tauri-apps/api/core';

export type TableKind = 'table' | 'view' | 'collection';

export interface ServerInfo {
  /** Stable adapter id (e.g. `"mysql"`). The human-facing label for
   *  this server should come from `flavor` or the adapter's manifest. */
  adapterId: string;
  /** Raw version string from the server, e.g. `8.0.35`, `5.7.44-log`, `10.6.12-MariaDB`. */
  version: string;
  versionMajor?: number | null;
  versionMinor?: number | null;
  /** `MySQL` | `MariaDB` | `Percona` — detected from the version suffix. */
  flavor?: string | null;
  defaultSchema: string | null;
}

export interface ConnectionMeta {
  id: string;
  server: ServerInfo;
}

export interface TableInfo {
  name: string;
  kind: TableKind;
  rowCount: number | null;
}

export interface SchemaInfo {
  name: string;
  tables: TableInfo[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  length: number | null;
  isPrimary: boolean;
  isUnique: boolean;
  isForeign: boolean;
  isIndexed: boolean;
  /** Raw MySQL `EXTRA` — `auto_increment`, `on update CURRENT_TIMESTAMP`, etc. */
  extra?: string;
  /** `information_schema.columns.CHARACTER_SET_NAME`. */
  characterSet?: string | null;
  /** `information_schema.columns.COLLATION_NAME`. */
  collation?: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKey {
  name: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
}

export interface TableStructure {
  schema: string;
  name: string;
  kind: TableKind;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  rowCount: number | null;
}

export interface ColumnMeta {
  name: string;
  typeHint: string;
}

export interface StatementResult {
  sql: string;
  durationMs: number;
  columns: ColumnMeta[];
  rows: unknown[][];
  rowsAffected: number | null;
  error: string | null;
}

export interface QueryResult {
  statements: StatementResult[];
}

export interface UpdateRowsRequest {
  schema: string;
  table: string;
  primaryKey: Array<{ column: string; value: unknown }>;
  changes: Record<string, unknown>;
}

export interface UpdateRowsResult {
  rowsAffected: number;
}

export interface InsertRowsRequest {
  schema: string;
  table: string;
  values: Record<string, unknown>;
}

export interface InsertRowsResult {
  rowsAffected: number;
  generatedPrimaryKey?: Record<string, unknown> | null;
}

export interface DeleteRowsRequest {
  schema: string;
  table: string;
  primaryKey: Array<{ column: string; value: unknown }>;
}

export interface DeleteRowsResult {
  rowsAffected: number;
}

/** Single index spec passed to `db.modifyIndexes`. Empty `name` lets the
 *  adapter synthesize one; `unique: true` is the only option exposed in
 *  the v1 surface (sparse / partial / TTL deferred). */
/** Per-field key value. Compass models a Mongo index as a list of fields
 *  each with its own type. SQL adapters honor only `asc`/`desc`. */
export type IndexKeyValue = 'asc' | 'desc' | 'text' | '2dsphere' | '2d' | 'hashed' | 'wildcard';

export interface IndexSpecPayload {
  name?: string;
  columns: Array<{ name: string; direction?: IndexKeyValue }>;
  unique?: boolean;
}

export interface ModifyIndexesRequest {
  schema: string;
  table: string;
  /** Names of existing indexes to drop. Adapters silently skip server-managed
   *  indexes (e.g. Mongo's `_id_`). */
  drop?: string[];
  create?: IndexSpecPayload[];
}

export interface SubscribeRequest {
  /** Optional adapter-specific schema scope (e.g. Redis DB `"db3"`). */
  schema?: string;
  /** Adapter-native pattern: Redis glob, Postgres channel, etc. */
  pattern: string;
}

export interface SubscribeEvent {
  channel: string;
  pattern?: string | null;
  payload: unknown;
  receivedAtMs: number;
  extras: Record<string, unknown>;
}

// ---- Process list / kill ----

export type ProcessKind = 'connection' | 'query' | 'sleep' | { other: string };

export interface ProcessInfo {
  id: string;
  user?: string | null;
  host?: string | null;
  database?: string | null;
  command?: string | null;
  time?: number | null;
  state?: string | null;
  info?: string | null;
  kind: ProcessKind;
}

export interface KillResult {
  id: string;
  success: boolean;
  error?: string | null;
}

// ---- Command warnings ----

export type WarningKind =
  | 'destructiveNoWhere'
  | 'dropObject'
  | 'truncateTable'
  | 'bulkUpdate'
  | { custom: string };

export interface CommandWarning {
  kind: WarningKind;
  message: string;
  statement: string;
}

export interface SubscribeResponse {
  subscriptionId: string;
}

export interface ViewInfo {
  name: string;
  isUpdatable: boolean;
}

export interface RoutineParam {
  name: string;
  dataType: string;
  mode: string | null;
}

export interface RoutineInfo {
  name: string;
  kind: 'procedure' | 'function' | string;
  returns: string | null;
  parameters: RoutineParam[];
}

export interface RoutineDefinition {
  schema: string;
  name: string;
  kind: 'procedure' | 'function' | string;
  returns: string | null;
  parameters: RoutineParam[];
  body: string;
  isDeterministic: boolean;
  dataAccess: string;
  securityType: string;
  definer: string;
  createSql: string;
}

// ---------- Adapter manifest + intent types (P4) ----------

export interface AdapterInfo {
  key: string;
  displayName: string;
  version: string;
  description: string;
  tags: string[];
}

export interface Provenance {
  vendor: string;
  homepage: string | null;
  license: string | null;
}

/** How an adapter delivers server-pushed events. The realtime view's labels,
 *  default patterns, and verbs derive from this — not from a driver name. */
export type RealtimeKind = 'none' | 'listenNotify' | 'pubsub' | 'changeStream';

/** SQL dialect for code that emits SQL text on the frontend. `none` is the
 *  signal that the SQL editor / DDL builders shouldn't run at all. */
export type SqlDialect = 'none' | 'generic' | 'mysql' | 'postgres' | 'sqlite';

export type BooleanLiteralFormat = 'oneZero' | 'trueFalse';

export interface Capabilities {
  // schema introspection
  schemas: boolean;
  describeSchema: boolean;
  foreignKeys: boolean;
  views: boolean;
  routines: boolean;
  indexes: boolean;
  rowCounts: boolean;
  // data browsing
  browse: boolean;
  serverFilter: boolean;
  serverSort: boolean;
  streaming: boolean;
  keysetPagination: boolean;
  // data mutation
  updateRows: boolean;
  insertRows: boolean;
  deleteRows: boolean;
  transactions: boolean;
  // ddl
  createDatabase: boolean;
  createTable: boolean;
  alterTable: boolean;
  dropTable: boolean;
  /** Adapter exposes structured create/drop index management. The schema
   *  editor uses this path (instead of CREATE/DROP INDEX SQL) for adapters
   *  that don't speak DDL — Mongo. SQL adapters keep the SQL path. */
  manageIndexes: boolean;
  // app features
  diagram: boolean;
  erdInference: boolean;
  queryEditor: boolean;
  explainPlan: boolean;
  sshTunnel: boolean;
  /** Adapter supports process_list / kill_process — the UI shows a
   *  "Processes" panel when set. */
  processList: boolean;
  // file I/O — lists of file-format tokens the adapter can ingest / emit.
  // Empty list = the operation is unsupported by this adapter.
  // Tokens are adapter-neutral ("sql", "csv", "json", "ndjson", "ddl", …)
  // and line up with the file-picker's extension filter.
  import: string[];
  export: string[];
  // True for adapters that support server-pushed events (Redis pub/sub,
  // Postgres LISTEN/NOTIFY, Mongo change streams, …). Gates the
  // "Realtime" tab entry point.
  realtime: boolean;
  // ---- behavior-shaping flags (replace frontend `connection.driver` checks) ----
  realtimeKind: RealtimeKind;
  globSubscriptions: boolean;
  sqlDialect: SqlDialect;
  booleanLiteralFormat: BooleanLiteralFormat;
  databasePicker: boolean;
  /** Column name to hide in the data grid (e.g. Mongo's `_id`). Empty
   *  string means "don't hide anything". */
  hideColumnInGrid: string;
}

export interface Permissions {
  networkOutbound: boolean;
  sshTunnel: boolean;
  readSshKeys: boolean;
  storeKnownHosts: boolean;
  readCredentials: boolean;
}

export interface QueryEditorInfo {
  label: string;
  placeholder: string;
  commentTags: string[];
  resultViewModes: string[];
  examples: string[];
  dataFakerTemplate: string;
  language: string;
  statementSeparator: string | null;
}

export type FieldKind =
  | { type: 'string' }
  | { type: 'secret' }
  | { type: 'int'; min?: number; max?: number }
  | { type: 'enum'; options: Array<{ value: string; label: string }> }
  | { type: 'bool' }
  | {
      type: 'file';
      /** Allowed file extensions, no leading dot. Empty = any file. */
      extensions?: string[];
      /** When true, the picker offers "Save As…" so the user can target a new path. */
      allowCreate?: boolean;
    };

export interface ConnectionField {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  default: string | null;
  help: string | null;
}

export interface AdapterManifest {
  adapter: AdapterInfo;
  provenance: Provenance;
  capabilities: Capabilities;
  permissions: Permissions;
  queryEditor: QueryEditorInfo;
  connectionFields: ConnectionField[];
  /** Column types offered in the "add column" picker. Empty = the
   *  frontend should fall back to a free-text input. */
  columnTypes?: string[];
}

/** 1-based page index + page size. Matches `adapter_api::Page`. */
export interface Page {
  number: number;
  size: number;
}

export type BrowseFilterOp =
  | 'eq' | 'not_eq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'is_null' | 'is_not_null' | 'in' | 'not_in';

export interface BrowseFilter {
  column: string;
  op: BrowseFilterOp;
  /** `null`/omit for unary ops (`is_null`, `is_not_null`). */
  value?: unknown;
}

export interface BrowseSort {
  column: string;
  direction?: 'asc' | 'desc';
}

export interface BrowseRequest {
  schema: string;
  table: string;
  filters?: BrowseFilter[];
  sort?: BrowseSort[];
  page: Page;
  /** Ask the adapter to return a total record count alongside the rows. */
  includeTotal?: boolean;
}

export interface BrowseResult {
  columns: ColumnMeta[];
  rows: unknown[][];
  durationMs: number;
  /** Echoes the 1-based page the rows are from; lets the UI ignore stale responses. */
  page: number;
  /** `null` when the adapter chose not to count (e.g. huge tables) or when the caller didn't ask for a count. */
  totalRecords: number | null;
}

export interface DbError {
  kind:
    | 'Connection' | 'Authentication' | 'Syntax' | 'NotFound'
    | 'Unsupported' | 'Timeout' | 'SshTunnel'
    | 'VaultLocked' | 'Vault' | 'Io' | 'Other';
  message: string;
  line?: number;
  column?: number;
}

export function isDbError(x: unknown): x is DbError {
  return !!x && typeof x === 'object' && 'kind' in (x as object) && 'message' in (x as object);
}

/**
 * Per-connection concurrency gate for the heavy data calls (`browse`,
 * `describeTable`). Without it, opening a database with several saved tabs —
 * or a reconnect / db-switch that re-triggers them — fires a dozen+ browses
 * and describes in the SAME tick. They all pile onto the connection's pool at
 * once; over a high-latency link (SSH especially) a handful of ~10ms queries
 * then serialize into 10–40s of queue wait, and the unlucky last one looks
 * "hung". (Confirmed in app.log: 6 tables browsed at one timestamp, describes
 * climbing 6s→10s.) Capping the in-flight count makes the burst queue
 * client-side and drain in small waves instead of saturating the pool — the
 * single most effective stampede guard, independent of any UI-level fix.
 *
 * Cap is per connection id so unrelated connections never block each other.
 * 4 keeps a table's own browse+describe+count flowing while leaving headroom.
 */
const DATA_CALL_LIMIT = 4;
const gateState = new Map<string, { active: number; queue: Array<() => void> }>();

function gateFor(connectionId: string) {
  let g = gateState.get(connectionId);
  if (!g) {
    g = { active: 0, queue: [] };
    gateState.set(connectionId, g);
  }
  return g;
}

async function withDataGate<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const g = gateFor(connectionId);
  if (g.active >= DATA_CALL_LIMIT) {
    // Wait for a slot. The releaser wakes us by handing over its slot, so we
    // do NOT increment `active` here — it already counts us. (Incrementing
    // would race a fresh caller that sees the briefly-decremented count and
    // also proceeds, overshooting the cap.)
    await new Promise<void>(resolve => g.queue.push(resolve));
  } else {
    g.active++;
  }
  try {
    return await fn();
  } finally {
    const next = g.queue.shift();
    if (next) {
      // Transfer our slot directly to the next waiter — don't decrement.
      next();
    } else {
      g.active--;
    }
  }
}

export const db = {
  connect: (connectionId: string) =>
    invoke<ConnectionMeta>('db_connect', { connectionId }),
  disconnect: (connectionId: string) =>
    invoke<void>('db_disconnect', { connectionId }),
  ping: (connectionId: string) =>
    invoke<ServerInfo>('db_ping', { connectionId }),
  listActive: () =>
    invoke<ConnectionMeta[]>('db_list_active'),
  listSchemas: (connectionId: string) =>
    invoke<SchemaInfo[]>('db_list_schemas', { connectionId }),
  describeTable: (connectionId: string, schema: string, table: string) =>
    withDataGate(connectionId, () =>
      invoke<TableStructure>('db_describe_table', { connectionId, schema, table })),
  describeSchema: (connectionId: string, schema: string) =>
    invoke<TableStructure[]>('db_describe_schema', { connectionId, schema }),
  listRelations: (connectionId: string, schema: string) =>
    invoke<ForeignKey[]>('db_list_relations', { connectionId, schema }),
  runQuery: (connectionId: string, statement: string, rowLimit?: number, schema?: string) =>
    invoke<QueryResult>('db_run_query', { connectionId, statement, rowLimit, schema }),
  runQueryStream: (
    connectionId: string,
    statement: string,
    onStatement: (statement: StatementResult) => void,
    rowLimit?: number,
    schema?: string,
  ) => {
    const channel = new Channel<StatementResult>();
    channel.onmessage = onStatement;
    return invoke<QueryResult>('db_run_query_stream', {
      connectionId,
      statement,
      rowLimit,
      schema,
      onStatement: channel,
    });
  },
  insertRows: (connectionId: string, request: InsertRowsRequest) =>
    invoke<InsertRowsResult>('db_insert_rows', { connectionId, request }),
  updateRows: (connectionId: string, request: UpdateRowsRequest) =>
    invoke<UpdateRowsResult>('db_update_rows', { connectionId, request }),
  modifyIndexes: (connectionId: string, request: ModifyIndexesRequest) =>
    invoke<void>('db_modify_indexes', { connectionId, request }),
  deleteRows: (connectionId: string, request: DeleteRowsRequest) =>
    invoke<DeleteRowsResult>('db_delete_rows', { connectionId, request }),
  listViews: (connectionId: string, schema: string) =>
    invoke<ViewInfo[]>('db_list_views', { connectionId, schema }),
  listRoutines: (connectionId: string, schema: string) =>
    invoke<RoutineInfo[]>('db_list_routines', { connectionId, schema }),
  describeRoutine: (connectionId: string, schema: string, name: string, kind: string) =>
    invoke<RoutineDefinition>('db_describe_routine', { connectionId, schema, name, kind }),
  createDatabase: (
    connectionId: string,
    name: string,
    charset?: string,
    collation?: string,
  ) =>
    invoke<void>('db_create_database', { connectionId, name, charset, collation }),
  /** Encodings the live server offers for new databases. Empty list
   *  means the adapter doesn't model per-database encodings (SQLite,
   *  Mongo, Redis); the create dialog uses that to hide the row. */
  listCharsets: (connectionId: string) =>
    invoke<string[]>('db_list_charsets', { connectionId }),
  /** Collations available for the given charset. Default collation
   *  comes first, the rest alphabetised. */
  listCollations: (connectionId: string, charset: string) =>
    invoke<string[]>('db_list_collations', { connectionId, charset }),
  /** Top-level database names for the "Open database" picker. For
   *  Postgres this comes from `pg_database`; for engines without that
   *  distinction it falls back to schema names. */
  listDatabases: (connectionId: string) =>
    invoke<string[]>('db_list_databases', { connectionId }),
  /** Rebuild the adapter pointed at a different database. Only meaningful
   *  where "database" is a top-level object distinct from schemas — PG
   *  today; Mongo later. Returns fresh `ConnectionMeta`. */
  switchDatabase: (connectionId: string, database: string) =>
    invoke<ConnectionMeta>('db_switch_database', { connectionId, database }),
  /** Every registered adapter's manifest. Drives the connection-modal picker and capability gates. */
  listAdapters: () => invoke<AdapterManifest[]>('db_list_adapters'),
  /** Open a realtime subscription. Events are delivered on the provided
   *  `Channel`; the caller holds the resolved `subscriptionId` to stop
   *  the pump later via `unsubscribe`. */
  subscribe: (
    connectionId: string,
    request: SubscribeRequest,
    onEvent: (event: SubscribeEvent) => void,
  ) => {
    const channel = new Channel<SubscribeEvent>();
    channel.onmessage = onEvent;
    return invoke<SubscribeResponse>('db_subscribe', {
      connectionId,
      request,
      onEvent: channel,
    });
  },
  unsubscribe: (subscriptionId: string) =>
    invoke<void>('db_unsubscribe', { subscriptionId }),
  /** Intent-driven browse. Frontend declares schema/table/filters/sort/page; adapter generates the SQL. */
  browse: (connectionId: string, request: BrowseRequest) =>
    withDataGate(connectionId, () =>
      invoke<BrowseResult>('db_browse', { connectionId, request })),
  // Process list / kill
  processList: (connectionId: string) =>
    invoke<ProcessInfo[]>('db_process_list', { connectionId }),
  killProcess: (connectionId: string, processId: string) =>
    invoke<void>('db_kill_process', { connectionId, processId }),
  killProcesses: (connectionId: string, processIds: string[]) =>
    invoke<KillResult[]>('db_kill_processes', { connectionId, processIds }),
  // Command analysis (destructive warning)
  analyzeCommand: (connectionId: string, command: string) =>
    invoke<CommandWarning[]>('db_analyze_command', { connectionId, command }),
};
