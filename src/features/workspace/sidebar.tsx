import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Database,
  Table as TableIcon,
  LayoutTemplate,
  FunctionSquare,
  ChevronDown,
  MoreVertical,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Waypoints,
  Radio,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import DatabasePickerDialog from "../connections/database-picker-dialog";
import ConnectionManagerDialog from "../connections/connection-manager-dialog";
import ConnectPickerDialog from "../connections/connect-picker-dialog";
import { ProcessListPanel } from "../process-list/process-list-panel";
import { ConnectionProfile } from "../../types";
import {
  connectAndLoad,
  refreshSchemas,
  useConnections,
} from "../../state/connections";
import {
  useAdapterManifests,
  resolveManifest,
} from "../../state/adapter-manifests";
import { db, type RoutineInfo, type ViewInfo } from "../../lib/db";
import DbIcon from "../../components/db-icon";
import { SidebarListSkeleton } from "../../components/skeleton";
import { DestructiveConfirmDialog } from "../../components/destructive-confirm-dialog";
import { useMultiSelection } from "../../hooks/use-multi-selection";
import { getClickIntent, getKeyIntent } from "../../lib/click-intent";
import { dialectFromManifest } from "../data-grid/editor-kinds";

interface SidebarProps {
  focusedConnection: ConnectionProfile | null;
  /** Database the focused tile represents. Null when there are no tiles yet. */
  focusedDatabase: string | null;
  /** All saved connections — shown in the connection picker. */
  connections: ConnectionProfile[];
  onOpenTable: (
    connectionId: string,
    schema: string,
    tableName: string,
  ) => void;
  onOpenStructure: (
    connectionId: string,
    schema: string,
    tableName: string,
  ) => void;
  onNewQuery: (connectionId: string, tableName?: string) => void;
  onOpenErd: (
    connectionId: string,
    schemaName: string,
    tableName?: string,
  ) => void;
  /** Connect to (and focus) an existing saved connection. */
  onPickConnection: (connectionId: string) => void;
  /** Open the edit modal for an existing saved connection. */
  onEditConnection: (connection: ConnectionProfile) => void;
  /** Delete an existing saved connection. */
  onDeleteConnection: (connectionId: string) => void;
  /** Open the "create connection" modal. */
  onOpenNewServer: () => void;
  /** Pin (server, database) to the rail and switch focus to it. */
  onPinDatabase: (serverId: string, databaseName: string) => void;
  /**
   * Open (or re-focus) a query tab pre-filled with a DDL definition.
   * `key` identifies the object so opening the same view / routine twice
   * focuses the existing tab instead of stacking duplicates.
   */
  onOpenDefinition: (
    connectionId: string,
    key: string,
    title: string,
    sql: string,
  ) => void;
  /** Open a dedicated routine editor tab for a function/procedure. */
  onOpenRoutine?: (
    connectionId: string,
    schema: string,
    name: string,
    kind: "function" | "procedure",
  ) => void;
  /** Open a dedicated view editor tab (reuses the RoutineView shell). */
  onOpenView?: (connectionId: string, schema: string, name: string) => void;
  /** Start a "new table" flow — opens an empty Schema editor tab. */
  onNewTable?: (connectionId: string, schema: string) => void;
  /** Start a "new view" flow — opens a blank view editor. */
  onNewView?: (connectionId: string, schema: string) => void;
  /** Start a "new routine" flow — opens a blank routine editor. */
  onNewRoutine?: (
    connectionId: string,
    schema: string,
    kind: "function" | "procedure",
  ) => void;
  /** Open (or refocus) the realtime tab for the focused server. */
  onOpenRealtime?: (connectionId: string) => void;
  /**
   * Identifies the active tab so the sidebar can highlight the matching
   * table / view / routine. Only the fields relevant to matching are
   * required — WorkspaceView passes a denormalized shape derived from the
   * active AppTab.
   */
  activeItem?: {
    type: "table" | "view" | "routine";
    connectionId: string;
    schema: string;
    name: string;
    /** For routines only — distinguishes function vs procedure. */
    routineKind?: "function" | "procedure";
  } | null;
}

type SectionKey = "tables" | "views" | "routines";

