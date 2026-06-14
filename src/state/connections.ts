import { useSyncExternalStore } from 'react';
import { db, type ConnectionMeta, type SchemaInfo, type TableStructure, isDbError } from '../lib/db';

interface State {
  activeById: Map<string, ConnectionMeta>;
  schemasById: Map<string, SchemaInfo[]>;
  loadingSchemasById: Set<string>;
  loadedSchemasById: Set<string>;
  connectingIds: Set<string>;
  lastErrorById: Map<string, string>;
  /** Per-connection table-structure cache keyed by `schema.table` (lowercased). */
  tableStructuresById: Map<string, Map<string, TableStructure>>;
}

// In-flight describe_table promises so concurrent completion triggers don't
// pile up redundant Rust calls.
const inflightStructures = new Map<string, Promise<TableStructure>>();
const inflightConnects = new Map<string, Promise<ConnectionMeta | null>>();

// Connection ids the user cancelled while a connect was in flight. The Tauri
// `db_connect` invoke can't be aborted mid-handshake, so we let it finish and
// then honour the cancellation: if it succeeded we tear the connection down
// (so it doesn't leak), and either way we suppress the success/error state.
const cancelledConnects = new Set<string>();

// Same idea for list_schemas: StrictMode double-mount + the workspace, rail,
// and sidebar each calling refreshSchemas on connect all piled up 4–6 concurrent
// `db_list_schemas` round-trips per login over SSH.
const inflightSchemas = new Map<string, Promise<void>>();

// Per-connection "schema epoch", bumped whenever the connection's target
// database changes (a switch). A `refreshSchemas` call captures the epoch before
// its await and discards its result if the epoch moved meanwhile — so a slow
// `list_schemas` issued against the PREVIOUS database (e.g. the one
// `connectAndLoad` fires automatically) can't land its stale tree on top of a
// fresh post-switch fetch. Without this the final tree depended on a race.
const schemaEpoch = new Map<string, number>();
function bumpSchemaEpoch(connectionId: string): void {
  schemaEpoch.set(connectionId, (schemaEpoch.get(connectionId) ?? 0) + 1);
}

type Listener = () => void;

let state: State = {
  activeById: new Map(),
  schemasById: new Map(),
  loadingSchemasById: new Set(),
  loadedSchemasById: new Set(),
  connectingIds: new Set(),
  lastErrorById: new Map(),
  tableStructuresById: new Map(),
};

const listeners = new Set<Listener>();
function emit() { for (const l of listeners) l(); }
function subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }
function getSnapshot() { return state; }

function mutate(fn: (s: State) => State) {
  state = fn(state);
  emit();
}

export function useConnections() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export async function connectAndLoad(connectionId: string, force?: boolean): Promise<ConnectionMeta | null> {
  if (!force) {
    const existing = inflightConnects.get(connectionId);
    if (existing) return existing;
  }
  if (!force && state.activeById.has(connectionId)) {
    const meta = state.activeById.get(connectionId)!;
    mutate(s => {
      const connectingIds = new Set(s.connectingIds);
      connectingIds.delete(connectionId);
      const lastErrorById = new Map(s.lastErrorById);
      lastErrorById.delete(connectionId);
      return { ...s, connectingIds, lastErrorById };
    });
    return meta;
  }

  const p = (async () => {
    // Clear stale state when force-reconnecting
    if (force) {
      mutate(s => {
        const activeById = new Map(s.activeById);
        activeById.delete(connectionId);
        return { ...s, activeById };
      });
    }
    // Fresh attempt: clear any stale cancellation flag.
    cancelledConnects.delete(connectionId);
    mutate(s => {
      const next = { ...s, connectingIds: new Set(s.connectingIds) };
      next.connectingIds.add(connectionId);
      return next;
    });
    try {
      const meta = await db.connect(connectionId);
      if (cancelledConnects.has(connectionId)) {
        // User bailed while we were connecting. The handshake still completed
        // on the backend, so disconnect to avoid leaving an orphaned pool.
        cancelledConnects.delete(connectionId);
        void db.disconnect(connectionId).catch(() => {});
        return null;
      }
      mutate(s => {
        const activeById = new Map(s.activeById);
        activeById.set(connectionId, meta);
        const connectingIds = new Set(s.connectingIds);
        connectingIds.delete(connectionId);
        const lastErrorById = new Map(s.lastErrorById);
        lastErrorById.delete(connectionId);
        return { ...s, activeById, connectingIds, lastErrorById };
      });
      void refreshSchemas(connectionId);
      return meta;
    } catch (err) {
      if (cancelledConnects.has(connectionId)) {
        // User cancelled; swallow the (likely connection-refused/timeout)
        // error instead of surfacing it as a failed connection.
        cancelledConnects.delete(connectionId);
        return null;
      }
      const msg = isDbError(err) ? err.message : String(err);
      mutate(s => {
        const connectingIds = new Set(s.connectingIds);
        connectingIds.delete(connectionId);
        const lastErrorById = new Map(s.lastErrorById);
        lastErrorById.set(connectionId, msg);
        return { ...s, connectingIds, lastErrorById };
      });
      throw err;
    }
  })().finally(() => {
    inflightConnects.delete(connectionId);
  });
  inflightConnects.set(connectionId, p);
  return p;
}

