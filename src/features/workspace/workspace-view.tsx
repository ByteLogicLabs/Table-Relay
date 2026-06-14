import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import {
  ConnectionProfile,
  AppTab,
  DataViewMode,
  QueryLogEntry,
} from "../../types";
import Sidebar from "./sidebar";
import TabsShell from "./tabs-shell";
import ConnectionRail, {
  RAIL_COLLAPSED_WIDTH,
  RAIL_EXPANDED_WIDTH,
} from "../connections/connection-rail";
import ConnectionModal from "../connections/connection-modal";
import ImportSqlDialog from "../connections/import-sql-dialog";
import ConnectionExportDialog from "../connections/connection-export-dialog";
import ChatPanel from "../ai-chat/chat-panel";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  connectAndLoad,
  getActiveDatabase,
  refreshSchemas,
  switchConnectionDatabase,
  useConnections,
} from "../../state/connections";
import {
  useAdapterManifests,
  resolveManifest,
} from "../../state/adapter-manifests";
import { useRail, pinTile, refreshRail, unpinManyTiles } from "../../state/rail";
import type { RailTile } from "../../lib/rail";
import { isDbError } from "../../lib/db";
import { ai } from "../../lib/ai";
import {
  clearCachedGrid,
  clearCachedGridsWhere,
} from "../../state/tab-data-cache";
import { clearQueryResultSnapshot } from "../../state/query-result-cache";
import { setDebugPage } from "../../state/debug";
import { getAppState, setAppState } from "../../lib/app-state-store";
import {
  SIDEBAR_WIDTH,
  CHAT_WIDTH_KEY,
  CHAT_MIN_WIDTH,
  CHAT_MAX_WIDTH,
  CHAT_DEFAULT_WIDTH,
  TABS_STORAGE_KEY,
  ACTIVE_TAB_KEY,
  ACTIVE_TAB_BY_CONN_KEY,
  FOCUSED_TILE_KEY,
  OLD_TABS_STORAGE_KEY,
  OLD_ACTIVE_TAB_KEY,
  OLD_ACTIVE_TAB_BY_CONN_KEY,
  OLD_FOCUSED_TILE_KEY,
  OLD_CHAT_WIDTH_KEY,
} from "./workspace-constants";
import { computeFocusHint, loadLegacyTabs } from "./workspace-utils";

interface WorkspaceViewProps {
  activeConnections: ConnectionProfile[];
  activeConnectionIds: string[];
  onDisconnect: (id: string) => void;
  connections: ConnectionProfile[];
  onConnect: (id: string) => void;
  onAddConnection: (conn: ConnectionProfile) => void | Promise<void>;
  onEditConnection?: (conn: ConnectionProfile, previousId?: string) => void | Promise<void>;
  onDeleteConnection: (id: string) => void | Promise<void>;
}