function quoteIdentForDialect(
  ident: string,
  dialect: "mysql" | "postgres" | "sqlite" | "generic" | "none",
): string {
  if (dialect === "mysql") return "`" + ident.replace(/`/g, "``") + "`";
  return '"' + ident.replace(/"/g, '""') + '"';
}

function toTitleCaseLabel(raw: string): string {
  // Display-only prettifier for DB names in the sidebar header.
  // Keeps underlying schema/database identifiers untouched for queries.
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export default function Sidebar({
  focusedConnection,
  focusedDatabase,
  connections,
  onOpenTable,
  onOpenStructure,
  onNewQuery,
  onOpenErd,
  onPickConnection,
  onEditConnection,
  onDeleteConnection,
  onOpenNewServer,
  onPinDatabase,
  onOpenDefinition,
  onOpenRoutine,
  onNewTable,
  onNewView,
  onNewRoutine,
  onOpenRealtime,
  activeItem,
}: SidebarProps) {
  const [filter, setFilter] = useState("");
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  const [connManagerOpen, setConnManagerOpen] = useState(false);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);

  // Per-database asynchronous extras (views + routines). Tables come from
  // listSchemas; views/routines are lazily fetched on database switch.
  const [viewsByDb, setViewsByDb] = useState<Map<string, ViewInfo[]>>(
    new Map(),
  );
  const [routinesByDb, setRoutinesByDb] = useState<Map<string, RoutineInfo[]>>(
    new Map(),
  );
  const [loadingExtras, setLoadingExtras] = useState(false);
  // Which section is mid-refresh from its hover sync button. Drives the
  // spinning icon on just that section's header.
  const [refreshingSection, setRefreshingSection] = useState<SectionKey | null>(
    null,
  );

  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    tables: false,
    views: false,
    routines: false,
  });

  // Destructive confirmation state for table drops / truncates triggered
  // from the sidebar. Single source of truth so context menu, keyboard
  // shortcut, and (future) bulk action bar all route through the same
  // dialog component.
  type TableDestructiveAction = {
    kind: "drop" | "truncate";
    tableNames: string[];
  };
  const [tableConfirm, setTableConfirm] =
    useState<TableDestructiveAction | null>(null);
  const tablesContainerRef = useRef<HTMLDivElement>(null);

  const connState = useConnections();
  const conn = focusedConnection;
  const schemas = conn ? (connState.schemasById.get(conn.id) ?? []) : [];
  const isLoadingSchemas = conn
    ? connState.loadingSchemasById.has(conn.id)
    : false;
  const hasLoadedSchemas = conn
    ? connState.loadedSchemasById.has(conn.id)
    : false;

  // Capability gates — pulled from the adapter manifest so we don't
  // fire `list_views` / `list_routines` against adapters that declare
  // those unsupported (SQLite has no stored routines; future adapters
  // may also opt out of views). Without this gate the sidebar's
  // "lazy-load extras" effect piled up per-render `Unsupported` errors
  // in the console on every database switch.
  const manifests = useAdapterManifests();
  const activeManifest = useMemo(
    () => resolveManifest(manifests, conn?.driver),
    [manifests, conn?.driver],
  );
  // Default to `true` so behaviour before the manifest loads matches
  // the historic "try everything" path — the catch branch still
  // swallows failures. Once the manifest arrives, strict gating kicks in.
  const supportsViews = activeManifest?.capabilities.views ?? true;
  const supportsRoutines = activeManifest?.capabilities.routines ?? true;
  const supportsDiagram = activeManifest?.capabilities.diagram ?? true;
  // Realtime defaults to `false` so SQL-only adapters don't flash the
  // menu entry while manifests load — the opposite of views/routines,
  // where historically everything supported them.
  const supportsRealtime = activeManifest?.capabilities.realtime ?? false;
  const supportsProcessList = activeManifest?.capabilities.processList ?? false;
  // Generic noun for the primary-entity section header. Document stores (Mongo)
  // report sql_dialect=none — same flag the data grid uses for isDocumentStore.
  // We label the section "documents"/"tables" (the kind) rather than the
  // schema/database name, matching the "views"/"routines" sections below.
  const isDocumentStore = activeManifest?.capabilities.sqlDialect === "none";
  const entityNoun = isDocumentStore ? "documents" : "tables";
  // Distinguish "connection exists in store" from "connection is live". When
  // a connect attempt fails we still have `conn` (the profile) but no active
  // driver — this is what the sidebar checks to swap in a clear "failed"
  // state instead of silently rendering an empty table list.
  const isConnected = conn ? connState.activeById.has(conn.id) : false;
  const isConnecting = conn ? connState.connectingIds.has(conn.id) : false;
  const connectError = conn
    ? (connState.lastErrorById.get(conn.id) ?? null)
    : null;
  const [retrying, setRetrying] = useState(false);
  const [processListOpen, setProcessListOpen] = useState(false);

  // Minimum-visible-time gate for the post-connect spinner.
  //
  // On fast adapters (SQLite opens a local file in ~2ms; small MySQL
  // databases in LAN latency) the whole connect + list_schemas path
  // finishes in under 100ms — below the threshold where a human can
  // register a spinner as "something happened". React synchronously
  // batches the state transitions `isConnecting=false + schemas=[…]`
  // so the user sees a single-frame flash of "nothing" followed by
  // the populated sidebar.
  //
  // This effect records when the connection first went "live for this
  // sidebar" and keeps a local `pendingReveal` flag true for at least
  // `MIN_LOADING_MS` so the spinner is visible even if the data is
  // already in hand. Once the timer elapses, the flag clears and the
  // real content renders.
  const MIN_LOADING_MS = 250;
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  useEffect(() => {
    if (!conn) return;
    // Only arm the reveal when we first see this connection enter
    // connecting/connected state. If schemas are already cached
    // (reconnect in-session), skip the gate — there's nothing to wait
    // for.
    if (schemas.length > 0 && !isConnecting) return;
    const key = conn.id;
    setPendingReveal(key);
    const t = setTimeout(() => {
      setPendingReveal((curr) => (curr === key ? null : curr));
    }, MIN_LOADING_MS);
    return () => clearTimeout(t);
    // Intentionally only re-run on connection change — not on schemas
    // size, because we want the timer to complete even after schemas
    // populate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);
  const showLoadingFloor = pendingReveal === conn?.id;

  const handleRetryConnect = async () => {
    if (!conn) return;
    setRetrying(true);
    try {
      await connectAndLoad(conn.id);
    } catch {
      // Error is already captured in `lastErrorById`; no need to toast again.
    } finally {
      setRetrying(false);
    }
  };
  // The selected database IS the one on the focused rail tile. When the user
  // wants a different one, they pick it from the dialog — which pins a new
  // tile and switches focus to it.
  const selectedDb = focusedDatabase;

  // For Postgres, `selectedDb` is the PG database name (matches the tile
  // header) but `list_schemas` returns real SQL namespaces (public, demos…).
  // Pick a sensible schema from the list — `public` if present, else the
  // first non-empty one, else the first at all — whenever `selectedDb`
  // doesn't itself name a schema. For other drivers schema == database, so
  // this collapses to `selectedDb`.
  const effectiveSchema = useMemo(() => {
    if (!selectedDb) return null;
    if (schemas.some((s) => s.name === selectedDb)) return selectedDb;
    // Case-insensitive fallback: a rail tile pinned/displayed as `Clipbridge`
    // must still resolve the real lowercase `clipbridge` schema (Mongo db
    // names and user casing differ). Without this the match falls through to
    // schemas[0] and the table list renders blank after reload.
    const ci = schemas.find(
      (s) => s.name.toLowerCase() === selectedDb.toLowerCase(),
    );
    if (ci) return ci.name;
    const pub = schemas.find((s) => s.name === "public");
    if (pub) return pub.name;
    const nonEmpty = schemas.find((s) => s.tables.length > 0);
    if (nonEmpty) return nonEmpty.name;
    return schemas[0]?.name ?? selectedDb;
  }, [schemas, selectedDb]);

  // ⌘ + K / Ctrl + K opens the database dialog when there's a connection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (!conn) return;
        e.preventDefault();
        setDbPickerOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  // Explicit refetch on ⌘+R. Clearing the cache alone doesn't always retrigger
  // the lazy-load effect (React batches deps, and a same-object Map replacement
  // wouldn't flip equality anyway), so we just fire a fresh fetch directly.
  useEffect(() => {
    const onReload = () => {
      if (!conn || !selectedDb) {
        setViewsByDb(new Map());
        setRoutinesByDb(new Map());
        return;
      }
      // Refresh the schema list (tables, kinds, row counts) so structural
      // changes — new/renamed/dropped tables — show up immediately.
      void refreshSchemas(conn.id);
      const schemaForCalls = effectiveSchema ?? selectedDb;
      const key = `${conn.id}.${schemaForCalls}`;
      setLoadingExtras(true);
      // Skip unsupported calls — the adapter would reject them with
      // `Unsupported` and we'd log a bogus "reload failed" warning.
      const viewsFut = supportsViews
        ? db.listViews(conn.id, schemaForCalls)
        : Promise.resolve([] as ViewInfo[]);
      const routinesFut = supportsRoutines
        ? db.listRoutines(conn.id, schemaForCalls)
        : Promise.resolve([] as RoutineInfo[]);
      void Promise.all([viewsFut, routinesFut])
        .then(([v, r]) => {
          setViewsByDb((prev) => new Map(prev).set(key, v));
          setRoutinesByDb((prev) => new Map(prev).set(key, r));
        })
        .catch((err) => console.warn("reload views/routines failed", err))
        .finally(() => setLoadingExtras(false));
    };
    const onOpenConnectionPicker = () => setConnManagerOpen(true);
    const onOpenConnectPicker = () => setConnectPickerOpen(true);
    const onOpenDatabase = () => {
      if (conn) setDbPickerOpen(true);
    };
    window.addEventListener("tablerelay:reload", onReload);
    window.addEventListener("tablerelay:menu-connection-picker", onOpenConnectionPicker);
    window.addEventListener("tablerelay:open-connect-picker", onOpenConnectPicker);
    window.addEventListener("tablerelay:menu-open-database", onOpenDatabase);
    return () => {
      window.removeEventListener("tablerelay:reload", onReload);
      window.removeEventListener("tablerelay:menu-connection-picker", onOpenConnectionPicker);
      window.removeEventListener("tablerelay:open-connect-picker", onOpenConnectPicker);
      window.removeEventListener("tablerelay:menu-open-database", onOpenDatabase);
    };
  }, [conn, selectedDb]);

  // Lazy-load views + routines whenever the selected database changes.
  // Gated by manifest capabilities so adapters that don't support one
  // (SQLite has no stored routines) don't fire the command at all.
  useEffect(() => {
    if (!conn || !effectiveSchema) return;
    const key = `${conn.id}.${effectiveSchema}`;
    const needV = supportsViews && !viewsByDb.has(key);
    const needR = supportsRoutines && !routinesByDb.has(key);
    if (!needV && !needR) return;
    setLoadingExtras(true);
    const viewsFut = needV
      ? db.listViews(conn.id, effectiveSchema)
      : Promise.resolve(viewsByDb.get(key) ?? ([] as ViewInfo[]));
    const routinesFut = needR
      ? db.listRoutines(conn.id, effectiveSchema)
      : Promise.resolve(routinesByDb.get(key) ?? ([] as RoutineInfo[]));
    void Promise.all([viewsFut, routinesFut])
      .then(([v, r]) => {
        setViewsByDb((prev) => new Map(prev).set(key, v));
        setRoutinesByDb((prev) => new Map(prev).set(key, r));
      })
      .catch((err) => {
        console.warn("list_views/routines failed", err);
        // Don't toast — tables list still works; these are supplementary.
      })
      .finally(() => setLoadingExtras(false));
  }, [
    conn,
    effectiveSchema,
    viewsByDb,
    routinesByDb,
    supportsViews,
    supportsRoutines,
  ]);

  // Per-section re-sync from the hover button on each section header. Each
  // refetches only its own list so a stale tables/views/routines list can be
  // refreshed without a full ⌘+R. `refreshingSection` drives the spinner on
  // just the section being synced.
  const refreshTables = useCallback(async () => {
    if (!conn) return;
    setRefreshingSection("tables");
    try {
      await refreshSchemas(conn.id);
    } catch (err) {
      console.warn("refresh tables failed", err);
    } finally {
      setRefreshingSection((s) => (s === "tables" ? null : s));
    }
  }, [conn]);

  const refreshViews = useCallback(async () => {
    if (!conn || !effectiveSchema) return;
    const key = `${conn.id}.${effectiveSchema}`;
    setRefreshingSection("views");
    try {
      const v = await db.listViews(conn.id, effectiveSchema);
      setViewsByDb((prev) => new Map(prev).set(key, v));
    } catch (err) {
      console.warn("refresh views failed", err);
    } finally {
      setRefreshingSection((s) => (s === "views" ? null : s));
    }
  }, [conn, effectiveSchema]);

  const refreshRoutines = useCallback(async () => {
    if (!conn || !effectiveSchema) return;
    const key = `${conn.id}.${effectiveSchema}`;
    setRefreshingSection("routines");
    try {
      const r = await db.listRoutines(conn.id, effectiveSchema);
      setRoutinesByDb((prev) => new Map(prev).set(key, r));
    } catch (err) {
      console.warn("refresh routines failed", err);
    } finally {
      setRefreshingSection((s) => (s === "routines" ? null : s));
    }
  }, [conn, effectiveSchema]);

  const tables = useMemo(() => {
    if (!effectiveSchema) return [];
    const schema = schemas.find((s) => s.name === effectiveSchema);
    return schema?.tables.filter((t) => t.kind !== "view") ?? [];
  }, [schemas, effectiveSchema]);

  const views: ViewInfo[] = useMemo(() => {
    if (!conn || !effectiveSchema) return [];
    return viewsByDb.get(`${conn.id}.${effectiveSchema}`) ?? [];
  }, [conn, effectiveSchema, viewsByDb]);

  const routines: RoutineInfo[] = useMemo(() => {
    if (!conn || !effectiveSchema) return [];
    return routinesByDb.get(`${conn.id}.${effectiveSchema}`) ?? [];
  }, [conn, effectiveSchema, routinesByDb]);

  // Everywhere the sidebar passes a "schema" down to a command or a
  // click handler, use `effectiveSchema`. For PG that's a real namespace
  // (e.g. `public`); for MySQL/SQLite it collapses to `selectedDb`.
  const schemaForActions = effectiveSchema ?? selectedDb ?? "";

  const q = filter.trim().toLowerCase();
  const fTables = q
    ? tables.filter((t) => t.name.toLowerCase().includes(q))
    : tables;
  const fViews = q
    ? views.filter((v) => v.name.toLowerCase().includes(q))
    : views;
  const fRoutines = q
    ? routines.filter((r) => r.name.toLowerCase().includes(q))
    : routines;

  // Multi-selection over the visible (filtered) tables list. Selection
  // resets implicitly when the orderedIds() function returns a new array
  // — switching connection/database produces a different `tables` ref,
  // so stale selections never leak across contexts (we also clear
  // explicitly below).
  const orderedTableIds = useCallback(
    () => fTables.map((t) => t.name),
    [fTables],
  );
  const tableSelection = useMultiSelection(orderedTableIds);

  // Drop selection when the visible context changes (different connection,
  // database, or schema). Without this, the selectedIds Set would still
  // hold names from the previous schema and bulk drop would target ghosts.
  useEffect(() => {
    tableSelection.clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, schemaForActions]);

  const dialect = useMemo(
    () => dialectFromManifest(activeManifest?.capabilities ?? null),
    [activeManifest],
  );
  const supportsDropTable = activeManifest?.capabilities.dropTable ?? false;
  const supportsDdl = dialect !== "none";

  const buildDropSql = useCallback(
    (tableNames: string[]): string => {
      return tableNames
        .map(
          (name) =>
            `DROP TABLE ${quoteIdentForDialect(schemaForActions, dialect)}.${quoteIdentForDialect(name, dialect)};`,
        )
        .join("\n");
    },
    [dialect, schemaForActions],
  );

  const buildTruncateSql = useCallback(
    (tableNames: string[]): string => {
      return tableNames
        .map(
          (name) =>
            `TRUNCATE TABLE ${quoteIdentForDialect(schemaForActions, dialect)}.${quoteIdentForDialect(name, dialect)};`,
        )
        .join("\n");
    },
    [dialect, schemaForActions],
  );

  const performTableDestructive = useCallback(async () => {
    if (!conn || !tableConfirm) return;
    const sql =
      tableConfirm.kind === "drop"
        ? buildDropSql(tableConfirm.tableNames)
        : buildTruncateSql(tableConfirm.tableNames);
    try {
      await db.runQuery(conn.id, sql);
      toast.success(
        `${tableConfirm.kind === "drop" ? "Dropped" : "Truncated"} ${tableConfirm.tableNames.length} ${tableConfirm.tableNames.length === 1 ? "table" : "tables"}`,
      );
      tableSelection.clearSelection();
      // Trigger the same refresh path that ⌘+R uses so the sidebar
      // re-fetches schemas/views/routines after the structural change.
      window.dispatchEvent(new CustomEvent("tablerelay:reload"));
    } catch (err) {
      toast.error(
        `${tableConfirm.kind === "drop" ? "Drop" : "Truncate"} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [buildDropSql, buildTruncateSql, conn, tableConfirm, tableSelection]);

  const requestDropSelected = useCallback(
    (triggerName?: string) => {
      const names =
        tableSelection.selectedIds.size > 0 &&
        (triggerName === undefined ||
          tableSelection.selectedIds.has(triggerName))
          ? [...tableSelection.selectedIds]
          : triggerName
            ? [triggerName]
            : [];
      if (names.length === 0) return;
      setTableConfirm({ kind: "drop", tableNames: names });
    },
    [tableSelection],
  );

  const requestTruncateSelected = useCallback(
    (triggerName?: string) => {
      const names =
        tableSelection.selectedIds.size > 0 &&
        (triggerName === undefined ||
          tableSelection.selectedIds.has(triggerName))
          ? [...tableSelection.selectedIds]
          : triggerName
            ? [triggerName]
            : [];
      if (names.length === 0) return;
      setTableConfirm({ kind: "truncate", tableNames: names });
    },
    [tableSelection],
  );

  const handleTableRowClick = useCallback(
    (e: React.MouseEvent, name: string) => {
      // Ensure the keyboard container is focused so subsequent arrow / Enter
      // / Cmd+Delete keys reach our handler. Without this, modifier-clicks
      // would change selection silently and the user would have to click
      // again before keyboard nav worked.
      tablesContainerRef.current?.focus();
      const intent = getClickIntent(e);
      switch (intent.kind) {
        case "open":
          tableSelection.selectOnly(name);
          if (conn) onOpenTable(conn.id, schemaForActions, name);
          break;
        case "toggle":
          tableSelection.toggleSelection(name);
          break;
        case "range":
          tableSelection.selectRange(name);
          break;
        case "context":
          if (!tableSelection.selectedIds.has(name))
            tableSelection.selectOnly(name);
          break;
      }
    },
    [conn, onOpenTable, schemaForActions, tableSelection],
  );

  const handleTableRowContextMenu = useCallback(
    (name: string) => {
      if (!tableSelection.selectedIds.has(name))
        tableSelection.selectOnly(name);
    },
    [tableSelection],
  );

  const moveTableFocus = useCallback(
    (direction: "up" | "down") => {
      const ids = orderedTableIds();
      if (ids.length === 0) return;
      const current =
        tableSelection.focusedId ?? tableSelection.anchorId ?? ids[0];
      const idx = ids.indexOf(current);
      const nextIdx =
        direction === "up"
          ? Math.max(0, idx - 1)
          : Math.min(ids.length - 1, idx + 1);
      tableSelection.selectOnly(ids[nextIdx]);
    },
    [orderedTableIds, tableSelection],
  );

  const handleTablesKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const intent = getKeyIntent(e);
      if (!intent) return;

      switch (intent.kind) {
        case "escape":
          if (tableSelection.selectedIds.size > 0) {
            e.preventDefault();
            tableSelection.clearSelection();
          }
          break;
        case "open":
          if (tableSelection.focusedId && conn) {
            e.preventDefault();
            onOpenTable(conn.id, schemaForActions, tableSelection.focusedId);
          }
          break;
        case "move":
          if (intent.direction === "up" || intent.direction === "down") {
            e.preventDefault();
            moveTableFocus(intent.direction);
          }
          break;
        case "extend":
          if (tableSelection.focusedId) {
            e.preventDefault();
            const ids = orderedTableIds();
            const idx = ids.indexOf(tableSelection.focusedId);
            const nextIdx =
              intent.direction === "up"
                ? Math.max(0, idx - 1)
                : Math.min(ids.length - 1, idx + 1);
            tableSelection.selectRange(ids[nextIdx]);
          }
          break;
        case "select-all":
          e.preventDefault();
          tableSelection.selectAll(orderedTableIds());
          break;
        case "copy":
          if (tableSelection.selectedIds.size > 0) {
            e.preventDefault();
            const names = orderedTableIds().filter((id) =>
              tableSelection.selectedIds.has(id),
            );
            void navigator.clipboard.writeText(names.join("\n"));
            toast.success(
              `Copied ${names.length} ${names.length === 1 ? "name" : "names"}`,
            );
          }
          break;
        case "remove-view":
          // Plain Delete in the table list is intentionally a no-op. The
          // table list's "view" is the database itself — there's nothing
          // to remove from view without dropping the table. Spec: plain
          // Delete must never reach the database.
          break;
        case "remove-destructive":
          if (supportsDropTable && tableSelection.selectedIds.size > 0) {
            e.preventDefault();
            requestDropSelected();
          }
          break;
        case "refresh":
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("tablerelay:reload"));
          break;
      }
    },
    [
      conn,
      moveTableFocus,
      onOpenTable,
      orderedTableIds,
      requestDropSelected,
      schemaForActions,
      supportsDropTable,
      tableSelection,
    ],
  );

  // Helpers for deciding whether a sidebar row matches the active tab.
  // Scoped to the connection + database the sidebar is currently showing,
  // so pins on different servers / databases can't falsely highlight.
  const matchesActive = (
    type: "table" | "view" | "routine",
    name: string,
    routineKind?: "function" | "procedure",
  ): boolean => {
    if (!activeItem || !conn || !selectedDb) return false;
    if (activeItem.connectionId !== conn.id) return false;
    if (activeItem.schema !== schemaForActions) return false;
    if (activeItem.type !== type) return false;
    if (activeItem.name !== name) return false;
    if (
      type === "routine" &&
      routineKind &&
      activeItem.routineKind !== routineKind
    )
      return false;
    return true;
  };

  // Shared classes for sidebar rows. When a row is active we swap hover
  // colors for solid primary accents so the selection is obvious at a glance.
  const rowCls = (active: boolean) =>
    `w-full text-left pl-7 pr-2 py-1 flex items-center gap-2 rounded-md text-sm transition-colors group ${
      active
        ? "bg-primary/15 text-primary font-medium"
        : "hover:bg-primary/10 hover:text-primary"
    }`;
  const iconCls = (active: boolean) =>
    `w-3.5 h-3.5 shrink-0 ${active ? "text-primary" : "text-muted-foreground group-hover:text-primary"}`;

  // Fetch the DDL for a view / routine via `SHOW CREATE ...` and hand it to
  // the workspace to open as a pre-filled editor tab. We scaffold the output
  // as `CREATE OR REPLACE` (views) or `DROP + CREATE` wrapped in DELIMITER
  // directives (routines) so the user can just hit Run to apply edits.
  const pickDdlColumn = (
    columns: { name: string }[],
    label: string,
  ): number => {
    const target = label.toLowerCase();
    return columns.findIndex((c) => c.name.toLowerCase() === target);
  };

  const openViewDefinition = async (
    connectionId: string,
    dbName: string,
    viewName: string,
  ) => {
    try {
      // No row limit — `SHOW CREATE` rejects a trailing `LIMIT`.
      const res = await db.runQuery(
        connectionId,
        `SHOW CREATE VIEW \`${dbName}\`.\`${viewName}\``,
      );
      const last = res.statements[res.statements.length - 1];
      if (!last || last.error)
        throw new Error(last?.error ?? "no definition returned");
      const idx = pickDdlColumn(last.columns, "Create View");
      const ddl = idx >= 0 ? last.rows[0]?.[idx] : null;
      if (typeof ddl !== "string")
        throw new Error("definition not found in response");
      // MySQL returns `CREATE ALGORITHM=... DEFINER=... VIEW ... AS ...`.
      const editable = ddl.replace(/^CREATE\s+/i, "CREATE OR REPLACE ");
      onOpenDefinition(
        connectionId,
        `view:${dbName}.${viewName}`,
        viewName,
        `USE \`${dbName}\`;\n\n${editable};\n`,
      );
    } catch (err) {
      toast.error(
        `Could not load view: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const openRoutineDefinition = async (
    connectionId: string,
    dbName: string,
    routineName: string,
    kind: string,
  ) => {
    const k = kind.toUpperCase() === "FUNCTION" ? "FUNCTION" : "PROCEDURE";
    try {
      const res = await db.runQuery(
        connectionId,
        `SHOW CREATE ${k} \`${dbName}\`.\`${routineName}\``,
      );
      const last = res.statements[res.statements.length - 1];
      if (!last || last.error)
        throw new Error(last?.error ?? "no definition returned");
      const idx = pickDdlColumn(
        last.columns,
        `Create ${k.charAt(0) + k.slice(1).toLowerCase()}`,
      );
      const ddl = idx >= 0 ? last.rows[0]?.[idx] : null;
      if (typeof ddl !== "string")
        throw new Error("definition not found in response");
      // Routines have `;` inside their body, so wrap in DELIMITER directives
      // (our splitter handles them client-side) and scaffold a DROP + CREATE
      // so Run replaces the routine atomically.
      const editable = [
        `USE \`${dbName}\`;`,
        "",
        `DROP ${k} IF EXISTS \`${routineName}\`;`,
        "",
        "DELIMITER //",
        `${ddl}//`,
        "DELIMITER ;",
        "",
      ].join("\n");
      onOpenDefinition(
        connectionId,
        `${k.toLowerCase()}:${dbName}.${routineName}`,
        routineName,
        editable,
      );
    } catch (err) {
      toast.error(
        `Could not load ${k.toLowerCase()}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (!conn) {
    return (
      <div className="w-64 shrink-0 flex flex-col bg-sidebar-bg/50 h-full border-r border-border items-center justify-center gap-3 text-xs text-muted-foreground px-6 text-center">
        <div>Connect to a server to start.</div>
        {connections.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConnectPickerOpen(true)}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" /> Open connection
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onOpenNewServer}>
            <Plus className="w-3.5 h-3.5 mr-1.5" /> New server
          </Button>
        )}
        <ConnectPickerDialog
          open={connectPickerOpen}
          onOpenChange={setConnectPickerOpen}
          connections={connections}
          onConnect={onPickConnection}
          onEditConnection={onEditConnection}
          onDeleteConnection={onDeleteConnection}
        />
      </div>
    );
  }

  const toggle = (k: SectionKey) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  return (
    <div className="w-64 shrink-0 flex flex-col bg-sidebar-bg/50 h-full border-r border-border">
      {/* Quick-action toolbar */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50"
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Open connection"
          aria-label="Open connection"
          onClick={() => setConnectPickerOpen(true)}
        >
          <Server className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Change database"
          aria-label="Change database"
          onClick={() => setDbPickerOpen(true)}
        >
          <Database className="w-4 h-4" />
        </Button>
        {supportsProcessList && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Processes"
            aria-label="Processes"
            onClick={() => setProcessListOpen(true)}
          >
            <Activity className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Header: server + database dropdown */}
      <div className="px-3 pt-3 pb-2 border-b border-border/50">
        <div className="group flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-md bg-muted/60 flex items-center justify-center shrink-0">
            <DbIcon driver={conn.driver} className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">
              {conn.name}
              {selectedDb && (
                <>
                  <span className="text-muted-foreground mx-1">·</span>
                  <span>{toTitleCaseLabel(selectedDb)}</span>
                </>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {conn.driver} · {conn.host}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
                >
                  <MoreVertical className="w-3.5 h-3.5" />
                </Button>
              )}
            />
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={() => setDbPickerOpen(true)}>
                <Database className="w-4 h-4 mr-2" /> Change database
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onNewQuery(conn.id)}>
                <Plus className="w-4 h-4 mr-2" /> New query
              </DropdownMenuItem>
              {selectedDb && supportsDiagram && (
                <DropdownMenuItem
                  onClick={() => onOpenErd(conn.id, schemaForActions)}
                >
                  <Waypoints className="w-4 h-4 mr-2" /> Generate ER diagram
                </DropdownMenuItem>
              )}
              {supportsRealtime && onOpenRealtime && (
                <DropdownMenuItem onClick={() => onOpenRealtime(conn.id)}>
                  <Radio className="w-4 h-4 mr-2" /> Realtime
                </DropdownMenuItem>
              )}
              {supportsProcessList && (
                <DropdownMenuItem onClick={() => setProcessListOpen(true)}>
                  <Activity className="w-4 h-4 mr-2" /> Processes
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onOpenNewServer}>
                <Plus className="w-4 h-4 mr-2" /> New server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <DatabasePickerDialog
        open={dbPickerOpen}
        onOpenChange={setDbPickerOpen}
        connection={conn}
        onPick={(name) => {
          if (!conn) return;
          onPinDatabase(conn.id, name);
        }}
      />

      <ConnectPickerDialog
        open={connectPickerOpen}
        onOpenChange={setConnectPickerOpen}
        connections={connections}
        onConnect={onPickConnection}
        onEditConnection={onEditConnection}
        onDeleteConnection={onDeleteConnection}
      />

      <ConnectionManagerDialog
        open={connManagerOpen}
        onOpenChange={setConnManagerOpen}
        connections={connections}
        onConnect={onPickConnection}
        onEditConnection={onEditConnection}
        onDeleteConnection={onDeleteConnection}
        onCreateNew={onOpenNewServer}
      />

      {conn && processListOpen && (
        <ProcessListPanel
          open={processListOpen}
          onOpenChange={setProcessListOpen}
          connectionId={conn.id}
        />
      )}

      {/* Filter */}
      <div className="px-3 py-2 border-b border-border/50">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter…"
            className="pl-7 h-7 text-xs bg-muted/50 border-none focus-visible:ring-1"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Body: Tables / Views / Routines */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-2 space-y-1 px-1">
          {/* Connect-failed state. The rail tile keeps its focus on a profile
              even when the connect attempt fails, so without this the sidebar
              silently shows an empty table list — which looks like every
              section is collapsed. Surface the real reason + a Retry button
              so the user knows something went wrong and can recover without
              clicking back through the rail. */}
          {conn && !isConnected && !isConnecting && connectError && (
            <div className="px-4 py-6 flex flex-col items-center gap-3 text-center">
              <AlertCircle className="w-6 h-6 text-destructive" />
              <div className="text-xs font-medium">
                Couldn't connect to {conn.name}
              </div>
              <div className="text-[11px] text-muted-foreground wrap-break-word whitespace-pre-wrap max-w-full">
                {connectError}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRetryConnect}
                disabled={retrying}
              >
                {retrying ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    Retrying…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    Retry
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Connecting / pre-connect — show a list skeleton (with a small
              caption) instead of a bare spinner so the panel reads as content
              loading. This covers BOTH the in-flight connect (`isConnecting`)
              AND the async-boot gap on reload where the focused profile has
              resolved but the reconnect hasn't started yet — so the connection
              is not in `activeById` (isConnected=false), not in `connectingIds`
              (isConnecting=false), and has no error. Without the second case
              none of the branches matched and the body rendered blank. */}
          {conn && !isConnected && !connectError && (
            <>
              <div className="px-4 pt-2 pb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Connecting to {conn.name}…</span>
              </div>
              <SidebarListSkeleton />
            </>
          )}

          {/* Post-connect schema fetch. `connectAndLoad` fires
              `refreshSchemas` without awaiting, so the connection flips
              to "active" before the sidebar has anything to render.
              We show the spinner whenever the loading flag is set OR
              schema loading has not completed for this connection —
              that covers the tiny window between "connected" and
              "refreshSchemas started" without mistaking a completed
              empty Redis/key-value database for an in-flight load.
              Once schemas land, we also keep the spinner if the user
              has selected a db whose tables/views/routines are still
              in flight (`loadingExtras`). */}
          {conn &&
            isConnected &&
            (isLoadingSchemas || (!hasLoadedSchemas && schemas.length === 0) || showLoadingFloor) && (
              <>
                <div className="px-4 pt-2 pb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Loading schemas…</span>
                </div>
                <SidebarListSkeleton />
              </>
            )}

          {conn &&
            isConnected &&
            hasLoadedSchemas &&
            schemas.length === 0 &&
            !isLoadingSchemas &&
            !showLoadingFloor && (
              <div className="px-4 py-6 flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
                <Database className="w-6 h-6 opacity-60" />
                <div>No databases with browsable data found.</div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void refreshSchemas(conn.id)}
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
                </Button>
              </div>
            )}

          {isConnected &&
            !selectedDb &&
            !isLoadingSchemas &&
            schemas.length > 0 &&
            !showLoadingFloor && (
              <div className="px-4 py-6 flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
                <div>Pick a database to start browsing.</div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDbPickerOpen(true)}
                >
                  <Database className="w-3.5 h-3.5 mr-1.5" /> Choose database
                </Button>
              </div>
            )}

          {isConnected &&
            selectedDb &&
            schemas.length > 0 &&
            !isLoadingSchemas &&
            !showLoadingFloor && (
              <>
                <Section
                  label={entityNoun}
                  count={fTables.length}
                  collapsed={collapsed.tables}
                  onToggle={() => toggle("tables")}
                  onRefresh={() => void refreshTables()}
                  refreshing={refreshingSection === "tables"}
                  onAdd={
                    onNewTable
                      ? () => onNewTable(conn.id, schemaForActions)
                      : undefined
                  }
                  addTitle={isDocumentStore ? "New collection" : "New table"}
                />
                {!collapsed.tables && (
                  <div
                    ref={tablesContainerRef}
                    onKeyDown={handleTablesKeyDown}
                    tabIndex={-1}
                    role="listbox"
                    aria-multiselectable="true"
                    aria-label="Tables"
                    className="outline-none"
                  >
                    {fTables.map((t) => {
                      const active = matchesActive("table", t.name);
                      const isSelected = tableSelection.selectedIds.has(t.name);
                      const isFocused = tableSelection.focusedId === t.name;
                      const inMultiSelection =
                        isSelected && tableSelection.selectedIds.size > 1;
                      const selectionCount = tableSelection.selectedIds.size;
                      return (
                        <ContextMenu key={`t-${t.name}`}>
                          <ContextMenuTrigger>
                            <div
                              role="option"
                              aria-selected={isSelected}
                              data-focused={isFocused || undefined}
                              tabIndex={-1}
                              className={
                                rowCls(active) +
                                (isSelected && !active
                                  ? " bg-primary/10"
                                  : "") +
                                (isFocused
                                  ? " ring-1 ring-inset ring-primary/40"
                                  : "")
                              }
                              onClick={(e) => handleTableRowClick(e, t.name)}
                              onContextMenu={() =>
                                handleTableRowContextMenu(t.name)
                              }
                            >
                              <TableIcon className={iconCls(active)} />
                              <span className="flex-1 truncate">{t.name}</span>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-52">
                            <ContextMenuItem
                              onClick={() =>
                                onOpenTable(conn.id, schemaForActions, t.name)
                              }
                            >
                              Open data
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() =>
                                onOpenStructure(
                                  conn.id,
                                  schemaForActions,
                                  t.name,
                                )
                              }
                            >
                              Open Schema
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => onNewQuery(conn.id, t.name)}
                            >
                              New query
                            </ContextMenuItem>
                            {supportsDiagram && (
                              <>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  onClick={() =>
                                    onOpenErd(conn.id, schemaForActions, t.name)
                                  }
                                >
                                  View ER diagram
                                </ContextMenuItem>
                              </>
                            )}
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() => {
                                const names = inMultiSelection
                                  ? [...tableSelection.selectedIds]
                                  : [t.name];
                                void navigator.clipboard.writeText(
                                  names.join("\n"),
                                );
                                toast.success(
                                  names.length === 1
                                    ? "Name copied"
                                    : `Copied ${names.length} names`,
                                );
                              }}
                            >
                              {inMultiSelection
                                ? `Copy ${selectionCount} names`
                                : "Copy name"}
                            </ContextMenuItem>
                            {supportsDdl && (
                              <>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  onClick={() =>
                                    requestTruncateSelected(t.name)
                                  }
                                >
                                  {inMultiSelection
                                    ? `Truncate ${selectionCount} tables…`
                                    : "Truncate table…"}
                                </ContextMenuItem>
                                {supportsDropTable && (
                                  <ContextMenuItem
                                    onClick={() => requestDropSelected(t.name)}
                                  >
                                    {inMultiSelection
                                      ? `Drop ${selectionCount} tables…`
                                      : "Drop table…"}
                                  </ContextMenuItem>
                                )}
                              </>
                            )}
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                  </div>
                )}

                {supportsViews && (
                  <Section
                    label="views"
                    count={fViews.length}
                    loading={loadingExtras && views.length === 0}
                    collapsed={collapsed.views}
                    onToggle={() => toggle("views")}
                    onRefresh={() => void refreshViews()}
                    refreshing={refreshingSection === "views"}
                    onAdd={
                      onNewView
                        ? () => onNewView(conn.id, schemaForActions)
                        : undefined
                    }
                    addTitle="New view"
                  />
                )}
                {supportsViews &&
                  !collapsed.views &&
                  fViews.map((v) => {
                    const active = matchesActive("view", v.name);
                    return (
                      <ContextMenu key={`v-${v.name}`}>
                        <ContextMenuTrigger>
                          <button
                            className={rowCls(active)}
                            onClick={() =>
                              void openViewDefinition(
                                conn.id,
                                schemaForActions,
                                v.name,
                              )
                            }
                          >
                            <LayoutTemplate className={iconCls(active)} />
                            <span className="flex-1 truncate">{v.name}</span>
                            {v.isUpdatable && (
                              <span className="text-[9px] text-muted-foreground/70">
                                upd
                              </span>
                            )}
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-48">
                          <ContextMenuItem
                            onClick={() =>
                              onOpenTable(conn.id, schemaForActions, v.name)
                            }
                          >
                            Open data
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              void openViewDefinition(
                                conn.id,
                                schemaForActions,
                                v.name,
                              )
                            }
                          >
                            Edit definition
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              onOpenStructure(conn.id, schemaForActions, v.name)
                            }
                          >
                            Open Schema
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}

                {supportsRoutines && (
                  <Section
                    label="routines"
                    count={fRoutines.length}
                    loading={loadingExtras && routines.length === 0}
                    collapsed={collapsed.routines}
                    onToggle={() => toggle("routines")}
                    onRefresh={() => void refreshRoutines()}
                    refreshing={refreshingSection === "routines"}
                    onAdd={
                      onNewRoutine
                        ? () =>
                            onNewRoutine(conn.id, schemaForActions, "function")
                        : undefined
                    }
                    addTitle="New function"
                  />
                )}
                {supportsRoutines &&
                  !collapsed.routines &&
                  fRoutines.map((r) => {
                    const sig = r.parameters
                      .map((p) => `${p.mode ?? "IN"} ${p.name}:${p.dataType}`)
                      .join(", ");
                    const ret = r.returns ? ` → ${r.returns}` : "";
                    const tooltip = `${r.kind}(${sig})${ret}`;
                    const routineKind = (
                      r.kind.toLowerCase() === "function"
                        ? "function"
                        : "procedure"
                    ) as "function" | "procedure";
                    const active = matchesActive(
                      "routine",
                      r.name,
                      routineKind,
                    );
                    return (
                      <ContextMenu key={`r-${r.name}`}>
                        <ContextMenuTrigger>
                          <button
                            className={rowCls(active)}
                            title={tooltip}
                            onClick={() => {
                              if (onOpenRoutine)
                                onOpenRoutine(
                                  conn.id,
                                  schemaForActions,
                                  r.name,
                                  routineKind,
                                );
                              else
                                void openRoutineDefinition(
                                  conn.id,
                                  schemaForActions,
                                  r.name,
                                  r.kind,
                                );
                            }}
                          >
                            <FunctionSquare className={iconCls(active)} />
                            <span className="flex-1 truncate">{r.name}</span>
                            <span
                              className={`text-[9px] ${active ? "text-primary/70" : "text-muted-foreground/70"}`}
                            >
                              {r.kind}
                            </span>
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-48">
                          <ContextMenuItem
                            onClick={() => {
                              const k = (
                                r.kind.toLowerCase() === "function"
                                  ? "function"
                                  : "procedure"
                              ) as "function" | "procedure";
                              if (onOpenRoutine)
                                onOpenRoutine(
                                  conn.id,
                                  schemaForActions,
                                  r.name,
                                  k,
                                );
                              else
                                void openRoutineDefinition(
                                  conn.id,
                                  schemaForActions,
                                  r.name,
                                  r.kind,
                                );
                            }}
                          >
                            Edit definition
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              void openRoutineDefinition(
                                conn.id,
                                schemaForActions,
                                r.name,
                                r.kind,
                              )
                            }
                          >
                            Edit as SQL
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => {
                              const call =
                                r.kind === "function"
                                  ? `SELECT \`${schemaForActions}\`.\`${r.name}\`(${r.parameters.map(() => "?").join(", ")});`
                                  : `CALL \`${schemaForActions}\`.\`${r.name}\`(${r.parameters.map(() => "?").join(", ")});`;
                              onNewQuery(conn.id, r.name);
                              void navigator.clipboard.writeText(call);
                              toast.success("Call copied to clipboard");
                            }}
                          >
                            New query + copy call
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => {
                              void navigator.clipboard.writeText(r.name);
                              toast.success("Name copied");
                            }}
                          >
                            Copy name
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}

                {fTables.length === 0 &&
                  fViews.length === 0 &&
                  fRoutines.length === 0 && (
                    <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                      {filter ? "No matches." : "Database is empty."}
                    </div>
                  )}
              </>
            )}
        </div>
      </ScrollArea>

      <DestructiveConfirmDialog
        open={tableConfirm !== null}
        onOpenChange={(o) => {
          if (!o) setTableConfirm(null);
        }}
        action={tableConfirm?.kind === "truncate" ? "Truncate" : "Drop"}
        itemNoun="table"
        itemNames={tableConfirm?.tableNames ?? []}
        context={schemaForActions ? `in ${schemaForActions}` : undefined}
        warning={
          tableConfirm?.kind === "truncate"
            ? "All rows will be removed. This cannot be undone."
            : "The table and all its data will be removed. This cannot be undone."
        }
        onConfirm={() => {
          void performTableDestructive();
        }}
      />
    </div>
  );
}

