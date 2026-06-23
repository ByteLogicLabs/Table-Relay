import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionProfile, type ConnectionTag } from './types';
import WorkspaceView from './features/workspace/workspace-view';
import WelcomeView from './features/workspace/welcome-view';
import { Toaster } from './components/ui/sonner';
import DevDebug from './components/dev-debug';
import { UpdateNotice } from './components/update-notice';
import { setDebugPage } from './state/debug';
import { loadSettings, hydrateSettings, applyTheme } from './lib/settings-store';
import { hydrateCredentials } from './lib/ai-credentials';
import { hydrateAutoApprovals } from './lib/ai-permissions';
import { connectionsStore, type ConnectionProfileRecord } from './lib/connections-store';
import { isDbError } from './lib/db';
import { connectAndLoad, disconnect as disconnectDb, markConnectionLost, useConnections } from './state/connections';
import { getRailSnapshot, refreshRail, unpinManyTiles, useRail } from './state/rail';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import SecurityGate from './features/security/security-gate';

const LEGACY_STORAGE_KEY = 'db_connections';

function fromRecord(p: ConnectionProfileRecord): ConnectionProfile {
  return {
    id: p.id,
    name: p.name,
    driver: p.driver,
    host: p.host,
    port: p.port,
    user: p.user ?? '',
    password: p.password ?? undefined,
    database: p.database ?? undefined,
    sslMode: (p.sslMode ?? undefined) as ConnectionProfile['sslMode'],
    sshEnabled: p.sshEnabled,
    sshHost: p.sshHost ?? undefined,
    sshPort: p.sshPort ?? undefined,
    sshUser: p.sshUser ?? undefined,
    sshAuthKind: p.sshAuthKind ?? undefined,
    sshKeyPath: p.sshKeyPath ?? undefined,
    sshPassword: p.sshPassword ?? undefined,
    sshKeyPassphrase: p.sshKeyPassphrase ?? undefined,
    color: p.color ?? undefined,
    isFavorite: p.isFavorite,
    tag: p.tag ?? undefined,
    tagColor: p.tagColor ?? undefined,
    tags: parseTags(p.tags, p.tag, p.tagColor),
  };
}

/** Parse the stored tags JSON; fall back to the legacy single tag/tagColor so
 *  pre-multi-tag connections still show their tag. */
function parseTags(
  tagsJson: string | null | undefined,
  legacyTag: string | null | undefined,
  legacyColor: string | null | undefined,
): ConnectionTag[] {
  if (tagsJson) {
    try {
      const arr = JSON.parse(tagsJson);
      if (Array.isArray(arr)) {
        return arr
          .filter((t) => t && typeof t.name === 'string' && t.name.trim() !== '')
          .map((t) => ({ name: String(t.name), color: String(t.color || 'Gray') }));
      }
    } catch { /* fall through to legacy */ }
  }
  if (legacyTag && legacyTag.trim() !== '') {
    return [{ name: legacyTag, color: legacyColor || 'Gray' }];
  }
  return [];
}

export default function App() {
  return (
    <SecurityGate>
      <UnlockedApp />
    </SecurityGate>
  );
}