/**
 * Cancel an in-flight connection attempt. The backend handshake can't be
 * aborted, so we just stop waiting on it: clear the connecting spinner and flag
 * the id so `connectAndLoad` discards whatever the handshake eventually
 * produces (tearing down a late success). No-op if nothing is connecting.
 */
export function cancelConnect(connectionId: string): void {
  if (!state.connectingIds.has(connectionId)) return;
  cancelledConnects.add(connectionId);
  inflightConnects.delete(connectionId);
  mutate(s => {
    const connectingIds = new Set(s.connectingIds);
    connectingIds.delete(connectionId);
    const lastErrorById = new Map(s.lastErrorById);
    lastErrorById.delete(connectionId);
    return { ...s, connectingIds, lastErrorById };
  });
}

export async function disconnect(connectionId: string): Promise<void> {
  try {
    await db.disconnect(connectionId);
  } catch {
    // Even if the backend says "not active", clear our client-side state so the
    // UI recovers from drift.
  }
  // Invalidate any in-flight schema fetch so a late result can't repopulate the
  // tree after the user disconnected.
  bumpSchemaEpoch(connectionId);
  inflightSchemas.delete(connectionId);
  mutate(s => {
    const activeById = new Map(s.activeById);
    activeById.delete(connectionId);
    const schemasById = new Map(s.schemasById);
    schemasById.delete(connectionId);
    const loadingSchemasById = new Set(s.loadingSchemasById);
    loadingSchemasById.delete(connectionId);
    const loadedSchemasById = new Set(s.loadedSchemasById);
    loadedSchemasById.delete(connectionId);
    const lastErrorById = new Map(s.lastErrorById);
    lastErrorById.delete(connectionId);
    const tableStructuresById = new Map(s.tableStructuresById);
    tableStructuresById.delete(connectionId);
    return { ...s, activeById, schemasById, loadingSchemasById, loadedSchemasById, lastErrorById, tableStructuresById };
  });
}

/** Mark a connection as lost (server dropped it, network timeout, etc.).
 *  Clears the active flag so the next `connectAndLoad` actually reconnects
 *  instead of short-circuiting on the stale entry. */
export function markConnectionLost(connectionId: string): void {
  mutate(s => {
    const activeById = new Map(s.activeById);
    activeById.delete(connectionId);
    const lastErrorById = new Map(s.lastErrorById);
    lastErrorById.set(connectionId, 'Connection lost');
    return { ...s, activeById, lastErrorById };
  });
}

function structureCacheKey(schema: string, table: string): string {
  return `${schema.toLowerCase()}.${table.toLowerCase()}`;
}

/** The database the connection's live pool is currently pointed at, as
 *  reported by the last handshake (`ServerInfo.defaultSchema`). Used to decide
 *  whether focusing a rail tile needs to re-point the pool. Undefined when the
 *  connection isn't active. */
export function getActiveDatabase(connectionId: string): string | null | undefined {
  return state.activeById.get(connectionId)?.server.defaultSchema;
}

/**
 * Re-point a live connection's pool at `database` and sync client state.
 *
 * Multi-database servers (Postgres/Mongo) keep ONE pool per connection that
 * can only target one database at a time. The rail pins a tile per database,
 * so focusing a different tile must rebuild the pool — otherwise the sidebar
 * keeps showing the previously-targeted database's tables under the new tile
 * and browsing/editing silently hits the wrong database.
 *
 * Updates `activeById` with the rebuilt meta and drops the per-connection
 * table-structure cache (a `public.users` in database A is unrelated to one
 * in database B). The caller refreshes the schema tree afterwards.
 */