function Section({
  label,
  count,
  loading,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  onRefresh,
  refreshing,
}: {
  label: string;
  count: number;
  loading?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** Optional create-new action shown as a `+` on the right of the row. */
  onAdd?: () => void;
  addTitle?: string;
  /** Optional re-sync action shown as a refresh icon on hover. */
  onRefresh?: () => void;
  /** Spin the refresh icon while this section's list is being refetched. */
  refreshing?: boolean;
}) {
  return (
    <div className="group/section w-full flex items-center gap-1 px-2 py-1 text-[11px] tracking-wide text-muted-foreground hover:text-foreground transition-colors">
      <button
        onClick={onToggle}
        className="flex items-center gap-1 flex-1 min-w-0 text-left"
      >
        <ChevronDown
          className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        {/* `capitalize` title-cases the single-word section labels
            (tables → Tables) without touching the call sites. */}
        <span className="truncate capitalize">{label}</span>
      </button>
      {onRefresh && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!refreshing) onRefresh();
          }}
          title={`Refresh ${label}`}
          disabled={refreshing}
          className={`p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity ${
            refreshing
              ? "opacity-100"
              : "opacity-0 group-hover/section:opacity-100"
          }`}
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      )}
      {loading ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <span className="tabular-nums">{count}</span>
      )}
      {onAdd && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          title={addTitle ?? "Add"}
          className="opacity-0 group-hover/section:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