function UnlockedApp() {
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [activeConnectionIds, setActiveConnectionIds] = useState<string[]>([]);
  const connState = useConnections();
  const rail = useRail();
  // Stable reference to the current list so the reconnect listener (attached
  // once at mount) can still resolve a connection name without re-subscribing.
  const connectionsRef = useRef<ConnectionProfile[]>([]);
  useEffect(() => { connectionsRef.current = connections; }, [connections]);
  // Track the toast id per connection so we can replace "Reconnecting..." with
  // the success/failure variant instead of stacking three unrelated toasts.
  const reconnectToastIds = useRef<Map<string, string | number>>(new Map());
  const connectingToastIds = useRef<Map<string, string | number>>(new Map());
  const bootReconnectAttempted = useRef(false);

  const reload = useCallback(async () => {
    try {
      const list = await connectionsStore.list();
      setConnections(list.map(fromRecord));
    } catch (e) {
      console.error('Failed to load connections from store', e);
    }
  }, []);

  // Apply persisted theme on mount (defaults to One Dark).
  useEffect(() => {
    void (async () => {
      const settings = await hydrateSettings();
      await hydrateCredentials();
      applyTheme(settings.theme);
      // Restore remembered AI permissions into the backend (in-memory) state so
      // they apply before the first chat turn. No-op unless the user enabled
      // "Remember AI permissions across restarts".
      void hydrateAutoApprovals();
    })();
  }, []);

  useEffect(() => {
    void refreshRail();
  }, []);

  // Forward native menu "Settings…" click to the frontend.
  useEffect(() => {
    const unsub = listen<void>('menu-app-settings', () => {
      window.dispatchEvent(new CustomEvent('tablerelay:open-settings'));
    });
    return () => { void unsub.then(fn => fn()); };
  }, []);

  // Import / Export Connections opens Settings → Import / Export. Handled here
  // in the always-mounted root (not WorkspaceView) so it works on the home /
  // welcome screen too, where the workspace and its menu listeners aren't
  // mounted. The Settings dialog lives inside both Welcome and Workspace and
  // listens for this same window event.
  useEffect(() => {
    const unsub = listen<void>('menu-connection-transfer', () => {
      window.dispatchEvent(
        new CustomEvent('tablerelay:open-settings', { detail: { section: 'data' } }),
      );
    });
    return () => { void unsub.then(fn => fn()); };
  }, []);

  useEffect(() => {
    const onChanged = () => { void reload(); };
    window.addEventListener('tablerelay:connections-changed', onChanged);
    return () => window.removeEventListener('tablerelay:connections-changed', onChanged);
  }, [reload]);

  // Instantly dismiss connecting toasts when a connection is cancelled
  useEffect(() => {
    const onCancel = (e: Event) => {
      const { connectionId } = (e as CustomEvent<{ connectionId: string }>).detail;
      const toastId = connectingToastIds.current.get(connectionId);
      if (toastId) {
        toast.dismiss(toastId);
        connectingToastIds.current.delete(connectionId);
      }
    };
    window.addEventListener('tablerelay:cancel-connect', onCancel);
    return () => window.removeEventListener('tablerelay:cancel-connect', onCancel);
  }, []);

  // Listen for reconnect lifecycle events emitted by the Rust supervisor. On
  // `connection:lost` we drop the id from the active set so the rail tile and
  // tabs flip to a disconnected state automatically.
  useEffect(() => {
    interface ReconnectEvent {
      connectionId: string;
      attempt: number;
      maxAttempts: number;
      error?: string;
    }
    const nameOf = (id: string) =>
      connectionsRef.current.find(c => c.id === id)?.name ?? id;

    const unlisteners: Array<() => void> = [];
    void (async () => {
      const unA = await listen<ReconnectEvent>('connection:reconnecting', (ev) => {
        const { connectionId, attempt, maxAttempts } = ev.payload;
        const name = nameOf(connectionId);
        const existing = reconnectToastIds.current.get(connectionId);
        const id = toast.loading(`Reconnecting to ${name} (${attempt}/${maxAttempts})…`, {
          id: existing,
        });
        reconnectToastIds.current.set(connectionId, id);
      });
      const unB = await listen<ReconnectEvent>('connection:reconnected', (ev) => {
        const { connectionId } = ev.payload;
        const name = nameOf(connectionId);
        const existing = reconnectToastIds.current.get(connectionId);
        toast.success(`Reconnected to ${name}`, { id: existing });
        reconnectToastIds.current.delete(connectionId);
        // Re-add to the active set. `connection:lost` removed it (unmounting
        // the connection's data grids), so without this its tabs stay blank
        // even after the socket recovers — the user had to manually re-focus
        // it to bring them back. Re-adding remounts the grids, which seed
        // instantly from the surviving tab-data cache (Chrome-tab behaviour:
        // a backgrounded connection keeps its rows and comes back on its own).
        setActiveConnectionIds(prev => (prev.includes(connectionId) ? prev : [...prev, connectionId]));
      });
      const unC = await listen<ReconnectEvent>('connection:lost', (ev) => {
        const { connectionId, error } = ev.payload;
        const name = nameOf(connectionId);
        const existing = reconnectToastIds.current.get(connectionId);
        toast.error(`Connection to ${name} lost`, {
          id: existing,
          description: error,
        });
        reconnectToastIds.current.delete(connectionId);
        markConnectionLost(connectionId);
        setActiveConnectionIds(prev => prev.filter(cId => cId !== connectionId));
      });
      unlisteners.push(unA, unB, unC);
    })();
    return () => { unlisteners.forEach(u => u()); };
  }, []);

  // On boot, auto-reconnect ONLY the connection the user last had focused, so
  // they land back on the database they were looking at — WITHOUT eagerly
  // connecting every other pinned server (which fired N× db_connect +
  // N× list_schemas on startup and hammered the network for connections the
  // user isn't even looking at). The other tiles still restore into the rail;
  // they connect lazily the moment the user clicks one (handleFocusTile in
  // workspace-view connects on demand). If the rail is empty the WelcomeView
  // takes over and the user explicitly picks a connection.
  useEffect(() => {
    if (bootReconnectAttempted.current) return;
    if (connections.length === 0) return;
    // Tiles still restore into the rail regardless; this setting only governs
    // whether we auto-reconnect on boot. One-shot effect, so read the store
    // directly rather than via the hook.
    if (!loadSettings().restoreOnStartup) return;
    const tiles = getRailSnapshot();
    if (tiles.length === 0) return;
    bootReconnectAttempted.current = true;
    // Resolve the focused server from the restored encrypted rail. Workspace
    // focus is hydrated after mount; cold boot reconnect can safely use the
    // first pinned tile.
    const focusedTile = tiles[0];
    const sid = focusedTile?.serverId;
    if (!sid || !connections.find(c => c.id === sid)) return;
    void (async () => {
      try {
        await connectAndLoad(sid);
        setActiveConnectionIds(prev => (prev.includes(sid) ? prev : [...prev, sid]));
      } catch (err) {
        // Don't toast on cold-boot — the rail tile renders disconnected and
        // the user can retry / it connects on next focus.
        console.warn('Auto-reconnect (focused) failed', sid, err);
      }
    })();
  }, [connections.length, rail.tiles.length]);

  // One-time import of any legacy localStorage seed into the SQLite store.
  useEffect(() => {
    void (async () => {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        try {
          const parsed: ConnectionProfile[] = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const c of parsed) {
              await connectionsStore.save({
                name: c.name,
                driver: c.driver,
                host: c.host,
                port: Number(c.port),
                user: c.user,
                password: typeof c.password === 'string' && c.password !== '***' ? c.password : undefined,
                database: c.database,
                sshEnabled: !!c.sshEnabled,
                color: c.color,
                isFavorite: !!c.isFavorite,
              });
            }
            toast.success(`Imported ${parsed.length} connection${parsed.length === 1 ? '' : 's'}`);
          }
        } catch (e) {
          console.warn('Legacy connections migration skipped', e);
        } finally {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      }
      await reload();
    })();
  }, [reload]);

  const handleConnect = async (id: string) => {
    const name = connectionsRef.current.find(c => c.id === id)?.name ?? 'database';
    const toastId = toast.loading(`Connecting to ${name}…`);
    connectingToastIds.current.set(id, toastId);
    try {
      const meta = await connectAndLoad(id);
      connectingToastIds.current.delete(id);
      if (!meta) {
        // User cancelled the in-flight connect (or it was superseded). Don't
        // open the connection or claim success — just clear the toast.
        toast.dismiss(toastId);
        return;
      }
      setActiveConnectionIds(prev => (prev.includes(id) ? prev : [...prev, id]));
      toast.success(`Connected to ${name}`, { id: toastId });
    } catch (err) {
      connectingToastIds.current.delete(id);
      toast.error(isDbError(err) ? err.message : String(err), { id: toastId });
    }
  };

  const handleDisconnect = async (id: string) => {
    await disconnectDb(id);
    setActiveConnectionIds(prev => prev.filter(cId => cId !== id));
  };

  const saveConnectionRecord = async (conn: ConnectionProfile) => {
    const saved = await connectionsStore.save({
      id: conn.id,
      name: conn.name,
      driver: conn.driver,
      host: conn.host,
      port: Number(conn.port),
      user: conn.user,
      password: conn.password,
      database: conn.database,
      sslMode: conn.sslMode,
      sshEnabled: !!conn.sshEnabled,
      sshHost: conn.sshHost || undefined,
      sshPort: conn.sshPort !== undefined && conn.sshPort !== '' ? Number(conn.sshPort) : undefined,
      sshUser: conn.sshUser || undefined,
      sshAuthKind: conn.sshAuthKind,
      sshKeyPath: conn.sshKeyPath || undefined,
      sshPassword: conn.sshPassword || undefined,
      sshKeyPassphrase: conn.sshKeyPassphrase || undefined,
      color: conn.color,
      isFavorite: !!conn.isFavorite,
      // Multi-tag: persist the array as JSON, and mirror the first tag into the
      // legacy tag/tagColor columns for back-compat.
      tags: conn.tags && conn.tags.length > 0 ? JSON.stringify(conn.tags) : undefined,
      tag: conn.tags?.[0]?.name ?? conn.tag ?? undefined,
      tagColor: conn.tags?.[0]?.color ?? conn.tagColor ?? undefined,
    });
    await reload();
    return saved.id;
  };

  const handleAddConnection = async (conn: ConnectionProfile) => {
    // Save first — if that fails we never reach the connect step. The
    // saved record carries the canonical id (persisted + validated by
    // the store), which is what `connectAndLoad` needs.
    let savedId: string;
    try {
      savedId = await saveConnectionRecord(conn);
    } catch (e) {
      toast.error(`Failed to save connection: ${String(e)}`);
      throw e;
    }

    // Auto-connect the freshly-saved profile — that's what "Save & Connect"
    // in the modal implies. Keep the failure path noisy but non-fatal: the
    // row is saved and visible in the sidebar, so the user can retry via
    // the connect action without re-entering credentials.
    //
    // Push the id into `activeConnectionIds` BEFORE awaiting `connectAndLoad`
    // so the sidebar mounts for this connection immediately and sees
    // `isConnecting=true` → renders the "Connecting to X…" spinner. If we
    // wait for `connectAndLoad` to resolve first, fast adapters (SQLite,
    // local MySQL) finish the connect + first schema fetch before the
    // sidebar has a chance to render any loading UI, and the user perceives
    // an unexplained blank pane for those seconds.
    setActiveConnectionIds(prev => (prev.includes(savedId) ? prev : [...prev, savedId]));
    const toastId = toast.loading(`Connecting to ${conn.name}…`);
    connectingToastIds.current.set(savedId, toastId);
    try {
      const meta = await connectAndLoad(savedId);
      connectingToastIds.current.delete(savedId);
      if (!meta) {
        toast.dismiss(toastId);
        setActiveConnectionIds(prev => prev.filter(cId => cId !== savedId));
        return;
      }
      toast.success(`Connected to ${conn.name}`, { id: toastId });
    } catch (err) {
      connectingToastIds.current.delete(savedId);
      toast.error(isDbError(err) ? err.message : String(err), { id: toastId });
      // Remove the optimistically-added id so handleEditConnection doesn't
      // treat this as an active connection and attempt a spurious reconnect.
      setActiveConnectionIds(prev => prev.filter(cId => cId !== savedId));
    }
  };

  const handleEditConnection = async (conn: ConnectionProfile, previousId = conn.id) => {
    const idChanged = previousId !== conn.id;
    const wasActive = connState.activeById.has(previousId) || activeConnectionIds.includes(previousId);
    try {
      if (idChanged) {
        await disconnectDb(previousId);
      }
      await saveConnectionRecord(conn);
      if (idChanged) {
        await connectionsStore.remove(previousId);
        setActiveConnectionIds(prev => prev.filter(cId => cId !== previousId));
      }
      // Always refresh the in-memory list so edits (tags, name, color, …) show
      // immediately in the sidebar / cards, not just when the id changed.
      await reload();
    } catch (e) {
      toast.error(`Failed to save connection: ${String(e)}`);
      throw e;
    }

    toast.success(`Saved ${conn.name}`);
    if (!wasActive) return;

    const toastId = toast.loading(`Reconnecting to ${conn.name}…`);
    connectingToastIds.current.set(conn.id, toastId);
    try {
      if (!idChanged) {
        await disconnectDb(conn.id);
      }
      setActiveConnectionIds(prev => (prev.includes(conn.id) ? prev : [...prev, conn.id]));
      const meta = await connectAndLoad(conn.id, true);
      connectingToastIds.current.delete(conn.id);
      if (!meta) {
        toast.dismiss(toastId);
        setActiveConnectionIds(prev => prev.filter(cId => cId !== conn.id));
        return;
      }
      toast.success(`Reconnected to ${conn.name}`, { id: toastId });
    } catch (err) {
      connectingToastIds.current.delete(conn.id);
      setActiveConnectionIds(prev => prev.filter(cId => cId !== conn.id));
      toast.error(isDbError(err) ? err.message : String(err), { id: toastId });
      throw err;
    }
  };

  const handleDeleteConnection = async (id: string) => {
    try {
      await connectionsStore.remove(id);
      setActiveConnectionIds(prev => prev.filter(cId => cId !== id));
      // Remove any rail tiles that were pinned for this connection.
      const staleTiles = getRailSnapshot().filter(t => t.serverId === id).map(t => t.id);
      if (staleTiles.length > 0) await unpinManyTiles(staleTiles);
      await reload();
    } catch (e) {
      toast.error(`Failed to delete connection: ${String(e)}`);
    }
  };

  const activeConnections = connections.filter(c => activeConnectionIds.includes(c.id) || connState.activeById.has(c.id));
  // Home rule: no saved connections → always welcome screen.
  // Otherwise show workspace if there are active connections or pinned tiles.
  const showWorkspace = connections.length > 0 && (activeConnectionIds.length > 0 || connState.activeById.size > 0 || rail.tiles.length > 0);

  // Push to the debug store as a side effect — calling setState during render
  // schedules a re-render of DevDebug mid-commit, which React warns about.
  useEffect(() => {
    setDebugPage({ view: showWorkspace ? 'workspace' : 'welcome' });
  }, [showWorkspace]);

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      <div className="flex-1 flex overflow-hidden relative">
        {showWorkspace ? (
          <WorkspaceView
            activeConnections={activeConnections}
            activeConnectionIds={activeConnectionIds}
            onDisconnect={handleDisconnect}
            connections={connections}
            onConnect={handleConnect}
            onAddConnection={handleAddConnection}
            onEditConnection={handleEditConnection}
            onDeleteConnection={handleDeleteConnection}
          />
        ) : (
          <WelcomeView
            connections={connections}
            onConnect={handleConnect}
            onAddConnection={handleAddConnection}
            onEditConnection={handleEditConnection}
            onDeleteConnection={handleDeleteConnection}
          />
        )}
      </div>
      <Toaster position="top-right" />
      <UpdateNotice />
      <DevDebug />
    </div>
  );
}