export async function switchConnectionDatabase(
  connectionId: string,
  database: string,
): Promise<ConnectionMeta> {
  const meta = await db.switchDatabase(connectionId, database);
  // Drop any schema fetch already in flight against the PREVIOUS database, plus
  // the cached tree and structures, before updating meta. Otherwise a
  // background `refreshSchemas` started by `connectAndLoad` (which targeted the
  // default database) would satisfy the caller's post-switch refresh via the
  // in-flight dedupe and leave the wrong database's tree on screen.
  inflightSchemas.delete(connectionId);
  // Invalidate any list_schemas already mid-flight against the old database so
  // its result is discarded instead of clobbering the post-switch fetch.
  bumpSchemaEpoch(connectionId);
  mutate(s => {
    const activeById = new Map(s.activeById);
    activeById.set(connectionId, meta);
    const schemasById = new Map(s.schemasById);
    schemasById.delete(connectionId);
    const loadedSchemasById = new Set(s.loadedSchemasById);
    loadedSchemasById.delete(connectionId);
    return { ...s, activeById, schemasById, loadedSchemasById };
  });
  invalidateAllTableStructures(connectionId);
  // Tell any mounted data grid for this connection to refetch against the new
  // pool. The visible grid reloads now; hidden grids mark themselves stale and
  // reload when next shown. Without this a grid already mounted from the old
  // database keeps showing its cached rows after the switch.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('tablerelay:reload', { detail: { connectionId } }),
    );
  }
  return meta;
}

/** Synchronous read from the cache — returns undefined on miss. */
export function getCachedTableStructure(
  connectionId: string,
  schema: string,
  table: string,
): TableStructure | undefined {
  return state.tableStructuresById.get(connectionId)?.get(structureCacheKey(schema, table));
}

/**
 * Fetch a table's structure and cache it. Deduplicates concurrent calls.
 * Rejects if describe_table fails; caller decides whether to swallow.
 */
export async function ensureTableStructure(
  connectionId: string,
  schema: string,
  table: string,
): Promise<TableStructure> {
  const cached = getCachedTableStructure(connectionId, schema, table);
  if (cached) return cached;

  const key = `${connectionId}|${structureCacheKey(schema, table)}`;
  const existing = inflightStructures.get(key);
  if (existing) return existing;

  const p = db.describeTable(connectionId, schema, table).then(structure => {
    mutate(s => {
      const tableStructuresById = new Map(s.tableStructuresById);
      const perConn = new Map(tableStructuresById.get(connectionId) ?? []);
      perConn.set(structureCacheKey(schema, table), structure);
      tableStructuresById.set(connectionId, perConn);
      return { ...s, tableStructuresById };
    });
    return structure;
  }).finally(() => {
    inflightStructures.delete(key);
  });
  inflightStructures.set(key, p);
  return p;
}

/**
 * Drop every cached structure belonging to a connection. Called by the
 * global `tablerelay:reload` listener so any widget that's about to re-read
 * via `ensureTableStructure` hits a cold cache. Broad-brush by design:
 * DDL in one tab can affect multiple tables (FK changes, renames) so
 * scoping to a single table isn't always enough.
 */
export function invalidateAllTableStructures(connectionId: string): void {
  mutate(s => {
    if (!s.tableStructuresById.has(connectionId)) return s;
    const tableStructuresById = new Map(s.tableStructuresById);
    tableStructuresById.delete(connectionId);
    return { ...s, tableStructuresById };
  });
  // Drop any in-flight promises for this connection so concurrent reads
  // after invalidation don't resolve to stale structures.
  for (const key of Array.from(inflightStructures.keys())) {
    if (key.startsWith(`${connectionId}|`)) inflightStructures.delete(key);
  }
}

// Any component that dispatches `tablerelay:reload` is telling the app "data may
// have changed"; honour that by dropping the structure cache for the affected
// connection. If no connectionId is specified the event is global — invalidate
// everything to stay safe.
if (typeof window !== 'undefined') {
  window.addEventListener('tablerelay:reload', (e: Event) => {
    const ce = e as CustomEvent<{ connectionId?: string | null } | undefined>;
    const cid = ce.detail?.connectionId;
    if (cid) {
      invalidateAllTableStructures(cid);
    } else {
      // Global reload: nuke all cached structures.
      mutate(s => ({ ...s, tableStructuresById: new Map() }));
      inflightStructures.clear();
    }
  });
}

/**
 * Seed the cache with a `TableStructure` the caller already fetched in bulk
 * (e.g. via `db.describeSchema`). Lets subsequent reads for the same table
 * skip the network — mirrors what `ensureTableStructure` would have done on
 * success, but without firing a one-off describe.
 */
export function primeTableStructure(
  connectionId: string,
  structure: TableStructure,
): void {
  mutate(s => {
    const tableStructuresById = new Map(s.tableStructuresById);
    const perConn = new Map(tableStructuresById.get(connectionId) ?? []);
    perConn.set(structureCacheKey(structure.schema, structure.name), structure);
    tableStructuresById.set(connectionId, perConn);
    return { ...s, tableStructuresById };
  });
}

