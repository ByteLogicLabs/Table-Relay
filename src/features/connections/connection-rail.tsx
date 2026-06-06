import { useEffect, useRef, useState } from 'react';
import SettingsDialog from '../settings/settings-dialog';
import { ConnectionProfile } from '../../types';
import MacWindowControls from '../workspace/mac-window-controls';
import { Database, GripVertical, Settings, Unplug, Pencil, FileUp, FileDown, Loader2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '../../components/ui/context-menu';
import { refreshRail, unpinTile, useRail, unpinManyTiles, reorderTiles } from '../../state/rail';
import { useConnections } from '../../state/connections';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { toast } from 'sonner';
import type { RailTile } from '../../lib/rail';
import DbIcon from '../../components/db-icon';

interface ConnectionRailProps {
  servers: ConnectionProfile[];
  /** Currently-focused tile id (one of `RailTile.id`). */
  focusedTileId: string | null;
  /** Click a tile → focus it (workspace switches to that server + db). */
  onFocusTile: (tile: RailTile) => void;
  /** Kebab → Disconnect server (does NOT unpin the tile). */
  onDisconnectServer: (serverId: string) => void;
  /** Kebab → Edit server credentials. */
  onEditServer: (serverId: string) => void;
  /** Kebab → Import SQL file into this server's current database. */
  onImportSql: (serverId: string) => void;
  /** Kebab → Export the connection's active table (data tab). */
  onExport: (serverId: string) => void;
  /** Connected server ids — render dot indicator. */
  connectedServerIds: Set<string>;
  expanded: boolean;
  onExpandChange: (expanded: boolean) => void;
}

export const RAIL_COLLAPSED_WIDTH = 78;
export const RAIL_EXPANDED_WIDTH = 240;

function driverIcon(driver: ConnectionProfile['driver'], className = 'w-4 h-4') {
  return <DbIcon driver={driver} className={className} />;
}

export default function ConnectionRail({
  servers,
  focusedTileId,
  onFocusTile,
  onDisconnectServer,
  onEditServer,
  onImportSql,
  onExport,
  connectedServerIds,
  expanded,
  onExpandChange,
}: ConnectionRailProps) {
  const rail = useRail();
  useEffect(() => { void refreshRail(); }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('tablerelay:open-settings', handler);
    return () => window.removeEventListener('tablerelay:open-settings', handler);
  }, []);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragSrcRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // True while a tile's context menu is open. Its popup renders in a portal
  // that can sit outside the rail's bounds, so we must NOT auto-collapse the
  // rail while it's up — that would yank the menu's anchor out from under it.
  const [menuOpen, setMenuOpen] = useState(false);

  // The rail expands on hover and collapses when the pointer leaves. Relying on
  // a single `onMouseLeave` is fragile: a context-menu/dialog portal, a drag
  // ghost, or the window losing focus can swallow the leave event, wedging the
  // rail open (its width feeds the content area's max-width, so a stuck-open
  // rail also narrows the grid). These safety nets force a re-sync to the real
  // pointer position whenever a leave event might have been missed.
  useEffect(() => {
    if (!expanded) return;
    // Don't fight an open context menu or settings dialog — those own the
    // pointer and the rail should stay put until they close.
    if (menuOpen || settingsOpen) return;
    // Collapse if the pointer ends up outside the rail for any reason — covers
    // portals/overlays that eat `pointerleave`. Skipped while dragging so the
    // drop target stays visible.
    const checkOutside = (e: PointerEvent) => {
      if (draggingId) return;
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const outside =
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (outside) onExpandChange(false);
    };
    const onBlur = () => onExpandChange(false);
    document.addEventListener('pointermove', checkOutside);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointermove', checkOutside);
      window.removeEventListener('blur', onBlur);
    };
  }, [expanded, draggingId, menuOpen, settingsOpen, onExpandChange]);

  const handleDragStart = (id: string) => {
    dragSrcRef.current = id;
    setDraggingId(id);
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (dragSrcRef.current !== id) setOverId(id);
  };

  const handleDrop = (targetId: string) => {
    const srcId = dragSrcRef.current;
    if (!srcId || srcId === targetId) return;
    const ids = rail.tiles.map(t => t.id);
    const from = ids.indexOf(srcId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, srcId);
    reorderTiles(next);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setOverId(null);
    dragSrcRef.current = null;
    // A drag can swallow the `pointerleave` that would normally collapse the
    // rail, leaving it stuck open. The pointermove safety net re-syncs on the
    // next move, but collapse immediately if the pointer already rests outside.
    const el = rootRef.current;
    if (el && !el.matches(':hover')) onExpandChange(false);
  };

  const serversById = new Map(servers.map(s => [s.id, s]));
  const connState = useConnections();
  const manifests = useAdapterManifests();

  function supportsImport(serverId: string): boolean {
    const driver = serversById.get(serverId)?.driver;
    const manifest = resolveManifest(manifests, driver);
    // Default to `true` while manifests load so the menu item doesn't
    // flicker in/out; once resolved, unsupported drivers hide it. Import is
    // offered when the adapter declares file formats OR can ingest rows
    // (document stores like Mongo take CSV/JSON via insert_rows).
    return manifest
      ? manifest.capabilities.import.length > 0 || manifest.capabilities.insertRows
      : true;
  }

  function supportsExport(serverId: string): boolean {
    const driver = serversById.get(serverId)?.driver;
    const manifest = resolveManifest(manifests, driver);
    // Default to `true` while manifests load; once resolved, adapters that
    // declare no export formats hide the item.
    return manifest ? manifest.capabilities.export.length > 0 : true;
  }

  function versionLabel(serverId: string): string | null {
    const meta = connState.activeById.get(serverId);
    if (!meta) return null;
    const { flavor, versionMajor, versionMinor, version } = meta.server;
    if (flavor && versionMajor != null && versionMinor != null) {
      return `${flavor} ${versionMajor}.${versionMinor}`;
    }
    return version || null;
  }

  return (
    <div
      ref={rootRef}
      onPointerEnter={() => onExpandChange(true)}
      onPointerLeave={() => {
        // Don't collapse mid-drag — the user needs the expanded tiles as drop
        // targets — nor while a menu/dialog is open. The drag-end handler +
        // pointermove net handle collapse for those cases.
        if (!draggingId && !menuOpen && !settingsOpen) onExpandChange(false);
      }}
      style={{ width: expanded ? RAIL_EXPANDED_WIDTH : RAIL_COLLAPSED_WIDTH }}
      className="shrink-0 flex flex-col bg-sidebar-bg/70 border-r border-border h-full transition-[width] duration-200 ease-out overflow-hidden"
    >
      <MacWindowControls />

      <div className="flex-1 w-full flex flex-col gap-0.5 pt-1 px-1.5 overflow-y-auto overflow-x-hidden">
        {rail.tiles.map(tile => {
          const server = serversById.get(tile.serverId);
          const isFocused = tile.id === focusedTileId;
          const primary = tile.label ?? server?.name ?? '(missing server)';
          const ver = versionLabel(tile.serverId);
          const dbLabel = tile.databaseName || '…';
          const secondary = ver
            ? `${ver} · ${dbLabel}`
            : `${server?.driver ?? '?'} · ${dbLabel}`;
          const connected = connectedServerIds.has(tile.serverId);
          const isConnecting = connState.connectingIds.has(tile.serverId);
          const isDragging = draggingId === tile.id;
          const isOver = overId === tile.id;
          return (
            <ContextMenu key={tile.id} onOpenChange={setMenuOpen}>
              <ContextMenuTrigger>
                <div
                  draggable
                  onDragStart={() => handleDragStart(tile.id)}
                  onDragOver={(e) => handleDragOver(e, tile.id)}
                  onDrop={() => handleDrop(tile.id)}
                  onDragEnd={handleDragEnd}
                  className={`relative group/tile transition-opacity ${isDragging ? 'opacity-40' : 'opacity-100'}`}
                >
                  {isOver && <div className="absolute -top-px left-1 right-1 h-0.5 rounded-full bg-primary z-10" />}
                <button
                  type="button"
                  // Focusing a tile must always work — even while it (or
                  // another tile) is mid-connect. A slow connect, especially
                  // over SSH, shouldn't trap the user on the connecting tile;
                  // they need to be able to switch to a different connection.
                  // The spinner badge still signals the in-flight state.
                  onClick={() => onFocusTile(tile)}
                  title={expanded ? undefined : `${primary} · ${secondary}`}
                  className={`relative w-full rounded-md text-left transition-colors cursor-pointer
                    ${expanded
                      ? 'h-11 flex items-center gap-2.5 px-2'
                      : 'h-14 flex flex-col items-center justify-center gap-0.5 px-1 py-1.5'}
                    ${isFocused
                      ? 'bg-primary/15 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
                >
                  {expanded && (
                    <GripVertical className="absolute left-0.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/30 opacity-0 group-hover/tile:opacity-100 transition-opacity cursor-grab" />
                  )}
                  <span
                    className="relative flex items-center justify-center shrink-0"
                    style={server?.color ? { color: server.color } : undefined}
                  >
                    {server ? driverIcon(server.driver, 'w-5 h-5') : <Database className="w-5 h-5" />}
                    {isConnecting ? (
                      <Loader2 className="absolute -top-0.5 -right-1 w-2.5 h-2.5 animate-spin text-primary" />
                    ) : connected ? (
                      <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-background" />
                    ) : null}
                  </span>
                  {expanded ? (
                    <span className="min-w-0 flex-1 transition-opacity duration-150 opacity-100">
                      <span className="block text-[13px] font-medium truncate leading-tight">{primary}</span>
                      {/* SSH-tunnel marker — a tiny "SSH" text badge in the meta
                          line so the user can tell which connections route
                          through a jump host. Kept off the driver logo (overlap
                          looked cluttered) and inline so it never collides. */}
                      <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground leading-tight min-w-0">
                        {server?.sshEnabled && (
                          <span
                            className="shrink-0 rounded px-1 py-px text-[8px] font-semibold tracking-wide leading-none bg-primary text-primary-foreground"
                            title={server.sshHost ? `SSH tunnel via ${server.sshHost}` : 'SSH tunnel'}
                          >
                            SSH
                          </span>
                        )}
                        <span className="truncate">{secondary}</span>
                      </span>
                    </span>
                  ) : (
                    <span className="flex w-full items-center justify-center gap-0.5 text-[9px] font-medium leading-tight min-w-0">
                      {server?.sshEnabled && (
                        <span
                          className="shrink-0 rounded px-0.5 text-[7px] font-semibold tracking-wide leading-none bg-primary text-primary-foreground"
                          title="SSH tunnel"
                        >
                          SSH
                        </span>
                      )}
                      <span className="truncate">{tile.databaseName || '…'}</span>
                    </span>
                  )}
                </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-56">
                <ContextMenuItem onClick={() => onFocusTile(tile)}>Focus</ContextMenuItem>
                {server && (
                  <ContextMenuItem onClick={() => onEditServer(server.id)}>
                    <Pencil className="w-3.5 h-3.5 mr-2" /> Edit connection
                  </ContextMenuItem>
                )}
                {server && connected && supportsImport(server.id) && (
                  <ContextMenuItem onClick={() => onImportSql(server.id)}>
                    <FileUp className="w-3.5 h-3.5 mr-2" /> Import data…
                  </ContextMenuItem>
                )}
                {server && connected && supportsExport(server.id) && (
                  <ContextMenuItem onClick={() => onExport(server.id)}>
                    <FileDown className="w-3.5 h-3.5 mr-2" /> Export data…
                  </ContextMenuItem>
                )}
                <ContextMenuItem
                  onClick={() => {
                    const text = [primary, secondary].join('\n');
                    void navigator.clipboard.writeText(text);
                    toast.success('Copied pin info');
                  }}
                >
                  Copy info
                </ContextMenuItem>
                <ContextMenuSeparator />
                {/*
                  Disconnect is the unpin action now — dropping the tile from
                  the rail and closing the underlying connection are the same
                  user intent, so we collapsed the two into one item.
                */}
                <ContextMenuItem
                  className="text-destructive focus:text-destructive whitespace-nowrap"
                  onClick={() => {
                    if (server && connected) onDisconnectServer(server.id);
                    void unpinTile(tile.id);
                  }}
                >
                  <Unplug className="w-3.5 h-3.5 mr-2" /> Disconnect
                </ContextMenuItem>
                {rail.tiles.length > 1 && (
                  <>
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive whitespace-nowrap"
                      onClick={() => {
                        const others = rail.tiles.filter(t => t.id !== tile.id);
                        const otherServerIds = new Set(others.map(t => t.serverId));
                        otherServerIds.forEach(id => onDisconnectServer(id));
                        void unpinManyTiles(others.map(t => t.id));
                      }}
                    >
                      Disconnect others
                    </ContextMenuItem>
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive whitespace-nowrap"
                      onClick={() => {
                        const serverIds = new Set(rail.tiles.map(t => t.serverId));
                        serverIds.forEach(id => onDisconnectServer(id));
                        void unpinManyTiles(rail.tiles.map(t => t.id));
                      }}
                    >
                      Disconnect all
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {rail.tiles.length === 0 && expanded && (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            No pinned databases yet. Open a connection to add one.
          </div>
        )}
      </div>

      {/* Settings button */}
      <div className="shrink-0 px-1.5 pb-2 pt-1 border-t border-border/40">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          className={`relative w-full rounded-lg text-left transition-colors cursor-pointer text-muted-foreground hover:bg-muted/60 hover:text-foreground
            ${expanded ? 'h-9 flex items-center gap-2.5 px-2' : 'h-10 flex flex-col items-center justify-center gap-0.5'}`}
        >
          <Settings className="w-4 h-4 shrink-0" />
          {expanded && <span className="text-[13px] font-medium">Settings</span>}
        </button>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
