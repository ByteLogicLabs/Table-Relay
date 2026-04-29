import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { ConnectionProfile, AppTab, DataViewMode, QueryLogEntry } from '../../types';
import Sidebar from './sidebar';
import TabsShell from './tabs-shell';
import ConnectionRail, { RAIL_COLLAPSED_WIDTH, RAIL_EXPANDED_WIDTH } from '../connections/connection-rail';
import ConnectionModal from '../connections/connection-modal';
import ImportSqlDialog from '../connections/import-sql-dialog';
import ChatPanel from '../ai-chat/chat-panel';
import { listen } from '@tauri-apps/api/event';
import { connectAndLoad, refreshSchemas, useConnections } from '../../state/connections';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { useRail, pinTile, refreshRail } from '../../state/rail';
import type { RailTile } from '../../lib/rail';
import { isDbError } from '../../lib/db';
import { ai, type ChatFocus } from '../../lib/ai';
import { clearCachedGrid, clearCachedGridsWhere } from '../../state/tab-data-cache';
import { clearQueryResultSnapshot } from '../../state/query-result-cache';

const SIDEBAR_WIDTH = 256;
const CHAT_WIDTH_KEY = 'dbtable:chatWidth:v1';
const CHAT_MIN_WIDTH = 320;
const CHAT_MAX_WIDTH = 800;
const CHAT_DEFAULT_WIDTH = 384;
const TABS_STORAGE_KEY = 'dbtable:tabs:v1';
const ACTIVE_TAB_KEY = 'dbtable:activeTab:v1';
const ACTIVE_TAB_BY_CONN_KEY = 'dbtable:activeTabByConn:v1';
const FOCUSED_TILE_KEY = 'dbtable:focusedTile:v1';

/**
 * Translate the active AppTab into a focus hint the AI context builder can
 * consume. Returns undefined for tabs that don't give the model anything
 * actionable to point at (e.g. diagram / schema / empty states) — the chat
 * then falls back to plain schema-level context.
 */
function computeFocusHint(tab: AppTab | undefined): ChatFocus | undefined {
  if (!tab) return undefined;
  switch (tab.type) {
    case 'query':
      return tab.query && tab.query.trim().length > 0
        ? { type: 'query', sql: tab.query }
        : undefined;
    case 'routine':
      if (!tab.routine) return undefined;
      return {
        type: 'routine',
        schema: tab.routine.schema,
        name: tab.routine.name,
        kind: tab.routine.kind,
      };
    case 'data':
    case 'structure':
      if (tab.schema && tab.table) {
        return { type: 'table', schema: tab.schema, name: tab.table };
      }
      return undefined;
    case 'realtime':
      return {
        type: 'realtime',
        pattern: tab.realtimePattern ?? '',
        // Live subscription state isn't persisted on the tab; the
        // adapter-primer in the system prompt carries the syntactical
        // rules the model needs regardless. Keep the slot here for
        // forward-compat with a richer status surface later.
        isRunning: false,
        recentChannels: [],
      };
    default:
      return undefined;
  }
}

function loadPersistedTabs(): AppTab[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is AppTab =>
        t && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.type === 'string' && typeof t.connectionId === 'string',
    );
  } catch {
    return [];
  }
}

interface WorkspaceViewProps {
  activeConnections: ConnectionProfile[];
  activeConnectionIds: string[];
  onDisconnect: (id: string) => void;
  connections: ConnectionProfile[];
  onConnect: (id: string) => void;
  onAddConnection: (conn: ConnectionProfile) => void;
  onEditConnection?: (conn: ConnectionProfile) => void;
}