/**
 * Drop the cached structure for a table so the next `ensureTableStructure`
 * hits the database. Callers should use this after ALTER / CREATE / DROP so
 * subsequent reads reflect the new shape.
 */
export function invalidateTableStructure(
  connectionId: string,
  schema: string,
  table: string,
): void {
  mutate(s => {
    const perConn = s.tableStructuresById.get(connectionId);
    if (!perConn) return s;
    const key = structureCacheKey(schema, table);
    if (!perConn.has(key)) return s;
    const nextPer = new Map(perConn);
    nextPer.delete(key);
    const tableStructuresById = new Map(s.tableStructuresById);
    tableStructuresById.set(connectionId, nextPer);
    return { ...s, tableStructuresById };
  });
  // Drop any in-flight promise too so a concurrent read after invalidation
  // won't resolve to the stale structure.
  inflightStructures.delete(`${connectionId}|${structureCacheKey(schema, table)}`);
}

/**
 * Fetch a table's structure AND update the cache. Use when you know the
 * underlying table has changed (after a successful ALTER/CREATE, manual
 * refresh, etc.) — routes through the in-flight map so parallel callers
 * still dedupe, but never reads a stale cached value.
 */
export async function refreshTableStructure(
  connectionId: string,
  schema: string,
  table: string,
): Promise<TableStructure> {
  invalidateTableStructure(connectionId, schema, table);
  return ensureTableStructure(connectionId, schema, table);
}

/**
 * Re-fetch the schema list for a connection.
 *
 * `opts.silent` enables stale-while-revalidate: the cached tree stays on
 * screen and we do NOT flip `loadingSchemasById` (which would make the sidebar
 * swap in the loading skeleton). New data is swapped in when it lands; on error
 * the cached tree is kept rather than surfaced as a failure. Use this for
 * background revalidation — e.g. switching back to an already-loaded
 * connection, where a brief socket re-check shouldn't blank the UI. Without
 * `silent`, the call shows the loading state (first load, manual ⌘+R).
 *
 * If a connection has no cached schemas yet, a `silent` call is automatically
 * promoted to a visible one — there's nothing to keep on screen, so the
 * skeleton is the right thing to show.
 */
export async function refreshSchemas(
  connectionId: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  const existing = inflightSchemas.get(connectionId);
  if (existing) return existing;

  // Silent only makes sense when there's a cached tree to keep visible.
  const hasCache = (getSnapshot().schemasById.get(connectionId)?.length ?? 0) > 0;
  const silent = opts.silent === true && hasCache;

  // Snapshot the epoch now; if a database switch bumps it during the await, the
  // result we get back is for the previous database and must be discarded.
  const epoch = schemaEpoch.get(connectionId) ?? 0;
  const p = (async () => {
    if (!silent) {
      mutate(s => {
        const loadingSchemasById = new Set(s.loadingSchemasById);
        loadingSchemasById.add(connectionId);
        return { ...s, loadingSchemasById };
      });
    }
    try {
      const schemas = await db.listSchemas(connectionId);
      if ((schemaEpoch.get(connectionId) ?? 0) !== epoch) {
        // A switch happened while this fetch was in flight — its tree belongs to
        // the old database. Drop it; the switch's own refresh is authoritative.
        mutate(s => {
          const loadingSchemasById = new Set(s.loadingSchemasById);
          loadingSchemasById.delete(connectionId);
          return { ...s, loadingSchemasById };
        });
        return;
      }
      mutate(s => {
        const schemasById = new Map(s.schemasById);
        schemasById.set(connectionId, schemas);
        const loadingSchemasById = new Set(s.loadingSchemasById);
        loadingSchemasById.delete(connectionId);
        const loadedSchemasById = new Set(s.loadedSchemasById);
        loadedSchemasById.add(connectionId);
        return { ...s, schemasById, loadingSchemasById, loadedSchemasById };
      });
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      mutate(s => {
        const loadingSchemasById = new Set(s.loadingSchemasById);
        loadingSchemasById.delete(connectionId);
        const loadedSchemasById = new Set(s.loadedSchemasById);
        // A silent background revalidation that fails leaves the cached tree
        // in place and stays quiet — don't surface a transient blip as a
        // connection error. A visible refresh records the error as before.
        if (silent) {
          return { ...s, loadingSchemasById };
        }
        const lastErrorById = new Map(s.lastErrorById);
        lastErrorById.set(connectionId, msg);
        loadedSchemasById.delete(connectionId);
        return { ...s, loadingSchemasById, loadedSchemasById, lastErrorById };
      });
    }
  })().finally(() => {
    inflightSchemas.delete(connectionId);
  });
  inflightSchemas.set(connectionId, p);
  return p;
}
