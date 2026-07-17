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

/** One labeled server/database statistic for the connection "Information"
 *  dialog (default collation, on-disk size, table count, uptime, …). */
export interface ServerDetail {
  label: string;
  value: string;
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
  /** Index method as the engine reports it — MySQL BTREE/HASH/FULLTEXT/
   *  SPATIAL, Postgres BTREE/HASH/GIN/GIST/… (uppercased). Undefined for
   *  adapters that don't expose it (SQLite, Mongo). */
  algorithm?: string;
  /** This index physically backs the PRIMARY KEY (MySQL `PRIMARY`, Postgres
   *  `<table>_pkey`, SQLite `origin = pk`, Mongo `_id_`). The schema editor
   *  shows it read-only. Set per-adapter; absent (falsy) on older payloads. */
  isPrimary?: boolean;
}

export interface ForeignKey {
  name: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
  /** Referential actions as canonical SQL (`NO ACTION`, `CASCADE`,
   *  `SET NULL`, `RESTRICT`, `SET DEFAULT`). Undefined when the adapter
   *  didn't surface them (bulk schema scans / relations view). */
  onUpdate?: string;
  onDelete?: string;
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
  /** True when the backend capped an unbounded query at MAX_RESULT_ROWS —
   *  more rows exist on the server. Add a LIMIT to fetch a specific range. */
  truncated?: boolean;
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

// ---- User / role management ----

/** Whether the current connection may manage users, plus why not. */
export interface ManageUsersCapability {
  canManage: boolean;
  reason: string;
}

/** A Mongo role grant: a role scoped to a database. */
export interface RoleGrant {
  role: string;
  db: string;
}

/** One database user / role / account. */
export interface UserInfo {
  name: string;
  host?: string | null;
  canLogin?: boolean | null;
  isSuperuser?: boolean | null;
  isLocked?: boolean | null;
  attributes: string[];
  /** Mongo role grants (empty for SQL engines). */
  roles?: RoleGrant[];
  /** Mongo: the database the user authenticates against. */
  database?: string | null;
}

/** The effective grants held by an account, as the engine's own grant lines. */
export interface GrantInfo {
  statements: string[];
}

export interface CreateUserRequest {
  name: string;
  host?: string | null;
  password?: string | null;
  isSuperuser?: boolean;
  canLogin?: boolean;
  /** Mongo: database to create the user in (defaults to `admin`). */
  database?: string | null;
  /** Mongo: roles to grant on creation. */
  roles?: RoleGrant[];
}

export interface AlterUserRequest {
  name: string;
  host?: string | null;
  password?: string | null;
  isSuperuser?: boolean | null;
  canLogin?: boolean | null;
  isLocked?: boolean | null;
  /** Mongo: the user's database. */
  database?: string | null;
  /** Mongo: replace the user's roles (undefined leaves them unchanged). */
  roles?: RoleGrant[] | null;
}

/** Identifies a single account (name + optional MySQL host / Mongo database). */
export interface UserRef {
  name: string;
  host?: string | null;
  database?: string | null;
}

/** GRANT/REVOKE a privilege set on a scope. Scope is engine-specific: for
 *  MySQL `database`=DB (undefined = global `*.*`), `table`=table; for Postgres
 *  `database` carries the schema and global scope isn't allowed. Privileges are
 *  validated against the engine's allowlist on the backend. */
export interface GrantRequest {
  user: UserRef;
  privileges: string[];
  database?: string | null;
  table?: string | null;
  withGrantOption?: boolean;
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

export interface TriggerInfo {
  name: string;
  table: string;
  /** "BEFORE" | "AFTER" | "INSTEAD OF". */
  timing: string;
  /** "INSERT" | "UPDATE" | "DELETE" (Postgres/SQLite may OR-combine). */
  event: string;
}

export interface TriggerDefinition {
  schema: string;
  name: string;
  table: string;
  timing: string;
  event: string;
  body: string;
  createSql: string;
}

/** Payload for `db.saveTrigger`. `originalName` is set when editing/renaming an
 *  existing trigger so the adapter can drop the old one first. `createSql` is
 *  required for Postgres/SQLite (their triggers don't decompose into a simple
 *  body); MySQL can assemble from the structured fields when it's omitted. */
export interface SaveTriggerInput {
  schema: string;
  name: string;
  originalName?: string | null;
  table: string;
  timing: string;
  event: string;
  body: string;
  createSql?: string | null;
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
  triggers: boolean;
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
  /** Adapter supports user/role management — the sidebar shows a "Users"
   *  entry when set (still gated at runtime by canManageUsers for the
   *  current account's privileges). */
  manageUsers: boolean;
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
  /** Optional projection. Empty/omitted means all columns. */
  columns?: string[];
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
 * Best-effort human-readable message for anything thrown/rejected. Tauri
 * command rejections come back as plain objects (our `DbError` shape, or an
 * ad-hoc `{ message }` / `{ error }`), NOT `Error` instances — so a naive
 * `String(err)` yields the useless "[object Object]". This unwraps the common
 * shapes and only falls back to JSON as a last resort.
 */
export function errText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (isDbError(err)) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    try {
      return JSON.stringify(err);
    } catch {
      /* circular — fall through */
    }
  }
  return String(err);
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
    tabId?: string,
  ) => {
    const channel = new Channel<StatementResult>();
    channel.onmessage = onStatement;
    return invoke<QueryResult>('db_run_query_stream', {
      connectionId,
      statement,
      rowLimit,
      schema,
      onStatement: channel,
      tabId,
    });
  },
  cancelQuery: (connectionId: string, tabId: string) =>
    invoke<boolean>('db_cancel_query', { connectionId, tabId }),
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
  /** `CREATE VIEW` DDL for one view (used by SQL export). */
  viewDefinition: (connectionId: string, schema: string, name: string) =>
    invoke<string>('db_view_definition', { connectionId, schema, name }),
  listRoutines: (connectionId: string, schema: string) =>
    invoke<RoutineInfo[]>('db_list_routines', { connectionId, schema }),
  describeRoutine: (connectionId: string, schema: string, name: string, kind: string) =>
    invoke<RoutineDefinition>('db_describe_routine', { connectionId, schema, name, kind }),
  listTriggers: (connectionId: string, schema: string) =>
    invoke<TriggerInfo[]>('db_list_triggers', { connectionId, schema }),
  describeTrigger: (connectionId: string, schema: string, name: string) =>
    invoke<TriggerDefinition>('db_describe_trigger', { connectionId, schema, name }),
  saveTrigger: (connectionId: string, request: SaveTriggerInput) =>
    invoke<void>('db_save_trigger', { connectionId, request }),
  dropTrigger: (connectionId: string, schema: string, name: string, table: string) =>
    invoke<void>('db_drop_trigger', { connectionId, schema, name, table }),
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
  /** Every collation on the server, independent of charset. Drives the
   *  schema editor's per-column collation dropdown. Empty list ⇒ the
   *  adapter has no collation concept and the cell stays free-text. */
  listAllCollations: (connectionId: string) =>
    invoke<string[]>('db_list_all_collations', { connectionId }),
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
  /**
   * Fetch one full record by primary-key value, untruncated. For adapters
   * (Mongo) whose `browse` returns size-capped previews of huge values, the
   * grid calls this to lazy-load the complete record when a row is opened.
   * Returns `null` if no record matches.
   */
  getRecord: (
    connectionId: string,
    schema: string,
    table: string,
    id: unknown,
  ) =>
    invoke<unknown | null>('db_get_record', {
      connectionId,
      schema,
      table,
      id,
    }),
  /**
   * Live server/database statistics for the connection "Information" dialog
   * (collation, on-disk size, table count, uptime, …). `schema` scopes the
   * database-specific stats to the focused database. Empty for adapters that
   * don't implement it.
   */
  serverDetails: (connectionId: string, schema?: string | null) =>
    invoke<ServerDetail[]>('db_server_details', {
      connectionId,
      schema: schema ?? null,
    }),
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
  // User / role management
  canManageUsers: (connectionId: string) =>
    invoke<ManageUsersCapability>('db_can_manage_users', { connectionId }),
  listUsers: (connectionId: string) =>
    invoke<UserInfo[]>('db_list_users', { connectionId }),
  listGrants: (connectionId: string, user: UserRef) =>
    invoke<GrantInfo>('db_list_grants', { connectionId, user }),
  createUser: (connectionId: string, request: CreateUserRequest) =>
    invoke<void>('db_create_user', { connectionId, request }),
  alterUser: (connectionId: string, request: AlterUserRequest) =>
    invoke<void>('db_alter_user', { connectionId, request }),
  dropUser: (connectionId: string, user: UserRef) =>
    invoke<void>('db_drop_user', { connectionId, user }),
  grantPrivileges: (connectionId: string, request: GrantRequest) =>
    invoke<void>('db_grant_privileges', { connectionId, request }),
  revokePrivileges: (connectionId: string, request: GrantRequest) =>
    invoke<void>('db_revoke_privileges', { connectionId, request }),
  /** MySQL FLUSH PRIVILEGES — reload the in-memory grant tables. */
  flushPrivileges: (connectionId: string) =>
    invoke<void>('db_flush_privileges', { connectionId }),
};