export default function WorkspaceView({
  activeConnections,
  onDisconnect,
  connections,
  onConnect,
  onAddConnection,
}: WorkspaceViewProps) {
  const [tabs, setTabs] = useState<AppTab[]>(() => loadPersistedTabs());
  // Per-connection active-tab map: each connection remembers its own last
  // active tab, so switching between connections never steals tab focus from
  // the other. Legacy single-id value is read once and folded into the map.
  const [activeTabByConn, setActiveTabByConn] = useState<Record<string, string>>(() => {
    try {
      const raw = window.localStorage.getItem(ACTIVE_TAB_BY_CONN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, string>;
        }
      }
    } catch { /* fall through */ }
    // Legacy migration: if the old single-id key is set, stash it under the
    // first connection that owns a matching tab so we don't lose focus on
    // upgrade. Next write overrides it properly.
    try {
      const legacy = window.localStorage.getItem(ACTIVE_TAB_KEY);
      const persistedTabs = loadPersistedTabs();
      if (legacy) {
        const owner = persistedTabs.find(t => t.id === legacy);
        if (owner) return { [owner.connectionId]: legacy };
      }
    } catch { /* noop */ }
    return {};
  });

  // Persist tabs + per-connection active tab so reopening the app lands you
  // back in the same workspace with each connection's tabs intact.
  useEffect(() => {
    try {
      window.localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
    } catch { /* quota / private mode: silent fallback */ }
  }, [tabs]);
  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_TAB_BY_CONN_KEY, JSON.stringify(activeTabByConn));
    } catch { /* noop */ }
  }, [activeTabByConn]);
  const [focusedTileId, setFocusedTileId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(FOCUSED_TILE_KEY); } catch { return null; }
  });
  // When the user picks a connection (not a tile), we track it explicitly so
  // the sidebar knows which server to show even before a database is chosen.
  const [focusedConnectionId, setFocusedConnectionId] = useState<string | null>(null);
  const [newConnectionOpen, setNewConnectionOpen] = useState(false);
  // Connection id the Import SQL dialog is bound to. `null` = dialog closed.
  const [importSqlForId, setImportSqlForId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(CHAT_WIDTH_KEY);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= CHAT_MIN_WIDTH && n <= CHAT_MAX_WIDTH) return n;
    } catch { /* noop */ }
    return CHAT_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try { window.localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth)); } catch { /* noop */ }
  }, [chatWidth]);
  const [railExpanded, setRailExpanded] = useState(false);

  // Any view with a toolbar (data-grid, sql-editor, etc.) can ask to toggle
  // the chat panel by dispatching `dbtable:toggle-chat`. Keeps each view
  // free of chat-panel wiring — they just fire the event.
  useEffect(() => {
    const onToggle = () => setChatOpen(o => !o);
    // Fix / Explain / Generate shortcuts force the panel open — the panel
    // itself listens to the same event for the prefill payload.
    const onPrefill = () => setChatOpen(true);
    window.addEventListener('dbtable:toggle-chat', onToggle);
    window.addEventListener('dbtable:ai-prefill', onPrefill);
    return () => {
      window.removeEventListener('dbtable:toggle-chat', onToggle);
      window.removeEventListener('dbtable:ai-prefill', onPrefill);
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
  }>({
    focusedConnectionId: null,
    activeTabId: null,
    focusedSupportsImport: true,
    activeTabSupportsExport: true,
  });
  const adapterManifests = useAdapterManifests();
  useEffect(() => {
    // Tauri event names are plain `menu-file-<action>` — kebab-case,
    // no `:` / `.` which can trigger silent routing failures on some
    // Tauri versions. Backend emits under the same shape.
    const unlistenImport = listen<void>('menu-file-import', () => {
      const id = menuCtxRef.current.focusedConnectionId;
      if (!id) {
        toast.error('Open a connection before importing');
        return;
      }
      if (!menuCtxRef.current.focusedSupportsImport) {
        toast.error("This connection's adapter doesn't support import");
        return;
      }
      setImportSqlForId(id);
    });
    const unlistenExport = listen<void>('menu-file-export', () => {
      const tid = menuCtxRef.current.activeTabId;
      if (!tid) {
        toast.error('Open a table before exporting');
        return;
      }
      if (!menuCtxRef.current.activeTabSupportsExport) {
        toast.error("This connection's adapter doesn't support export");
        return;
      }
      // Data-grid listens for this on its own tab id.
      window.dispatchEvent(
        new CustomEvent('dbtable:menu-export', { detail: { tabId: tid } }),
      );
    });
    return () => {
      void unlistenImport.then(fn => fn());
      void unlistenExport.then(fn => fn());
    };
  }, []);
  const railWidth = railExpanded ? RAIL_EXPANDED_WIDTH : RAIL_COLLAPSED_WIDTH;
  const chatColumnPx = chatOpen ? chatWidth : 0;
  const contentMaxWidthStyle: CSSProperties = {
    ['--content-max-w' as string]: `calc(100vw - ${railWidth + SIDEBAR_WIDTH + chatColumnPx}px)`,
  };
  const [queryLogs, setQueryLogs] = useState<Record<string, QueryLogEntry[]>>({});

  const connState = useConnections();
  const railState = useRail();
  useEffect(() => { void refreshRail(); }, []);

  const appendQueryLog = (entry: Omit<QueryLogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }) => {
    const full: QueryLogEntry = {
      id: entry.id ?? crypto.randomUUID(),
      timestamp: entry.timestamp ?? Date.now(),
      ...entry,
    };
    setQueryLogs(prev => {
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
    setQueryLogs(prev => ({ ...prev, [connectionId]: [] }));
  };

  // Persist the focused tile so reopening the app restores the last-opened
  // database. Without this the user was prompted to re-pick a database on
  // every launch even though the pins themselves survived.
  useEffect(() => {
    try {
      if (focusedTileId) window.localStorage.setItem(FOCUSED_TILE_KEY, focusedTileId);
      else window.localStorage.removeItem(FOCUSED_TILE_KEY);
    } catch { /* noop */ }
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
    if (!railState.tiles.some(t => t.id === focusedTileId)) {
      setFocusedTileId(railState.tiles[0]?.id ?? null);
    }
  }, [railState.tiles, focusedTileId, focusedConnectionId]);

  // Sync tabs with the rail: when a tile is unpinned, close any tabs that
  // belong to that (connection, database) pair so the tab strip doesn't hold
  // onto orphaned windows. Tabs without a schema (query tabs tied only to a
  // connection) stay put unless the whole server is gone from the rail too.
  useEffect(() => {
    const pinnedPairs = new Set(railState.tiles.map(t => `${t.serverId}::${t.databaseName}`));
    const pinnedServers = new Set(railState.tiles.map(t => t.serverId));
    setTabs(prev => {
      const kept = prev.filter(tab => {
        // Schema-bound tabs require their (conn, db) pair to still be pinned.
        if (tab.schema) return pinnedPairs.has(`${tab.connectionId}::${tab.schema}`);
        // Query tabs (no schema) only require the server to still have any pin.
        return pinnedServers.has(tab.connectionId);
      });
      if (kept.length === prev.length) return prev;
      // Drop any per-connection active-tab entries whose referenced tab was
      // just removed — otherwise the empty state won't render for that conn.
      const keptIds = new Set(kept.map(t => t.id));
      setActiveTabByConn(map => {
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
    railState.tiles.find(t => t.id === focusedTileId) ?? null;
  // Priority chain so the sidebar never sits on the "no connection" empty
  // state while a connection is actually live:
  //   1. The server behind the focused rail tile.
  //   2. An active connection matching the focused tile's server (for some
  //      reason not in the top-level `connections` list).
  //   3. Any active connection (user just connected, hasn't pinned a DB yet).
  const focusedConnection: ConnectionProfile | null =
    (focusedTile && connections.find(c => c.id === focusedTile.serverId))
    ?? (focusedTile && activeConnections.find(c => c.id === focusedTile.serverId))
    ?? (focusedConnectionId && activeConnections.find(c => c.id === focusedConnectionId))
    ?? (focusedConnectionId && connections.find(c => c.id === focusedConnectionId))
    ?? activeConnections[0]
    ?? null;

  // Tabs are scoped by BOTH connection + database (i.e. the focused rail
  // tile). Two pins on the same server but different databases are different
  // workspaces, so their tab strips must stay independent. The exception is
  // query tabs without a schema — those are tied to the connection only, so
  // we show them regardless of which tile is focused on that server.
  const scopeKey = focusedTile ? `${focusedTile.serverId}::${focusedTile.databaseName}` : null;
  const visibleTabs = focusedConnection
    ? tabs.filter(t => {
        if (t.connectionId !== focusedConnection.id) return false;
        if (!t.schema) return true; // connection-scoped query tab
        return scopeKey === `${t.connectionId}::${t.schema}`;
      })
    : [];
  const storedActive = scopeKey ? activeTabByConn[scopeKey] : undefined;
  // If the stored active tab no longer exists (e.g. closed while another
  // tile was focused) fall back to the first visible tab so the user sees
  // content instead of an empty pane.
  const activeTabId = focusedConnection
    ? (storedActive && visibleTabs.some(t => t.id === storedActive)
        ? storedActive
        : (visibleTabs[0]?.id ?? null))
    : null;
  const setActiveTabId = (id: string | null) => {
    if (!scopeKey) return;
    setActiveTabByConn(prev => {
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
    const focusedManifest = resolveManifest(adapterManifests, focusedConnection?.driver);
    menuCtxRef.current.focusedSupportsImport =
      focusedManifest ? focusedManifest.capabilities.import.length > 0 : true;
    // Only surface data tabs to the export handler — exporting makes no
    // sense on query / routine / schema tabs.
    const activeTab = visibleTabs.find(t => t.id === activeTabId);
    menuCtxRef.current.activeTabId =
      activeTab?.type === 'data' ? activeTab.id : null;
    const activeTabConn = activeTab
      ? connections.find(c => c.id === activeTab.connectionId)
      : null;
    const activeTabManifest = resolveManifest(adapterManifests, activeTabConn?.driver);
    menuCtxRef.current.activeTabSupportsExport =
      activeTabManifest ? activeTabManifest.capabilities.export.length > 0 : true;
  });

  const handleFocusTile = async (tile: RailTile) => {
    setFocusedTileId(tile.id);
    if (!connState.activeById.has(tile.serverId)) {
      try {
        await connectAndLoad(tile.serverId);
        onConnect(tile.serverId);
      } catch (err) {
        toast.error(isDbError(err) ? err.message : String(err));
      }
    }
  };

  const handlePickConnection = async (connectionId: string) => {
    if (!connState.activeById.has(connectionId)) {
      try {
        await connectAndLoad(connectionId);
        onConnect(connectionId);
      } catch (err) {
        toast.error(isDbError(err) ? err.message : String(err));
        return;
      }
    }
    // Focus the connection but leave the tile slot empty so the sidebar
    // prompts the user to pick a database for this server.
    setFocusedTileId(null);
    setFocusedConnectionId(connectionId);
  };

  const handlePinDatabase = async (serverId: string, databaseName: string) => {
    try {
      const tile = await pinTile({ serverId, databaseName });
      setFocusedTileId(tile.id);
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleOpenTable = (connectionId: string, schema: string, tableName: string) => {
    const existingTab = tabs.find(
      t => t.type === 'data' && t.table === tableName && t.schema === schema && t.connectionId === connectionId,
    );
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      const newTab: AppTab = {
        id: `data-${connectionId}-${schema}.${tableName}-${Date.now()}`,
        title: tableName,
        type: 'data',
        connectionId,
        schema,
        table: tableName,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };

  const handleOpenStructure = (connectionId: string, schema: string, tableName: string) => {
    // "Open Schema" from the sidebar reuses the table's data tab and flips
    // its internal view mode to 'schema'. That way the user gets one tab per
    // table with Data / Schema / Diagram toggles in the toolbar instead of
    // a separate structure tab duplicating the same SchemaView.
    const existingTab = tabs.find(
      t => t.type === 'data' && t.table === tableName && t.schema === schema && t.connectionId === connectionId,
    );
    if (existingTab) {
      setTabs(prev => prev.map(t => (t.id === existingTab.id ? { ...t, dataViewMode: 'schema' } : t)));
      setActiveTabId(existingTab.id);
    } else {
      const newTab: AppTab = {
        id: `data-${connectionId}-${schema}.${tableName}-${Date.now()}`,
        title: tableName,
        type: 'data',
        connectionId,
        schema,
        table: tableName,
        dataViewMode: 'schema',
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };

  // Open a loaded SQL file into a new query tab. Used by the Import SQL
  // dialog's "Open in editor" option — the user gets a Monaco editor
  // prefilled with the file contents so they can review/edit before
  // running.
  const handleImportToEditor = (connectionId: string, fileName: string, sql: string) => {
    const tileDb = focusedTile && focusedTile.serverId === connectionId
      ? focusedTile.databaseName
      : undefined;
    const newTab: AppTab = {
      id: `query-import-${connectionId}-${Date.now()}`,
      title: fileName || 'Imported SQL',
      type: 'query',
      connectionId,
      schema: tileDb,
      query: sql,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewQuery = (connectionId: string, tableName?: string) => {
    let initialQuery = '';
    const connection = activeConnections.find(c => c.id === connectionId);

    if (tableName && connection) {
      // Branch on the manifest's query-editor language, not the driver
      // name — keeps the comment/template right when adapters of new
      // languages get added.
      const manifest = resolveManifest(adapterManifests, connection.driver);
      const lang = manifest?.queryEditor?.language?.trim() ?? 'sql';
      if (lang === 'mongo') {
        initialQuery = `// Query example for ${tableName}\ndb.getCollection('${tableName}').find({\n  // Add filter conditions here\n}).limit(100);`;
      } else {
        initialQuery = `-- Query example for ${tableName}\nSELECT * FROM ${tableName}\nLIMIT 100;`;
      }
    }

    // Capture the currently-focused database (from the rail) so the editor
    // can prepend `USE` and scope autocomplete even though the connection
    // profile's default database is often blank.
    const tileDb = focusedTile && focusedTile.serverId === connectionId
      ? focusedTile.databaseName
      : undefined;

    const newTab: AppTab = {
      id: `query-${connectionId}-${Date.now()}`,
      title: tableName ? `Query: ${tableName}` : 'Query',
      type: 'query',
      connectionId,
      schema: tileDb,
      query: initialQuery,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewRealtime = (connectionId: string) => {
    // Reuse an existing realtime tab on the same connection instead of
    // stacking new ones — the typical use case is "watch and come back",
    // and a fresh tab would discard the event buffer the user accumulated.
    const existing = tabs.find(t => t.type === 'realtime' && t.connectionId === connectionId);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTab: AppTab = {
      id: `realtime-${connectionId}-${Date.now()}`,
      title: 'Realtime',
      type: 'realtime',
      connectionId,
      realtimePattern: '*',
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleTabRealtimePatternChange = (tabId: string, pattern: string) => {
    setTabs(prev => prev.map(t => (t.id === tabId ? { ...t, realtimePattern: pattern } : t)));
  };

  // ⌘+T / Ctrl+T opens a new query tab for the currently-focused connection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        const target = focusedConnection?.id ?? activeConnections[0]?.id;
        if (!target) return;
        e.preventDefault();
        handleNewQuery(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedConnection, activeConnections, focusedTile]);

  // ⌘+W / Ctrl+W closes the active tab. preventDefault so the browser's own
  // close-window shortcut doesn't fire on the Tauri webview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
        if (!activeTabId) return;
        e.preventDefault();
        handleCloseTab(activeTabId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // ⌘+R / Ctrl+R soft-reloads the sidebar tree + active tab's data instead of
  // refreshing the whole page. We preventDefault so the browser's own reload
  // doesn't unload the app. Components that hold their own data (Sidebar,
  // DataGrid, DiagramView) listen for the `dbtable:reload` event and refetch.
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
      const isR = e.code === 'KeyR' || e.key.toLowerCase() === 'r';
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
      window.dispatchEvent(new CustomEvent('dbtable:reload', {
        detail: { connectionId: target ?? null },
      }));
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKey, { capture: true });
  }, [focusedConnection]);

  const handleOpenDefinition = (connectionId: string, key: string, title: string, sql: string) => {
    // Stable id derived from the (connection, object) pair so re-opening the
    // same view / routine focuses the existing tab instead of creating a new
    // one. Dropping Date.now() here is the whole point of taking `key`.
    const id = `def-${connectionId}-${key}`;
    const existing = tabs.find(t => t.id === id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTab: AppTab = {
      id,
      title: `Edit: ${title}`,
      type: 'query',
      connectionId,
      query: sql,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleOpenRoutine = (
    connectionId: string,
    schema: string,
    name: string,
    kind: 'function' | 'procedure',
  ) => {
    const id = `routine-${connectionId}-${schema}.${name}`;
    const existing = tabs.find(t => t.id === id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTab: AppTab = {
      id,
      title: name,
      type: 'routine',
      connectionId,
      schema,
      routine: { schema, name, kind },
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewTable = (connectionId: string, schema: string) => {
    const id = `new-table-${connectionId}-${schema}-${Date.now()}`;
    const newTab: AppTab = {
      id,
      title: 'New table',
      type: 'structure',
      connectionId,
      schema,
      table: '(new)',
      isNew: true,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewRoutine = (connectionId: string, schema: string, kind: 'function' | 'procedure') => {
    const id = `new-routine-${connectionId}-${schema}-${kind}-${Date.now()}`;
    const newTab: AppTab = {
      id,
      title: `New ${kind}`,
      type: 'routine',
      connectionId,
      schema,
      routine: { schema, name: '(new)', kind },
      isNew: true,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewView = (connectionId: string, schema: string) => {
    const id = `new-view-${connectionId}-${schema}-${Date.now()}`;
    const newTab: AppTab = {
      id,
      title: 'New view',
      type: 'routine',
      connectionId,
      schema,
      routine: { schema, name: '(new)', kind: 'view' },
      isNew: true,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleOpenErd = (connectionId: string, schemaName: string, tableName?: string) => {
    // Refresh the schema list + FK metadata so any consumer reflects tables /
    // columns / foreign keys added since the last cache read.
    void refreshSchemas(connectionId);
    window.dispatchEvent(new CustomEvent('dbtable:reload', { detail: { connectionId } }));

    if (tableName) {
      // Table-scoped ERD: reuse the table's data tab and flip its internal
      // view mode to 'diagram'. Mirrors how "Open Schema" reuses the data
      // tab — one tab per table with Data / Schema / Diagram toggles.
      const existingTab = tabs.find(
        t => t.type === 'data' && t.table === tableName && t.schema === schemaName && t.connectionId === connectionId,
      );
      if (existingTab) {
        setTabs(prev => prev.map(t => (t.id === existingTab.id ? { ...t, dataViewMode: 'diagram' } : t)));
        setActiveTabId(existingTab.id);
      } else {
        const newTab: AppTab = {
          id: `data-${connectionId}-${schemaName}.${tableName}-${Date.now()}`,
          title: tableName,
          type: 'data',
          connectionId,
          schema: schemaName,
          table: tableName,
          dataViewMode: 'diagram',
        };
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);
      }
      return;
    }

    // Schema-scoped ERD stays as its own dedicated tab.
    const id = `erd-${connectionId}-${schemaName}`;
    const title = `ERD: ${schemaName}`;
    const newTab: AppTab = {
      id,
      title,
      type: 'erd',
      connectionId,
      schema: schemaName,
      schemaName,
    };
    if (!tabs.find(t => t.id === newTab.id)) {
      setTabs(prev => [...prev, newTab]);
    }
    setActiveTabId(newTab.id);
  };

  // Two pins on the same server are distinct workspaces, so tab scope keys
  // always include the schema — only connection-scoped query tabs (no schema)
  // fall back to the raw connection id.
  const tabScopeKey = (t: AppTab): string =>
    t.schema ? `${t.connectionId}::${t.schema}` : t.connectionId;

  const handleCloseTab = (id: string) => {
    // Drop the data-cache entry for this tab — the grid snapshot is only
    // useful while the tab is open, and holding onto it leaks memory across
    // long sessions.
    clearCachedGrid(id);
    clearQueryResultSnapshot(id);
    setTabs(prev => {
      const closing = prev.find(t => t.id === id);
      const newTabs = prev.filter(t => t.id !== id);
      if (closing) {
        const scope = tabScopeKey(closing);
        if (activeTabByConn[scope] === id) {
          const siblings = newTabs.filter(t => tabScopeKey(t) === scope);
          const prevSiblings = prev.filter(t => tabScopeKey(t) === scope);
          const index = prevSiblings.findIndex(t => t.id === id);
          setActiveTabByConn(map => {
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

  const handleCloseTabs = (mode: 'all' | 'others' | 'left' | 'right', anchorId: string) => {
    setTabs(prev => {
      const anchor = prev.find(t => t.id === anchorId);
      if (!anchor) return prev;
      const scope = tabScopeKey(anchor);
      // Apply close semantics within the anchor's own scope — other scopes
      // aren't visible to the user right now, so touching them would be
      // surprising.
      const siblings = prev.filter(t => tabScopeKey(t) === scope);
      const idxInSiblings = siblings.findIndex(t => t.id === anchorId);
      let keptSiblings: AppTab[];
      switch (mode) {
        case 'all': keptSiblings = []; break;
        case 'others': keptSiblings = [siblings[idxInSiblings]]; break;
        case 'left': keptSiblings = siblings.slice(idxInSiblings); break;
        case 'right': keptSiblings = siblings.slice(0, idxInSiblings + 1); break;
      }
      const keptIds = new Set(keptSiblings.map(t => t.id));
      const kept = prev.filter(t => tabScopeKey(t) !== scope || keptIds.has(t.id));
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
        setActiveTabByConn(map => {
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
    setTabs(prev => prev.map(t => (t.id === tabId ? { ...t, dataViewMode: mode } : t)));
  };

  // Persist the editor buffer back onto the query tab so it survives tab
  // switches and app reloads. Closing the tab drops the entry entirely.
  const handleTabQueryChange = (tabId: string, query: string) => {
    setTabs(prev => prev.map(t => (t.id === tabId && t.query !== query ? { ...t, query } : t)));
  };

  // A "new table" structure tab successfully created its table on the
  // server. Re-target the tab at the now-real table: drop the
  // `(new)` placeholder, swap in the real name, clear `isNew`, retitle.
  // Without this, the schema view would stay stuck in create-mode
  // (the dirty calc keeps reading "● unsaved changes" forever even
  // though everything is on disk).
  const handleTabTableCreated = (tabId: string, savedName: string) => {
    setTabs(prev =>
      prev.map(t =>
        t.id === tabId && t.type === 'structure'
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
  const writeQueryTabRef = useRef<(e: { toolCallId?: string; connectionId?: string; schema?: string; sql: string; mode: 'new' | 'replace'; title?: string }) => void>(
    () => {},
  );
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
      toast.error('No active connection — cannot write query tab');
      return;
    }
    const fallbackTitle = (() => {
      const snippet = ev.sql.replace(/\s+/g, ' ').trim();
      return snippet.length > 36 ? snippet.slice(0, 36) + '…' : snippet;
    })();
    const title = ev.title?.trim() || fallbackTitle || 'AI Query';

    if (ev.mode === 'replace') {
      // Replacement priority:
      //   1. The currently-focused query tab. First choice — matches user intent.
      //   2. Otherwise (user is on a routine/view/data tab), the most recent
      //      AI-owned query tab on the same connection. Prevents a pile of
      //      duplicate tabs when the user keeps iterating with the AI while
      //      staring at a function/view.
      //   3. Neither → fall through to 'new'.
      // The SqlEditor syncs the new value in place via an effect on its
      // `initialQuery` prop — no remount, no flicker.
      const activeQuery = visibleTabs.find(t => t.id === activeTabId && t.type === 'query');
      const aiOwned = tabs
        .filter(t => t.type === 'query' && t.connectionId === targetConn && t.aiOwned)
        .slice(-1)[0];
      const target = activeQuery ?? aiOwned;
      if (target) {
        setTabs(prev => prev.map(t => (
          t.id === target.id ? { ...t, query: ev.sql, title, aiOwned: true } : t
        )));
        setActiveTabId(target.id);
        toast.success(activeQuery ? 'Replaced current query tab' : 'Updated AI query tab');
        return;
      }
      // No tab to replace — fall through to new.
    }
    const newTab: AppTab = {
      id: `query-${targetConn}-${Date.now()}`,
      title,
      type: 'query',
      connectionId: targetConn,
      schema: ev.schema ?? (focusedTile?.serverId === targetConn ? focusedTile.databaseName : undefined),
      query: ev.sql,
      aiOwned: true,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    toast.success(ev.mode === 'replace' ? 'Opened new query tab (no active tab to replace)' : 'Opened new query tab');
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void ai.onTabWrite((ev) => writeQueryTabRef.current(ev)).then((fn) => {
      unlisten = fn;
    });
    return () => { unlisten?.(); };
  }, []);

  const handleSaveNewConnection = (conn: ConnectionProfile) => {
    onAddConnection(conn);
    setNewConnectionOpen(false);
    onConnect(conn.id);
  };

  return (
    <div className="flex-1 flex bg-background relative mac-vibrancy min-w-0" style={contentMaxWidthStyle}>
      <ConnectionRail
        servers={connections}
        focusedTileId={focusedTileId}
        onFocusTile={handleFocusTile}
        onDisconnectServer={(id) => {
          // Evict every cached grid belonging to tabs on this connection
          // before the connection closes — otherwise stale rows would linger
          // in memory (and reappear if the user reconnects).
          const idsToClear = tabs.filter(t => t.connectionId === id).map(t => t.id);
          clearCachedGridsWhere(tid => idsToClear.includes(tid));
          onDisconnect(id);
        }}
        onEditServer={() => { /* TODO M-W-4 edit-server flow */ }}
        onImportSql={(id) => setImportSqlForId(id)}
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
        onOpenNewServer={() => setNewConnectionOpen(true)}
        onPinDatabase={handlePinDatabase}
        onOpenDefinition={handleOpenDefinition}
        onOpenRoutine={handleOpenRoutine}
        onNewTable={handleNewTable}
        onNewView={handleNewView}
        onNewRoutine={handleNewRoutine}
        onOpenRealtime={handleNewRealtime}
        activeItem={(() => {
          const tab = visibleTabs.find(t => t.id === activeTabId);
          if (!tab || !tab.schema) return null;
          // Data + structure tabs represent a table or view — we distinguish
          // by whether that name appears in the view list for the schema.
          if ((tab.type === 'data' || tab.type === 'structure') && tab.table && tab.table !== '(new)') {
            const schemas = connState.schemasById.get(tab.connectionId) ?? [];
            const schema = schemas.find(s => s.name === tab.schema);
            const kind = schema?.tables.find(t => t.name === tab.table)?.kind;
            return {
              type: kind === 'view' ? 'view' : 'table',
              connectionId: tab.connectionId,
              schema: tab.schema,
              name: tab.table,
            };
          }
          if (tab.type === 'routine' && tab.routine && tab.routine.name !== '(new)') {
            return {
              type: tab.routine.kind === 'view' ? 'view' : 'routine',
              connectionId: tab.connectionId,
              schema: tab.schema,
              name: tab.routine.name,
              routineKind: tab.routine.kind === 'view' ? undefined : tab.routine.kind,
            };
          }
          return null;
        })()}
      />

      <div className="flex-1 flex flex-col min-w-0 bg-background border-l border-border/50">
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
                const next = Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, startW + dx));
                setChatWidth(next);
              };
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
              document.body.style.cursor = 'ew-resize';
              document.body.style.userSelect = 'none';
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
            focus={computeFocusHint(visibleTabs.find(t => t.id === activeTabId))}
          />
        </div>
      )}

      <ConnectionModal
        isOpen={newConnectionOpen}
        onClose={() => setNewConnectionOpen(false)}
        onSave={handleSaveNewConnection}
      />

      <ImportSqlDialog
        isOpen={importSqlForId !== null}
        onClose={() => setImportSqlForId(null)}
        connectionId={importSqlForId}
        connectionName={
          importSqlForId
            ? (connections.find(c => c.id === importSqlForId)?.name ?? 'connection')
            : ''
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
            const profile = connections.find(c => c.id === importSqlForId);
            if (profile?.driver === 'SQLite') return null;
            if (profile?.driver === 'PostgreSQL') return null;
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
            const profile = connections.find(c => c.id === importSqlForId);
            if (profile?.driver === 'MySQL') return 'mysql';
            if (profile?.driver === 'SQLite') return 'sqlite';
            if (profile?.driver === 'PostgreSQL') return 'postgres';
            return null;
          })()
        }
        onOpenInEditor={handleImportToEditor}
      />
    </div>
  );
}