export default function WorkspaceView({
  activeConnections,
  onDisconnect,
  connections,
  onConnect,
  onAddConnection,
  onEditConnection,
  onDeleteConnection,
}: WorkspaceViewProps) {
  const workspaceStateHydrated = useRef(false);
  const [tabs, setTabs] = useState<AppTab[]>([]);
  // De-dup + stable-closure refs for the AI `open_object_tab` handler. Declared
  // up front so the handler (a const further down) and its listener effect can
  // both reference them regardless of declaration order.
  const handledOpenObjectRef = useRef<Set<string>>(new Set());
  const openObjectTabRef = useRef<
    (e: {
      toolCallId?: string;
      connectionId?: string;
      object: "trigger" | "table";
      name?: string | null;
      schema?: string;
      sql?: string | null;
    }) => void
  >(() => {});
  // Per-connection active-tab map: each connection remembers its own last
  // active tab, so switching between connections never steals tab focus from
  // the other. Legacy single-id value is read once and folded into the map.
  const [activeTabByConn, setActiveTabByConn] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [
        storedTabs,
        storedActiveByConn,
        storedFocusedTile,
        storedChatWidth,
      ] = await Promise.all([
        getAppState<AppTab[]>(TABS_STORAGE_KEY).catch(() => null),
        getAppState<Record<string, string>>(ACTIVE_TAB_BY_CONN_KEY).catch(
          () => null,
        ),
        getAppState<string>(FOCUSED_TILE_KEY).catch(() => null),
        getAppState<number>(CHAT_WIDTH_KEY).catch(() => null),
      ]);
      if (cancelled) return;

      const nextTabs = Array.isArray(storedTabs)
        ? storedTabs.filter(
            (t): t is AppTab =>
              t &&
              typeof t.id === "string" &&
              typeof t.title === "string" &&
              typeof t.type === "string" &&
              typeof t.connectionId === "string",
          )
        : loadLegacyTabs();
      setTabs(nextTabs);

      if (
        storedActiveByConn &&
        typeof storedActiveByConn === "object" &&
        !Array.isArray(storedActiveByConn)
      ) {
        setActiveTabByConn(storedActiveByConn);
      } else {
        try {
          const raw =
            window.localStorage.getItem(ACTIVE_TAB_BY_CONN_KEY) ??
            window.localStorage.getItem(OLD_ACTIVE_TAB_BY_CONN_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              setActiveTabByConn(parsed as Record<string, string>);
            }
          } else {
            const legacy =
              window.localStorage.getItem(ACTIVE_TAB_KEY) ??
              window.localStorage.getItem(OLD_ACTIVE_TAB_KEY);
            const owner = legacy
              ? nextTabs.find((t) => t.id === legacy)
              : undefined;
            if (owner) setActiveTabByConn({ [owner.connectionId]: legacy! });
          }
        } catch {
          /* noop */
        }
      }

      if (storedFocusedTile) {
        setFocusedTileId(storedFocusedTile);
      } else {
        try {
          const legacyFocusedTile =
            window.localStorage.getItem(FOCUSED_TILE_KEY) ??
            window.localStorage.getItem(OLD_FOCUSED_TILE_KEY);
          if (legacyFocusedTile) setFocusedTileId(legacyFocusedTile);
        } catch {
          /* noop */
        }
      }

      if (
        typeof storedChatWidth === "number" &&
        Number.isFinite(storedChatWidth) &&
        storedChatWidth >= CHAT_MIN_WIDTH &&
        storedChatWidth <= CHAT_MAX_WIDTH
      ) {
        setChatWidth(storedChatWidth);
      } else {
        try {
          const raw =
            window.localStorage.getItem(CHAT_WIDTH_KEY) ??
            window.localStorage.getItem(OLD_CHAT_WIDTH_KEY);
          const n = raw ? Number(raw) : NaN;
          if (Number.isFinite(n) && n >= CHAT_MIN_WIDTH && n <= CHAT_MAX_WIDTH)
            setChatWidth(n);
        } catch {
          /* noop */
        }
      }

      try {
        window.localStorage.removeItem(TABS_STORAGE_KEY);
        window.localStorage.removeItem(ACTIVE_TAB_BY_CONN_KEY);
        window.localStorage.removeItem(ACTIVE_TAB_KEY);
        window.localStorage.removeItem(FOCUSED_TILE_KEY);
        window.localStorage.removeItem(CHAT_WIDTH_KEY);
        window.localStorage.removeItem(OLD_TABS_STORAGE_KEY);
        window.localStorage.removeItem(OLD_ACTIVE_TAB_BY_CONN_KEY);
        window.localStorage.removeItem(OLD_ACTIVE_TAB_KEY);
        window.localStorage.removeItem(OLD_FOCUSED_TILE_KEY);
        window.localStorage.removeItem(OLD_CHAT_WIDTH_KEY);
      } catch {
        /* noop */
      }

      workspaceStateHydrated.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist tabs + per-connection active tab so reopening the app lands you
  // back in the same workspace with each connection's tabs intact.
  useEffect(() => {
    if (!workspaceStateHydrated.current) return;
    void setAppState(TABS_STORAGE_KEY, tabs);
  }, [tabs]);
  useEffect(() => {
    if (!workspaceStateHydrated.current) return;
    void setAppState(ACTIVE_TAB_BY_CONN_KEY, activeTabByConn);
  }, [activeTabByConn]);
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  // When the user picks a connection (not a tile), we track it explicitly so
  // the sidebar knows which server to show even before a database is chosen.
  const [focusedConnectionId, setFocusedConnectionId] = useState<string | null>(
    null,
  );
  const [newConnectionOpen, setNewConnectionOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<ConnectionProfile | null>(null);
  const returnToConnectionManagerAfterEdit = useRef(false);
  const connectionsRef = useRef<ConnectionProfile[]>(connections);
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);
  // Grey out the connection-dependent native menu items (Edit Current / Open
  // Database / Import Data / Export Data) whenever no connection is focused.
  // They all act on the focused connection, so on the home screen they would
  // only toast an error — disabling them is the honest affordance.
  useEffect(() => {
    void invoke("set_connection_menu_enabled", {
      enabled: focusedConnectionId != null,
    }).catch(() => {
      /* menu state is best-effort; the listeners still guard with a toast */
    });
  }, [focusedConnectionId]);
  const openEditConnection = (
    connection: ConnectionProfile,
    returnToManager = false,
  ) => {
    returnToConnectionManagerAfterEdit.current = returnToManager;
    setEditingConnection(connection);
  };
  const closeEditConnection = () => {
    setEditingConnection(null);
    if (!returnToConnectionManagerAfterEdit.current) return;
    returnToConnectionManagerAfterEdit.current = false;
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("tablerelay:open-connect-picker"));
    }, 0);
  };
  // Connection id the Import SQL dialog is bound to. `null` = dialog closed.
  const [importSqlForId, setImportSqlForId] = useState<string | null>(null);
  const [exportForId, setExportForId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState<number>(CHAT_DEFAULT_WIDTH);
  useEffect(() => {
    if (!workspaceStateHydrated.current) return;
    void setAppState(CHAT_WIDTH_KEY, chatWidth);
  }, [chatWidth]);
  const [railExpanded, setRailExpanded] = useState(false);

  // Any view with a toolbar (data-grid, sql-editor, etc.) can ask to toggle
  // the chat panel by dispatching `tablerelay:toggle-chat`. Keeps each view
  // free of chat-panel wiring — they just fire the event.
  useEffect(() => {
    const onToggle = () => setChatOpen((o) => !o);
    // Fix / Explain / Generate shortcuts force the panel open — the panel
    // itself listens to the same event for the prefill payload.
    const onPrefill = () => setChatOpen(true);
    window.addEventListener("tablerelay:toggle-chat", onToggle);
    window.addEventListener("tablerelay:ai-prefill", onPrefill);
    return () => {
      window.removeEventListener("tablerelay:toggle-chat", onToggle);
      window.removeEventListener("tablerelay:ai-prefill", onPrefill);
    };
  }, []);

  // Listen for AI tool query executions and log them.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen: tauriListen }) => {
      tauriListen<{
        connection_id: string;
        statement: string;
        source: string;
        duration_ms: number;
        status: string;
        message: string | null;
      }>("ai://query_log", (ev) => {
        appendQueryLog({
          connectionId: ev.payload.connection_id,
          statement: ev.payload.statement,
          source: "ai" as any,
          durationMs: ev.payload.duration_ms,
          status: ev.payload.status as any,
          message: ev.payload.message ?? undefined,
        });
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Native menu → webview bridge. The Rust side emits `menu:file.*` Tauri
  // events when the user clicks an item in the File menu; we translate
  // into the app's existing dialog state + custom DOM events so the
  // menu and the in-app buttons share one code path.
  const menuCtxRef = useRef<{
    focusedConnectionId: string | null;
    activeTabId: string | null;
    focusedSupportsImport: boolean;
    activeTabSupportsExport: boolean;
    closeActiveTab: () => void;
  }>({
    focusedConnectionId: null,
    activeTabId: null,
    focusedSupportsImport: true,
    activeTabSupportsExport: true,
    closeActiveTab: () => {},
  });
  const adapterManifests = useAdapterManifests();
  useEffect(() => {
    // Tauri event names are plain `menu-file-<action>` — kebab-case,
    // no `:` / `.` which can trigger silent routing failures on some
    // Tauri versions. Backend emits under the same shape.
    const unlistenImport = listen<void>("menu-file-import", () => {
      const id = menuCtxRef.current.focusedConnectionId;
      if (!id) {
        toast.error("Open a connection before importing");
        return;
      }
      if (!menuCtxRef.current.focusedSupportsImport) {
        toast.error("This connection's adapter doesn't support import");
        return;
      }
      setImportSqlForId(id);
    });
    const unlistenExport = listen<void>("menu-file-export", () => {
      const tid = menuCtxRef.current.activeTabId;
      if (!tid) {
        toast.error("Open a table before exporting");
        return;
      }
      if (!menuCtxRef.current.activeTabSupportsExport) {
        toast.error("This connection's adapter doesn't support export");
        return;
      }
      // Data-grid listens for this on its own tab id.
      window.dispatchEvent(
        new CustomEvent("tablerelay:menu-export", { detail: { tabId: tid } }),
      );
    });
    // ⌘W / Ctrl+W (and File → Close Tab) closes the active tab. The native
    // accelerator routes here instead of the old `close_window` item that quit
    // the whole app. No-op when no tab is open (the window stays put).
    const unlistenCloseTab = listen<void>("menu-file-close_tab", () => {
      menuCtxRef.current.closeActiveTab();
    });
    // AI → AI Chat (⌘⇧A) opens the chat panel.
    const unlistenAiChat = listen<void>("menu-ai-chat", () => {
      setChatOpen(true);
    });
    const unlistenConnectionPicker = listen<void>(
      "menu-connection-picker",
      () => {
        window.dispatchEvent(
          new CustomEvent("tablerelay:menu-connection-picker"),
        );
      },
    );
    const unlistenConnectionNew = listen<void>("menu-connection-new", () => {
      setNewConnectionOpen(true);
    });
    const unlistenConnectionEditCurrent = listen<void>(
      "menu-connection-edit_current",
      () => {
        const id = menuCtxRef.current.focusedConnectionId;
        if (!id) {
          toast.error("Open a connection before editing it");
          return;
        }
        const conn = connectionsRef.current.find((c) => c.id === id);
        if (!conn) {
          toast.error("Current connection is not in the saved list");
          return;
        }
        openEditConnection(conn);
      },
    );
    const unlistenConnectionOpenDatabase = listen<void>(
      "menu-connection-open_database",
      () => {
        if (!menuCtxRef.current.focusedConnectionId) {
          toast.error("Open a connection before choosing a database");
          return;
        }
        window.dispatchEvent(new CustomEvent("tablerelay:menu-open-database"));
      },
    );
    // Import / Export connections (menu-connection-transfer) is handled in the
    // always-mounted root (app.tsx) so it also works on the home screen.
    // Database-level import/export for the focused connection.
    const unlistenImportDb = listen<void>("menu-connection-import_db", () => {
      const id = menuCtxRef.current.focusedConnectionId;
      if (!id) {
        toast.error("Open a connection before importing");
        return;
      }
      setImportSqlForId(id);
    });
    const unlistenExportDb = listen<void>("menu-connection-export_db", () => {
      const id = menuCtxRef.current.focusedConnectionId;
      if (!id) {
        toast.error("Open a connection before exporting");
        return;
      }
      setExportForId(id);
    });

    return () => {
      void unlistenImport.then((fn) => fn());
      void unlistenExport.then((fn) => fn());
      void unlistenCloseTab.then((fn) => fn());
      void unlistenAiChat.then((fn) => fn());
      void unlistenConnectionPicker.then((fn) => fn());
      void unlistenConnectionNew.then((fn) => fn());
      void unlistenImportDb.then((fn) => fn());
      void unlistenExportDb.then((fn) => fn());
      void unlistenConnectionEditCurrent.then((fn) => fn());
      void unlistenConnectionOpenDatabase.then((fn) => fn());
    };
  }, []);
  const railWidth = railExpanded ? RAIL_EXPANDED_WIDTH : RAIL_COLLAPSED_WIDTH;
  const chatColumnPx = chatOpen ? chatWidth : 0;
  const contentMaxWidthStyle: CSSProperties = {
    ["--content-max-w" as string]: `calc(100vw - ${railWidth + SIDEBAR_WIDTH + chatColumnPx}px)`,
  };
  const [queryLogs, setQueryLogs] = useState<Record<string, QueryLogEntry[]>>(
    {},
  );

  const connState = useConnections();
  const railState = useRail();
  useEffect(() => {
    void refreshRail();
  }, []);

  const appendQueryLog = (
    entry: Omit<QueryLogEntry, "id" | "timestamp"> & {
      id?: string;
      timestamp?: number;
    },
  ) => {
    const full: QueryLogEntry = {
      id: entry.id ?? crypto.randomUUID(),
      timestamp: entry.timestamp ?? Date.now(),
      ...entry,
    };
    setQueryLogs((prev) => {
      const existing = prev[full.connectionId] ?? [];
      const next = [...existing, full];
      // Keep only the most recent 50 entries per connection. The bottom
      // panel is a "tail" UX anyway — older rows aren't scrollable far
      // in practice, and capping here prevents a long-running Realtime
      // tab (PUBLISH-heavy) from growing the state unboundedly.
      if (next.length > 50) next.splice(0, next.length - 50);
      return { ...prev, [full.connectionId]: next };
    });
  };

  const clearQueryLog = (connectionId: string) => {
    setQueryLogs((prev) => ({ ...prev, [connectionId]: [] }));
  };

  // Persist the focused tile so reopening the app restores the last-opened
  // database. Without this the user was prompted to re-pick a database on
  // every launch even though the pins themselves survived.
  useEffect(() => {
    if (!workspaceStateHydrated.current) return;
    void setAppState(FOCUSED_TILE_KEY, focusedTileId);
  }, [focusedTileId]);

  // Clear focus if the focused tile has been unpinned. If the rail still has
  // other tiles, fall through to the first one so the workspace never sits on
  // an empty picker when we have valid candidates — that's what caused the
  // "still asking to choose database after reload" regression.
  useEffect(() => {
    // Don't hijack focus when the user just explicitly chose a connection
    // without picking a database — `handlePickConnection` deliberately nulls
    // the tile and sets `focusedConnectionId` to prompt for a DB. The earlier
    // auto-pick blindly stole focus back to the first persisted tile and
    // swallowed the "Open connection" action.
    if (!focusedTileId) {
      if (!focusedConnectionId && railState.tiles.length > 0) {
        setFocusedTileId(railState.tiles[0].id);
      }
      return;
    }
    if (!railState.tiles.some((t) => t.id === focusedTileId)) {
      setFocusedTileId(railState.tiles[0]?.id ?? null);
    }
  }, [railState.tiles, focusedTileId, focusedConnectionId]);

  // Sync tabs with the rail: when a tile is unpinned, close any tabs that
  // belong to that (connection, database) pair so the tab strip doesn't hold
  // onto orphaned windows. Tabs without a schema (query tabs tied only to a
  // connection) stay put unless the whole server is gone from the rail too.
  useEffect(() => {
    const pinnedPairs = new Set(
      railState.tiles.map((t) => `${t.serverId}::${t.databaseName}`),
    );
    const pinnedServers = new Set(railState.tiles.map((t) => t.serverId));
    setTabs((prev) => {
      const kept = prev.filter((tab) => {
        // Schema-bound tabs require their (conn, db) pair to still be pinned.
        if (tab.schema)
          return pinnedPairs.has(`${tab.connectionId}::${tab.schema}`);
        // Query tabs (no schema) only require the server to still have any pin.
        return pinnedServers.has(tab.connectionId);
      });
      if (kept.length === prev.length) return prev;
      // Drop any per-connection active-tab entries whose referenced tab was
      // just removed — otherwise the empty state won't render for that conn.
      const keptIds = new Set(kept.map((t) => t.id));
      setActiveTabByConn((map) => {
        const next: Record<string, string> = {};
        for (const [cid, id] of Object.entries(map)) {
          if (keptIds.has(id)) next[cid] = id;
        }
        return next;
      });
      return kept;
    });
    // We only need to re-run this when the rail changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railState.tiles]);

  const focusedTile: RailTile | null =
    railState.tiles.find((t) => t.id === focusedTileId) ?? null;
  // Priority chain so the sidebar never sits on the "no connection" empty
  // state while a connection is actually live:
  //   1. The server behind the focused rail tile.
  //   2. An active connection matching the focused tile's server (for some
  //      reason not in the top-level `connections` list).
  //   3. Any active connection (user just connected, hasn't pinned a DB yet).
  const focusedConnection: ConnectionProfile | null =
    (focusedTile && connections.find((c) => c.id === focusedTile.serverId)) ??
    (focusedTile &&
      activeConnections.find((c) => c.id === focusedTile.serverId)) ??
    (focusedConnectionId &&
      activeConnections.find((c) => c.id === focusedConnectionId)) ??
    (focusedConnectionId &&
      connections.find((c) => c.id === focusedConnectionId)) ??
    activeConnections[0] ??
    null;
  const focusedTileServerId = focusedTile?.serverId ?? null;
  const focusedTileDatabaseName = focusedTile?.databaseName ?? null;
  const focusedConnectionIdForAutoConnect = focusedConnection?.id ?? null;

  // Postgres selects the database at the CONNECTION level: one pool targets one
  // database, and `"public"."t"` resolves against whichever database the pool is
  // bound to. So focusing a different database tile must re-point the pool.
  //
  // NOT keyed on `databasePicker` (MySQL and Mongo set that too): MySQL
  // qualifies every query as `\`db\`.\`tbl\`` and Mongo addresses
  // `client.database(name)` per call, so both already route to the right
  // database from the request and need no pool rebuild. Only Postgres leaks.
  const isConnectionScopedDb = (conn: ConnectionProfile | undefined): boolean =>
    resolveManifest(adapterManifests, conn?.driver)?.capabilities.sqlDialect ===
    "postgres";

  // The PG database a new tab on `connectionId` belongs to, for stamping onto
  // the tab so it stays bound to the right database after a switch. Undefined
  // for non-Postgres (schema already identifies the DB) and when the focused
  // tile isn't this connection (can't infer which DB the caller meant).
  const scopedDbFor = (connectionId: string): string | undefined => {
    const conn = connectionsRef.current.find((c) => c.id === connectionId);
    if (!isConnectionScopedDb(conn)) return undefined;
    return focusedTile?.serverId === connectionId
      ? focusedTile.databaseName
      : undefined;
  };

  useEffect(() => {
    const id = focusedTileServerId;
    if (!id || !focusedConnectionIdForAutoConnect) return;
    if (connState.activeById.has(id)) return;
    if (connState.connectingIds.has(id)) return;
    if (connState.lastErrorById.has(id)) return;

    void (async () => {
      try {
        await connectAndLoad(id);
        // Restore path: the pool opens on the saved profile's default database.
        // For connection-scoped selection (Postgres) the persisted focused tile
        // may name a different database — re-point the pool before its tree
        // loads, or it would show the default database's tables under this tile.
        const target = focusedTileDatabaseName?.trim();
        const conn = connectionsRef.current.find((c) => c.id === id);
        if (target && isConnectionScopedDb(conn)) {
          const active = getActiveDatabase(id);
          if (active == null || active.toLowerCase() !== target.toLowerCase()) {
            await switchConnectionDatabase(id, target);
            await refreshSchemas(id, { silent: true });
          }
        }
      } catch (err) {
        toast.error(isDbError(err) ? err.message : String(err));
      }
    })();
  }, [
    focusedTileServerId,
    focusedTileDatabaseName,
    focusedConnectionIdForAutoConnect,
    connState.activeById,
    connState.connectingIds,
    connState.lastErrorById,
  ]);

  // Tabs are scoped by BOTH connection + database (i.e. the focused rail
  // tile). Two pins on the same server but different databases are different
  // workspaces, so their tab strips must stay independent. The exception is
  // query tabs without a schema — those are tied to the connection only, so
  // we show them regardless of which tile is focused on that server.
  const scopeKey = focusedTile
    ? `${focusedTile.serverId}::${focusedTile.databaseName}`
    : null;
  // For Postgres the rail tile's `databaseName` is the PG *database* (e.g.
  // "Apps"), but tables/tabs are keyed by the SQL *schema* (e.g. "public") —
  // the sidebar resolves the database to an effective schema and opens tabs
  // with THAT. So tab visibility must match against the same resolved schema,
  // not the raw database name, or PG data tabs are filtered out and never show.
  // For MySQL/SQLite schema == database, so this collapses to the tile name.
  const focusedTileEffectiveSchema = useMemo(() => {
    if (!focusedTile) return null;
    const db = focusedTile.databaseName;
    const schemas = connState.schemasById.get(focusedTile.serverId) ?? [];
    if (schemas.length === 0) return db;
    if (schemas.some((s) => s.name === db)) return db;
    const ci = schemas.find((s) => s.name.toLowerCase() === db.toLowerCase());
    if (ci) return ci.name;
    const pub = schemas.find((s) => s.name === "public");
    if (pub) return pub.name;
    const nonEmpty = schemas.find((s) => s.tables.length > 0);
    if (nonEmpty) return nonEmpty.name;
    return schemas[0]?.name ?? db;
  }, [focusedTile, connState.schemasById]);
  // For connection-scoped adapters (Postgres) the focused tile's PG database;
  // undefined elsewhere. Tabs carry the same value so same-named tables in
  // different PG databases (all `public`) don't bleed across tiles.
  const focusedTileScopedDb =
    focusedTile && isConnectionScopedDb(focusedConnection ?? undefined)
      ? focusedTile.databaseName
      : undefined;
  const visibleTabs = focusedConnection
    ? tabs.filter((t) => {
        if (t.connectionId !== focusedConnection.id) return false;
        if (!t.schema) return true; // connection-scoped query tab
        // Postgres: a tab belongs to a specific PG database. Databases all
        // share a `public` schema, so the database must match too — otherwise
        // DB-A's `public.users` tab would surface under DB-B's tile.
        if (focusedTileScopedDb != null) {
          // Object tabs (data/structure/erd/routine/trigger) carry the PG
          // database explicitly post-fix — match it directly.
          if (t.database != null) return t.database === focusedTileScopedDb;
          // Query/import tabs store the PG database in `schema` (they prepend
          // `USE`/scope autocomplete with it), so match the tile's database.
          if (t.type === "query" || t.type === "realtime")
            return t.schema === focusedTileScopedDb;
          // Legacy object tab persisted before databases were tracked: fall
          // back to the effective-schema match so it still shows somewhere.
          return (
            focusedTileEffectiveSchema != null &&
            t.schema === focusedTileEffectiveSchema
          );
        }
        // MySQL/SQLite/Mongo: schema identifies the database.
        return (
          scopeKey === `${t.connectionId}::${t.schema}` ||
          (focusedTileEffectiveSchema != null &&
            t.schema === focusedTileEffectiveSchema)
        );
      })
    : [];
  const storedActive = scopeKey ? activeTabByConn[scopeKey] : undefined;
  // If the stored active tab no longer exists (e.g. closed while another
  // tile was focused) fall back to the first visible tab so the user sees
  // content instead of an empty pane.
  const activeTabId = focusedConnection
    ? storedActive && visibleTabs.some((t) => t.id === storedActive)
      ? storedActive
      : (visibleTabs[0]?.id ?? null)
    : null;
  const setActiveTabId = (id: string | null) => {
    if (!scopeKey) return;
    setActiveTabByConn((prev) => {
      const next = { ...prev };
      if (id) next[scopeKey] = id;
      else delete next[scopeKey];
      return next;
    });
  };

  // Keep the menu-event bridge's ref in sync with the latest render.
  // Native menu callbacks fire outside React's render cycle, so reading
  // via a ref gives them the current values without re-registering the
  // `listen()` handler on every tile / tab switch.
  useEffect(() => {
    menuCtxRef.current.focusedConnectionId = focusedConnection?.id ?? null;
    const focusedManifest = resolveManifest(
      adapterManifests,
      focusedConnection?.driver,
    );
    menuCtxRef.current.focusedSupportsImport = focusedManifest
      ? focusedManifest.capabilities.import.length > 0 ||
        focusedManifest.capabilities.insertRows
      : true;
    // Only surface data tabs to the export handler — exporting makes no
    // sense on query / routine / schema tabs.
    const activeTab = visibleTabs.find((t) => t.id === activeTabId);
    menuCtxRef.current.activeTabId =
      activeTab?.type === "data" ? activeTab.id : null;
    const activeTabConn = activeTab
      ? connections.find((c) => c.id === activeTab.connectionId)
      : null;
    const activeTabManifest = resolveManifest(
      adapterManifests,
      activeTabConn?.driver,
    );
    menuCtxRef.current.activeTabSupportsExport = activeTabManifest
      ? activeTabManifest.capabilities.export.length > 0
      : true;
    // Latest close-active-tab action for the ⌘W / "Close Tab" menu item. Uses
    // the real focused tab id (any type), not the export-scoped one above.
    menuCtxRef.current.closeActiveTab = () => {
      if (activeTabId) handleCloseTab(activeTabId);
    };
  });

  // Re-point a connection-scoped (Postgres) pool at the tile's database before
  // showing its tree. See `isConnectionScopedDb` above for why only Postgres
  // needs this. The rail pins a tile per database; without the re-point the
  // sidebar would show the previously-targeted database's tables under the new
  // tile and browsing/editing would hit the wrong database entirely.
  const ensureTileDatabase = async (tile: RailTile): Promise<void> => {
    const target = tile.databaseName?.trim();
    if (!target) return; // pending placeholder tile — nothing to point at yet
    const conn = connectionsRef.current.find((c) => c.id === tile.serverId);
    if (!isConnectionScopedDb(conn)) return;
    const active = getActiveDatabase(tile.serverId);
    if (active != null && active.toLowerCase() === target.toLowerCase()) return;
    await switchConnectionDatabase(tile.serverId, target);
    // Drop the previous database's cached grid rows so a remount can't read
    // them. (switchConnectionDatabase also fires `tablerelay:reload`, which
    // makes any still-mounted grid refetch against the new pool.)
    const tabIds = new Set(
      tabs.filter((t) => t.connectionId === tile.serverId).map((t) => t.id),
    );
    clearCachedGridsWhere((tid) => tabIds.has(tid));
  };

  const handleFocusTile = (tile: RailTile) => {
    setFocusedTileId(tile.id);
    void (async () => {
      try {
        if (!connState.activeById.has(tile.serverId)) {
          // Not connected yet — connect in the background (skeleton shows via
          // `connectingIds`). Detached so focus is instant, not gated on connect.
          await connectAndLoad(tile.serverId);
          onConnect(tile.serverId);
          // connectAndLoad opens the pool on the saved profile's default
          // database; re-point it at the focused tile's database if different.
          await ensureTileDatabase(tile);
          await refreshSchemas(tile.serverId, { silent: true });
        } else {
          // Already active. Re-point the pool first when the tile names a
          // different database than the pool currently targets, then revalidate.
          // The refresh also issues a real query through `with_retry`, which
          // transparently rebuilds a socket the server dropped while idle
          // (wait_timeout, NAT drop, laptop sleep) — the old ⌘+R-only hang.
          await ensureTileDatabase(tile);
          await refreshSchemas(tile.serverId, { silent: true });
        }
      } catch (err) {
        toast.error(isDbError(err) ? err.message : String(err));
      }
    })();
  };

  // Track pending placeholder tile ids by serverId so handlePinDatabase can
  // reliably find and remove them even when railState hasn't re-rendered yet.
  const pendingPlaceholderIds = useRef<Map<string, string>>(new Map());

  const handlePickConnection = (connectionId: string) => {
    // Pin a placeholder tile immediately so the connection appears in the rail
    // the instant the user clicks — no waiting on the (possibly slow, SSH)
    // connect. databaseName "" marks it as pending; handlePinDatabase replaces
    // it once the user picks a real database.
    void (async () => {
      try {
        const placeholder = await pinTile({ serverId: connectionId, databaseName: '' });
        pendingPlaceholderIds.current.set(connectionId, placeholder.id);
        setFocusedTileId(placeholder.id);
        setFocusedConnectionId(connectionId);
      } catch {
        // Pin failed — fall back to connectionId-only focus so the sidebar
        // still shows the "Connecting…" skeleton.
        setFocusedTileId(null);
        setFocusedConnectionId(connectionId);
      }
    })();

    // Connect in the background. `connectAndLoad` flips `connectingIds` (drives
    // the skeleton) and marks the connection active when ready.
    if (!connState.activeById.has(connectionId)) {
      void (async () => {
        try {
          await connectAndLoad(connectionId);
          onConnect(connectionId);
        } catch (err) {
          toast.error(isDbError(err) ? err.message : String(err));
        }
      })();
    } else {
      void refreshSchemas(connectionId, { silent: true });
    }
  };

  const handlePinDatabase = async (serverId: string, databaseName: string) => {
    try {
      // Remove placeholder tile using the ref (always current) so we catch it
      // even when railState hasn't re-rendered with the new tile yet.
      const refId = pendingPlaceholderIds.current.get(serverId);
      const placeholderIds = refId
        ? [refId]
        : railState.tiles
            .filter((t) => t.serverId === serverId && t.databaseName === '')
            .map((t) => t.id);
      pendingPlaceholderIds.current.delete(serverId);
      if (placeholderIds.length > 0) await unpinManyTiles(placeholderIds);

      const tile = await pinTile({ serverId, databaseName });
      setFocusedTileId(tile.id);
    } catch (err) {
      toast.error(String(err));
    }
  };

  // A data tab's identity includes its PG database (`scopedDbFor`) so the same
  // `public.users` in two PG databases doesn't dedupe to one tab. Undefined for
  // non-PG, where schema already identifies the database.
  const findDataTab = (
    connectionId: string,
    schema: string,
    tableName: string,
    db: string | undefined,
  ): AppTab | undefined =>
    tabs.find(
      (t) =>
        t.type === "data" &&
        t.table === tableName &&
        t.schema === schema &&
        t.connectionId === connectionId &&
        (t.database ?? undefined) === db,
    );

  const handleOpenTable = (
    connectionId: string,
    schema: string,
    tableName: string,
  ) => {
    const db = scopedDbFor(connectionId);
    const existingTab = findDataTab(connectionId, schema, tableName, db);
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      const newTab: AppTab = {
        id: `data-${connectionId}-${db ?? schema}.${tableName}-${Date.now()}`,
        title: tableName,
        type: "data",
        connectionId,
        schema,
        database: db,
        table: tableName,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };

  const handleOpenStructure = (
    connectionId: string,
    schema: string,
    tableName: string,
  ) => {
    // "Open Schema" from the sidebar reuses the table's data tab and flips
    // its internal view mode to 'schema'. That way the user gets one tab per
    // table with Data / Schema / Diagram toggles in the toolbar instead of
    // a separate structure tab duplicating the same SchemaView.
    const db = scopedDbFor(connectionId);
    const existingTab = findDataTab(connectionId, schema, tableName, db);
    if (existingTab) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === existingTab.id ? { ...t, dataViewMode: "schema" } : t,
        ),
      );
      setActiveTabId(existingTab.id);
    } else {
      const newTab: AppTab = {
        id: `data-${connectionId}-${db ?? schema}.${tableName}-${Date.now()}`,
        title: tableName,
        type: "data",
        connectionId,
        schema,
        database: db,
        table: tableName,
        dataViewMode: "schema",
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };

  // Open a loaded SQL file into a new query tab. Used by the Import SQL
  // dialog's "Open in editor" option — the user gets a Monaco editor
  // prefilled with the file contents so they can review/edit before
  // running.
  const handleImportToEditor = (
    connectionId: string,
    fileName: string,
    sql: string,
  ) => {
    const tileDb =
      focusedTile && focusedTile.serverId === connectionId
        ? focusedTile.databaseName
        : undefined;
    const newTab: AppTab = {
      id: `query-import-${connectionId}-${Date.now()}`,
      title: fileName || "Imported SQL",
      type: "query",
      connectionId,
      schema: tileDb,
      query: sql,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  // Export is table-scoped (the export modal lives in the data grid), but the
  // rail / sidebar menus are connection-scoped. Resolve a data tab for the
  // connection — prefer the active one, otherwise the first open data tab —
  // and fire the same `tablerelay:menu-export` event the File menu uses. If no
  // table tab is open we can't know what to export, so tell the user.
  const handleExportForConnection = (connectionId: string) => {
    // Prefer the in-context table export when a data tab for this connection is
    // active (keeps the current filters/columns); otherwise open the
    // connection-level export dialog so no open tab is required.
    const dataTabs = tabs.filter(
      (t) => t.connectionId === connectionId && t.type === "data",
    );
    const active = dataTabs.find((t) => t.id === activeTabId);
    if (active) {
      window.dispatchEvent(
        new CustomEvent("tablerelay:menu-export", { detail: { tabId: active.id } }),
      );
      return;
    }
    setExportForId(connectionId);
  };

  const handleNewQuery = (connectionId: string, tableName?: string) => {
    let initialQuery = "";
    const connection = activeConnections.find((c) => c.id === connectionId);

    if (tableName && connection) {
      // Branch on the manifest's query-editor language, not the driver
      // name — keeps the comment/template right when adapters of new
      // languages get added.
      const manifest = resolveManifest(adapterManifests, connection.driver);
      const lang = manifest?.queryEditor?.language?.trim() ?? "sql";
      if (lang === "mongo") {
        initialQuery = `// Query example for ${tableName}\ndb.getCollection('${tableName}').find({\n  // Add filter conditions here\n}).limit(100);`;
      } else {
        initialQuery = `-- Query example for ${tableName}\nSELECT * FROM ${tableName}\nLIMIT 100;`;
      }
    }

    // Capture the currently-focused database (from the rail) so the editor
    // can prepend `USE` and scope autocomplete even though the connection
    // profile's default database is often blank.
    const tileDb =
      focusedTile && focusedTile.serverId === connectionId
        ? focusedTile.databaseName
        : undefined;

    const newTab: AppTab = {
      id: `query-${connectionId}-${Date.now()}`,
      title: tableName ? `Query: ${tableName}` : "Query",
      type: "query",
      connectionId,
      schema: tileDb,
      query: initialQuery,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewRealtime = (connectionId: string) => {
    // Reuse an existing realtime tab on the same connection instead of
    // stacking new ones — the typical use case is "watch and come back",
    // and a fresh tab would discard the event buffer the user accumulated.
    const existing = tabs.find(
      (t) => t.type === "realtime" && t.connectionId === connectionId,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTab: AppTab = {
      id: `realtime-${connectionId}-${Date.now()}`,
      title: "Realtime",
      type: "realtime",
      connectionId,
      realtimePattern: "*",
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleTabRealtimePatternChange = (tabId: string, pattern: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, realtimePattern: pattern } : t,
      ),
    );
  };

  // ⌘+T / Ctrl+T opens a new query tab for the currently-focused connection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
        const target = focusedConnection?.id ?? activeConnections[0]?.id;
        if (!target) return;
        e.preventDefault();
        handleNewQuery(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedConnection, activeConnections, focusedTile]);

  // ⌘+W / Ctrl+W close-tab is handled by the native "Close Tab" menu item
  // (accelerator `CmdOrCtrl+W`), which emits `menu-file-close_tab` →
  // `closeActiveTab` above. We no longer bind a webview keydown for it: the
  // menu accelerator owns the key on every platform, and a second handler
  // risked closing two tabs from one press. (The old `close_window` menu item
  // that quit the whole app has been removed.)

  // ⌘+R / Ctrl+R soft-reloads the sidebar tree + active tab's data instead of
  // refreshing the whole page. We preventDefault so the browser's own reload
  // doesn't unload the app. Components that hold their own data (Sidebar,
  // DataGrid, DiagramView) listen for the `tablerelay:reload` event and refetch.
  //
  // ⌘+Shift+R / Ctrl+Shift+R does a full page reload — same as the
  // browser's hard-refresh shortcut. Useful when the JS bundle itself
  // got into a bad state (hot-reload glitch, orphaned state) and a soft
  // refresh isn't enough.
  //
  // Registered with `capture: true` so nested editors (Monaco, inputs)
  // can't swallow the event before we see it. `e.code === 'KeyR'` is
  // keyboard-layout-independent — on non-QWERTY layouts `e.key` may
  // be the character at that physical position instead of 'r'.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isR = e.code === "KeyR" || e.key.toLowerCase() === "r";
      if (!(e.metaKey || e.ctrlKey) || !isR) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        // Hard reload — tear down the webview window entirely. Pass
        // `true` on WebKit to bypass the cache; on Chromium it's a
        // no-op argument that doesn't hurt.
        window.location.reload();
        return;
      }
      const target = focusedConnection?.id;
      if (target) {
        void refreshSchemas(target);
      }
      window.dispatchEvent(
        new CustomEvent("tablerelay:reload", {
          detail: { connectionId: target ?? null },
        }),
      );
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [focusedConnection]);

  const handleOpenDefinition = (
    connectionId: string,
    key: string,
    title: string,
    sql: string,
  ) => {
    // Stable id derived from the (connection, database, object) pair so
    // re-opening the same view / routine focuses the existing tab instead of
    // creating a new one. The PG database is in the id so the same object name
    // in two databases gets separate tabs. Dropping Date.now() here is the
    // whole point of taking `key`.
    const db = scopedDbFor(connectionId);
    const id = `def-${connectionId}-${db ? `${db}-` : ""}${key}`;
    const existing = tabs.find((t) => t.id === id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    // No `database` field: like other query tabs this stays connection-scoped
    // (visible on every tile of the connection). The db-prefixed id alone keeps
    // the same object name in two databases from collapsing into one tab.
    const newTab: AppTab = {
      id,
      title: `Edit: ${title}`,
      type: "query",
      connectionId,
      query: sql,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleOpenRoutine = (
    connectionId: string,
    schema: string,
    name: string,
    kind: "function" | "procedure",
  ) => {
    const db = scopedDbFor(connectionId);
    const id = `routine-${connectionId}-${db ? `${db}.` : ""}${schema}.${name}`;
    const existing = tabs.find((t) => t.id === id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTab: AppTab = {
      id,
      title: name,
      type: "routine",
      connectionId,
      schema,
      database: db,
      routine: { schema, name, kind },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewTable = (connectionId: string, schema: string) => {
    const id = `new-table-${connectionId}-${schema}-${Date.now()}`;
    const newTab: AppTab = {
      id,
      title: "New table",
      type: "structure",
      connectionId,
      schema,
      database: scopedDbFor(connectionId),
      table: "(new)",
      isNew: true,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewRoutine = (
    connectionId: string,
    schema: string,
    kind: "function" | "procedure",
  ) => {
    const id = `new-routine-${connectionId}-${schema}-${kind}-${Date.now()}`;
    const newTab: AppTab = {
      id,
      title: `New ${kind}`,
      type: "routine",
      connectionId,
      schema,
      database: scopedDbFor(connectionId),
      routine: { schema, name: "(new)", kind },
      isNew: true,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewView = (connectionId: string, schema: string) => {
    const id = `new-view-${connectionId}-${schema}-${Date.now()}`;
    const newTab: AppTab = {
      id,
      title: "New view",
      type: "routine",
      connectionId,
      schema,
      database: scopedDbFor(connectionId),
      routine: { schema, name: "(new)", kind: "view" },
      isNew: true,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleOpenTrigger = (
    connectionId: string,
    schema: string,
    name: string,
  ) => {
    const db = scopedDbFor(connectionId);
    const id = `trigger-${connectionId}-${db ? `${db}.` : ""}${schema}.${name}`;
    const existing = tabs.find((t) => t.id === id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTab: AppTab = {
      id,
      title: name,
      type: "trigger",
      connectionId,
      schema,
      database: db,
      trigger: { schema, name },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewTrigger = (connectionId: string, schema: string) => {
    const id = `new-trigger-${connectionId}-${schema}-${Date.now()}`;
    const newTab: AppTab = {
      id,
      title: "New trigger",
      type: "trigger",
      connectionId,
      schema,
      database: scopedDbFor(connectionId),
      trigger: { schema, name: "(new)", isNew: true },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  // AI `open_object_tab` handler. Declared here (a `const` after the open/new
  // handlers it delegates to are in scope); the listener effect below reads it
  // through `openObjectTabRef` so it always sees the latest closure.
  const handleOpenObjectTab = (ev: {
    toolCallId?: string;
    connectionId?: string;
    object: "trigger" | "table";
    name?: string | null;
    schema?: string;
    sql?: string | null;
  }) => {
    if (ev.toolCallId) {
      if (handledOpenObjectRef.current.has(ev.toolCallId)) return;
      handledOpenObjectRef.current.add(ev.toolCallId);
    }
    const targetConn = ev.connectionId ?? focusedConnection?.id;
    if (!targetConn) {
      toast.error("No active connection — cannot open editor tab");
      return;
    }
    const schema =
      ev.schema ||
      (focusedTile?.serverId === targetConn ? focusedTile.databaseName : "") ||
      "";
    const objName = ev.name?.trim() || undefined;
    const seed = ev.sql?.trim() || undefined;

    if (ev.object === "trigger") {
      if (objName && !seed) {
        // Edit existing trigger by name (TriggerView fetches its DDL).
        handleOpenTrigger(targetConn, schema, objName);
      } else {
        // New trigger, or AI-prefilled DDL → editor seeded with the SQL.
        const id = seed
          ? `trigger-ai-${targetConn}-${schema}-${Date.now()}`
          : `new-trigger-${targetConn}-${schema}-${Date.now()}`;
        const newTab: AppTab = {
          id,
          title: objName ? objName : "New trigger",
          type: "trigger",
          connectionId: targetConn,
          schema,
          database: scopedDbFor(targetConn),
          trigger: {
            schema,
            name: objName ?? "(new)",
            isNew: !objName,
            initialSql: seed,
          },
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
      }
      toast.success(
        objName ? `Opened trigger ${objName}` : "Opened new trigger editor",
      );
      return;
    }

    // object === "table" → schema (structure) editor.
    if (objName) {
      handleOpenStructure(targetConn, schema, objName);
      toast.success(`Opened table ${objName}`);
    } else {
      handleNewTable(targetConn, schema);
      toast.success("Opened new table editor");
    }
  };
  openObjectTabRef.current = handleOpenObjectTab;

  const handleOpenErd = (
    connectionId: string,
    schemaName: string,
    tableName?: string,
  ) => {
    const db = scopedDbFor(connectionId);
    if (tableName) {
      // Table-scoped ERD: reuse the table's data tab and flip its internal
      // view mode to 'diagram'. Mirrors how "Open Schema" reuses the data
      // tab — one tab per table with Data / Schema / Diagram toggles.
      const existingTab = findDataTab(connectionId, schemaName, tableName, db);
      if (existingTab) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existingTab.id ? { ...t, dataViewMode: "diagram" } : t,
          ),
        );
        setActiveTabId(existingTab.id);
      } else {
        const newTab: AppTab = {
          id: `data-${connectionId}-${db ?? schemaName}.${tableName}-${Date.now()}`,
          title: tableName,
          type: "data",
          connectionId,
          schema: schemaName,
          database: db,
          table: tableName,
          dataViewMode: "diagram",
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
      }
      return;
    }

    // Schema-scoped ERD stays as its own dedicated tab. The id carries the PG
    // database so the same schema name in two databases gets separate ERD tabs.
    const id = `erd-${connectionId}-${db ?? schemaName}-${schemaName}`;
    const title = `ERD: ${schemaName}`;
    const newTab: AppTab = {
      id,
      title,
      type: "erd",
      connectionId,
      schema: schemaName,
      database: db,
      schemaName,
    };
    if (!tabs.find((t) => t.id === newTab.id)) {
      setTabs((prev) => [...prev, newTab]);
    }
    setActiveTabId(newTab.id);
  };

  // Two pins on the same server are distinct workspaces, so tab scope keys
  // always include the database/schema — only connection-scoped query tabs
  // (no schema) fall back to the raw connection id. For Postgres the workspace
  // boundary is the PG database (the rail tile's `databaseName`), which the tab
  // carries in `database`; this lines the key up with the focused tile's
  // `scopeKey` (also `conn::databaseName`). For MySQL/SQLite schema == database,
  // so the schema is the boundary.
  const tabScopeKey = (t: AppTab): string => {
    if (t.database) return `${t.connectionId}::${t.database}`;
    return t.schema ? `${t.connectionId}::${t.schema}` : t.connectionId;
  };

  const handleCloseTab = (id: string) => {
    // Drop the data-cache entry for this tab — the grid snapshot is only
    // useful while the tab is open, and holding onto it leaks memory across
    // long sessions.
    clearCachedGrid(id);
    clearQueryResultSnapshot(id);
    setTabs((prev) => {
      const closing = prev.find((t) => t.id === id);
      const newTabs = prev.filter((t) => t.id !== id);
      if (closing) {
        const scope = tabScopeKey(closing);
        if (activeTabByConn[scope] === id) {
          const siblings = newTabs.filter((t) => tabScopeKey(t) === scope);
          const prevSiblings = prev.filter((t) => tabScopeKey(t) === scope);
          const index = prevSiblings.findIndex((t) => t.id === id);
          setActiveTabByConn((map) => {
            const next = { ...map };
            if (siblings.length > 0) {
              const nextIndex = Math.min(index, siblings.length - 1);
              next[scope] = siblings[nextIndex].id;
            } else {
              delete next[scope];
            }
            return next;
          });
        }
      }
      return newTabs;
    });
  };

  const handleCloseTabs = (
    mode: "all" | "others" | "left" | "right",
    anchorId: string,
  ) => {
    setTabs((prev) => {
      const anchor = prev.find((t) => t.id === anchorId);
      if (!anchor) return prev;
      const scope = tabScopeKey(anchor);
      // Apply close semantics within the anchor's own scope — other scopes
      // aren't visible to the user right now, so touching them would be
      // surprising.
      const siblings = prev.filter((t) => tabScopeKey(t) === scope);
      const idxInSiblings = siblings.findIndex((t) => t.id === anchorId);
      let keptSiblings: AppTab[];
      switch (mode) {
        case "all":
          keptSiblings = [];
          break;
        case "others":
          keptSiblings = [siblings[idxInSiblings]];
          break;
        case "left":
          keptSiblings = siblings.slice(idxInSiblings);
          break;
        case "right":
          keptSiblings = siblings.slice(0, idxInSiblings + 1);
          break;
      }
      const keptIds = new Set(keptSiblings.map((t) => t.id));
      const kept = prev.filter(
        (t) => tabScopeKey(t) !== scope || keptIds.has(t.id),
      );
      // Evict cache entries for every tab we're removing.
      for (const t of prev) {
        if (tabScopeKey(t) === scope && !keptIds.has(t.id)) {
          clearCachedGrid(t.id);
          clearQueryResultSnapshot(t.id);
        }
      }
      const currentActive = activeTabByConn[scope];
      const activeStillOpen = currentActive && keptIds.has(currentActive);
      if (!activeStillOpen) {
        setActiveTabByConn((map) => {
          const next = { ...map };
          if (keptSiblings.length > 0) next[scope] = anchorId;
          else delete next[scope];
          return next;
        });
      }
      return kept;
    });
  };

  const handleTabViewModeChange = (tabId: string, mode: DataViewMode) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, dataViewMode: mode } : t)),
    );
  };

  // Persist the editor buffer back onto the query tab so it survives tab
  // switches and app reloads. Closing the tab drops the entry entirely.
  const handleTabQueryChange = (tabId: string, query: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.query !== query ? { ...t, query } : t,
      ),
    );
  };

  // An editor reports whether it has unsaved edits so the tab strip can show a
  // VSCode-style unsaved dot. Cheap no-op when the flag is unchanged.
  const handleTabDirtyChange = (tabId: string, dirty: boolean) => {
    setTabs((prev) => {
      // Bail out with the SAME array reference when nothing changes.
      // `prev.map(...)` always allocates a new array, so returning it
      // unconditionally would retrigger a render every time a child's
      // `onDirtyChange` fires (those are fresh closures each render),
      // which spins into an infinite render loop. Only build a new array
      // when the target tab's dirty flag actually flips.
      const target = prev.find((t) => t.id === tabId);
      if (!target || (target.dirty ?? false) === dirty) return prev;
      return prev.map((t) => (t.id === tabId ? { ...t, dirty } : t));
    });
  };

  // Persist the trigger editor's in-progress buffer onto its tab so switching
  // away and back doesn't discard unsaved edits (the editor unmounts when
  // another tab is focused — only the active tab renders).
  const handleTabTriggerDraftChange = (tabId: string, draft: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.type === "trigger" && t.trigger
          ? { ...t, trigger: { ...t.trigger, draft } }
          : t,
      ),
    );
  };

  // A "new table" structure tab successfully created its table on the
  // server. Re-target the tab at the now-real table: drop the
  // `(new)` placeholder, swap in the real name, clear `isNew`, retitle.
  // Without this, the schema view would stay stuck in create-mode
  // (the dirty calc keeps reading "● unsaved changes" forever even
  // though everything is on disk).
  const handleTabTableCreated = (tabId: string, savedName: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.type === "structure"
          ? { ...t, table: savedName, title: savedName, isNew: false }
          : t,
      ),
    );
  };

  // Write SQL from the AI tool `write_query_tab` into the tabs state. Runs
  // only after the user approved the tool call in the chat panel, so no
  // additional consent is needed here. `replace` falls back to `new` if no
  // query tab is currently active — the fallback is what the tool docstring
  // tells the model to expect.
  const handledToolCallsRef = useRef<Set<string>>(new Set());
  const writeQueryTabRef = useRef<
    (e: {
      toolCallId?: string;
      connectionId?: string;
      schema?: string;
      sql: string;
      mode: "new" | "replace";
      title?: string;
    }) => void
  >(() => {});
  writeQueryTabRef.current = (ev) => {
    if (ev.toolCallId) {
      if (handledToolCallsRef.current.has(ev.toolCallId)) return;
      handledToolCallsRef.current.add(ev.toolCallId);
      if (handledToolCallsRef.current.size > 200) {
        const keep = Array.from(handledToolCallsRef.current).slice(-100);
        handledToolCallsRef.current = new Set(keep);
      }
    }
    const targetConn = ev.connectionId ?? focusedConnection?.id;
    if (!targetConn) {
      toast.error("No active connection — cannot write query tab");
      return;
    }
    const fallbackTitle = (() => {
      const snippet = ev.sql.replace(/\s+/g, " ").trim();
      return snippet.length > 36 ? snippet.slice(0, 36) + "…" : snippet;
    })();
    const title = ev.title?.trim() || fallbackTitle || "AI Query";

    if (ev.mode === "replace") {
      // Replacement priority:
      //   1. The currently-focused query tab. First choice — matches user intent.
      //   2. Otherwise (user is on a routine/view/data tab), the most recent
      //      AI-owned query tab on the same connection. Prevents a pile of
      //      duplicate tabs when the user keeps iterating with the AI while
      //      staring at a function/view.
      //   3. Neither → fall through to 'new'.
      // The SqlEditor syncs the new value in place via an effect on its
      // `initialQuery` prop — no remount, no flicker.
      const activeQuery = visibleTabs.find(
        (t) => t.id === activeTabId && t.type === "query",
      );
      const aiOwned = tabs
        .filter(
          (t) =>
            t.type === "query" && t.connectionId === targetConn && t.aiOwned,
        )
        .slice(-1)[0];
      const target = activeQuery ?? aiOwned;
      if (target) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === target.id
              ? { ...t, query: ev.sql, title, aiOwned: true }
              : t,
          ),
        );
        setActiveTabId(target.id);
        toast.success(
          activeQuery ? "Replaced current query tab" : "Updated AI query tab",
        );
        return;
      }
      // No tab to replace — fall through to new.
    }
    const newTab: AppTab = {
      id: `query-${targetConn}-${Date.now()}`,
      title,
      type: "query",
      connectionId: targetConn,
      schema:
        ev.schema ??
        (focusedTile?.serverId === targetConn
          ? focusedTile.databaseName
          : undefined),
      query: ev.sql,
      aiOwned: true,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    toast.success(
      ev.mode === "replace"
        ? "Opened new query tab (no active tab to replace)"
        : "Opened new query tab",
    );
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void ai
      .onTabWrite((ev) => writeQueryTabRef.current(ev))
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  // Listener for the AI `open_object_tab` tool. Reads `openObjectTabRef`
  // (assigned where `handleOpenObjectTab` is declared) so it always invokes the
  // latest closure. Mirrors the sidebar open/new flows.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void ai
      .onTabOpenObject((ev) => openObjectTabRef.current(ev))
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  const handleSaveNewConnection = async (conn: ConnectionProfile) => {
    await onAddConnection(conn);
    setNewConnectionOpen(false);
  };
  const handleSaveEditedConnection = async (conn: ConnectionProfile, previousId?: string) => {
    await onEditConnection?.(conn, previousId);
    if (previousId && previousId !== conn.id) {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.connectionId === previousId
            ? { ...tab, connectionId: conn.id }
            : tab,
        ),
      );
      setActiveTabByConn((prev) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(prev)) {
          next[key.startsWith(`${previousId}::`) ? key.replace(previousId, conn.id) : key] = value;
        }
        return next;
      });
      const oldTiles = railState.tiles.filter((tile) => tile.serverId === previousId);
      const newFocusedTileId = focusedTileId;
      let replacementFocusedTileId: string | null = null;
      for (const tile of oldTiles) {
        const replacement = await pinTile({
          serverId: conn.id,
          databaseName: tile.databaseName,
          label: tile.label ?? undefined,
        });
        if (tile.id === newFocusedTileId) replacementFocusedTileId = replacement.id;
      }
      if (oldTiles.length > 0) {
        await unpinManyTiles(oldTiles.map((tile) => tile.id));
      }
      if (focusedConnectionId === previousId) setFocusedConnectionId(conn.id);
      if (replacementFocusedTileId) setFocusedTileId(replacementFocusedTileId);
      await refreshRail();
    }
    closeEditConnection();
  };

  const _activeTab = visibleTabs.find((t) => t.id === activeTabId);
  // Side effect — must not run during render or it triggers DevDebug
  // to re-render mid-commit and React logs a warning.
  useEffect(() => {
    setDebugPage({
      view: "workspace",
      activeTabId: activeTabId,
      activeTabType: _activeTab?.type ?? null,
      activeTabTitle: _activeTab?.title ?? null,
      focusedConnection: focusedConnection?.name ?? null,
      focusedDatabase: focusedTile?.databaseName ?? null,
    });
  }, [
    activeTabId,
    _activeTab?.type,
    _activeTab?.title,
    focusedConnection?.name,
    focusedTile?.databaseName,
  ]);

  return (
    <div
      className="flex-1 flex bg-background relative mac-vibrancy min-w-0"
      style={contentMaxWidthStyle}
    >
      <ConnectionRail
        servers={connections}
        focusedTileId={focusedTileId}
        onFocusTile={handleFocusTile}
        onDisconnectServer={(id) => {
          // Evict every cached grid belonging to tabs on this connection
          // before the connection closes — otherwise stale rows would linger
          // in memory (and reappear if the user reconnects).
          const idsToClear = tabs
            .filter((t) => t.connectionId === id)
            .map((t) => t.id);
          clearCachedGridsWhere((tid) => idsToClear.includes(tid));
          onDisconnect(id);
        }}
        onEditServer={(id) => {
          const conn = connections.find((c) => c.id === id);
          if (conn) openEditConnection(conn);
        }}
        onImportSql={(id) => setImportSqlForId(id)}
        onExport={handleExportForConnection}
        connectedServerIds={new Set(connState.activeById.keys())}
        expanded={railExpanded}
        onExpandChange={setRailExpanded}
      />

      <Sidebar
        focusedConnection={focusedConnection}
        focusedDatabase={focusedTile?.databaseName ?? null}
        connections={connections}
        onOpenTable={handleOpenTable}
        onOpenStructure={handleOpenStructure}
        onNewQuery={handleNewQuery}
        onOpenErd={handleOpenErd}
        onPickConnection={handlePickConnection}
        onEditConnection={(conn) => openEditConnection(conn, true)}
        onDeleteConnection={onDeleteConnection}
        onOpenNewServer={() => setNewConnectionOpen(true)}
        onPinDatabase={handlePinDatabase}
        onImportSql={(id) => setImportSqlForId(id)}
        onExport={handleExportForConnection}
        onOpenDefinition={handleOpenDefinition}
        onOpenRoutine={handleOpenRoutine}
        onOpenTrigger={handleOpenTrigger}
        onNewTable={handleNewTable}
        onNewView={handleNewView}
        onNewRoutine={handleNewRoutine}
        onNewTrigger={handleNewTrigger}
        onOpenRealtime={handleNewRealtime}
        activeItem={(() => {
          const tab = visibleTabs.find((t) => t.id === activeTabId);
          if (!tab || !tab.schema) return null;
          // Data + structure tabs represent a table or view — we distinguish
          // by whether that name appears in the view list for the schema.
          if (
            (tab.type === "data" || tab.type === "structure") &&
            tab.table &&
            tab.table !== "(new)"
          ) {
            const schemas = connState.schemasById.get(tab.connectionId) ?? [];
            const schema = schemas.find((s) => s.name === tab.schema);
            const kind = schema?.tables.find((t) => t.name === tab.table)?.kind;
            return {
              type: kind === "view" ? "view" : "table",
              connectionId: tab.connectionId,
              schema: tab.schema,
              name: tab.table,
            };
          }
          if (
            tab.type === "routine" &&
            tab.routine &&
            tab.routine.name !== "(new)"
          ) {
            return {
              type: tab.routine.kind === "view" ? "view" : "routine",
              connectionId: tab.connectionId,
              schema: tab.schema,
              name: tab.routine.name,
              routineKind:
                tab.routine.kind === "view" ? undefined : tab.routine.kind,
            };
          }
          if (
            tab.type === "trigger" &&
            tab.trigger &&
            tab.trigger.name !== "(new)"
          ) {
            return {
              type: "trigger",
              connectionId: tab.connectionId,
              schema: tab.schema,
              name: tab.trigger.name,
            };
          }
          return null;
        })()}
      />

      <div className="flex-1 flex flex-col min-w-0 bg-background border-l border-border">
        <TabsShell
          activeConnections={activeConnections}
          tabs={visibleTabs}
          activeTabId={activeTabId}
          onTabChange={setActiveTabId}
          onCloseTab={handleCloseTab}
          onCloseTabs={handleCloseTabs}
          onNewQuery={handleNewQuery}
          onImportSql={(id) => setImportSqlForId(id)}
          onOpenRealtime={handleNewRealtime}
          onTabViewModeChange={handleTabViewModeChange}
          onTabQueryChange={handleTabQueryChange}
          onTabTriggerDraftChange={handleTabTriggerDraftChange}
          onTabDirtyChange={handleTabDirtyChange}
          onTabRealtimePatternChange={handleTabRealtimePatternChange}
          onTableCreated={handleTabTableCreated}
          queryLogs={queryLogs}
          onAppendQueryLog={appendQueryLog}
          onClearQueryLog={clearQueryLog}
          noDatabaseSelected={!!focusedConnection && !focusedTile}
          focusedDatabase={focusedTile?.databaseName ?? null}
        />
      </div>

      {chatOpen && (
        <div
          className="shrink-0 border-l border-border/50 min-w-0 relative"
          style={{ width: chatWidth }}
        >
          {/* Left-edge drag handle. Mirrors the pattern in query-log.tsx —
              small invisible strip with hover/active highlight; width clamps
              to [CHAT_MIN_WIDTH, CHAT_MAX_WIDTH]. */}
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = chatWidth;
              const onMove = (ev: MouseEvent) => {
                // Dragging left grows the panel (we're anchored right), so
                // width = startW + (startX - currentX).
                const dx = startX - ev.clientX;
                const next = Math.max(
                  CHAT_MIN_WIDTH,
                  Math.min(CHAT_MAX_WIDTH, startW + dx),
                );
                setChatWidth(next);
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
              document.body.style.cursor = "ew-resize";
              document.body.style.userSelect = "none";
            }}
            role="separator"
            aria-orientation="vertical"
            className="absolute -left-0.5 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-primary/30 active:bg-primary/50 z-20"
          />
          <ChatPanel
            onClose={() => setChatOpen(false)}
            focusedConnectionId={focusedConnection?.id}
            focusedSchema={focusedTile?.databaseName ?? undefined}
            focusedLabel={
              focusedConnection && focusedTile
                ? `${focusedConnection.name} / ${focusedTile.databaseName}`
                : focusedConnection?.name
            }
            focus={computeFocusHint(
              visibleTabs.find((t) => t.id === activeTabId),
            )}
          />
        </div>
      )}

      <ConnectionModal
        isOpen={newConnectionOpen}
        onClose={() => setNewConnectionOpen(false)}
        onSave={handleSaveNewConnection}
      />

      <ConnectionModal
        isOpen={editingConnection !== null}
        onClose={closeEditConnection}
        onSave={handleSaveEditedConnection}
        initialData={editingConnection ?? undefined}
      />

      <ImportSqlDialog
        isOpen={importSqlForId !== null}
        onClose={() => setImportSqlForId(null)}
        connectionId={importSqlForId}
        connectionName={
          importSqlForId
            ? (connections.find((c) => c.id === importSqlForId)?.name ??
              "connection")
            : ""
        }
        targetDatabase={
          // Use the rail-focused tile's database when it matches the
          // connection the import is bound to — otherwise fall back to
          // the profile's default database (set on the connection form),
          // or null for adapters that don't scope by database.
          //
          // SQLite has a single `main` schema and rejects `USE` entirely,
          // so we short-circuit to null even if a tile is focused.
          // Postgres can't switch database mid-session at all — the PG
          // database is fixed at connect time — so `USE` is meaningless
          // and nullling targetDatabase here keeps `buildPayload` from
          // ever emitting a stray USE for the PG path.
          (() => {
            if (!importSqlForId) return null;
            const profile = connections.find((c) => c.id === importSqlForId);
            if (profile?.driver === "SQLite") return null;
            if (profile?.driver === "PostgreSQL") return null;
            return focusedTile?.serverId === importSqlForId
              ? focusedTile.databaseName
              : (profile?.database ?? null);
          })()
        }
        dialect={
          // Pick the right import-safety wrapper based on adapter.
          // Unknown drivers fall through to `null` — no wrapper, just
          // run the dump as-is.
          (() => {
            if (!importSqlForId) return null;
            const profile = connections.find((c) => c.id === importSqlForId);
            if (profile?.driver === "MySQL") return "mysql";
            if (profile?.driver === "SQLite") return "sqlite";
            if (profile?.driver === "PostgreSQL") return "postgres";
            return null;
          })()
        }
        supportsSql={
          // SQL execution is only meaningful where the adapter speaks a SQL
          // dialect. Document/KV stores (Mongo) get CSV/JSON only.
          (() => {
            if (!importSqlForId) return true;
            const profile = connections.find((c) => c.id === importSqlForId);
            const manifest = resolveManifest(adapterManifests, profile?.driver);
            return (manifest?.capabilities.sqlDialect ?? "generic") !== "none";
          })()
        }
        supportsRowInsert={
          // CSV/JSON imports go through `db.insertRows`; gate on the adapter
          // actually supporting row inserts (Redis = false).
          (() => {
            if (!importSqlForId) return true;
            const profile = connections.find((c) => c.id === importSqlForId);
            const manifest = resolveManifest(adapterManifests, profile?.driver);
            return manifest?.capabilities.insertRows ?? true;
          })()
        }
        schemas={
          importSqlForId
            ? (connState.schemasById.get(importSqlForId) ?? [])
            : []
        }
        onOpenInEditor={handleImportToEditor}
      />

      <ConnectionExportDialog
        isOpen={exportForId !== null}
        onClose={() => setExportForId(null)}
        connectionId={exportForId}
        schemas={exportForId ? (connState.schemasById.get(exportForId) ?? []) : []}
        initialSchema={
          exportForId && focusedTile?.serverId === exportForId
            ? focusedTile.databaseName
            : (exportForId ? (connections.find((c) => c.id === exportForId)?.database ?? null) : null)
        }
        dialect={(() => {
          if (!exportForId) return null;
          const profile = connections.find((c) => c.id === exportForId);
          if (profile?.driver === "MySQL") return "mysql";
          if (profile?.driver === "SQLite") return "sqlite";
          if (profile?.driver === "PostgreSQL") return "postgres";
          return null;
        })()}
        supportsSql={(() => {
          if (!exportForId) return true;
          const profile = connections.find((c) => c.id === exportForId);
          const manifest = resolveManifest(adapterManifests, profile?.driver);
          return (manifest?.capabilities.sqlDialect ?? "generic") !== "none";
        })()}
      />
    </div>
  );
}
