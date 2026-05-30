import { useEffect, useRef, useState } from 'react';
import SettingsDialog from '../settings/settings-dialog';
import { ConnectionProfile } from '../../types';
import MacWindowControls from '../workspace/mac-window-controls';
import { Database, GripVertical, Settings, Unplug, Pencil, FileUp } from 'lucide-react';
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
  connectedServerIds,
  expanded,
  onExpandChange,
}: ConnectionRailProps) {
  const rail = useRail();
  useEffect(() => { void refreshRail(); }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('dbtable:open-settings', handler);
    return () => window.removeEventListener('dbtable:open-settings', handler);
  }, []);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragSrcRef = useRef<string | null>(null);

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
  };

  const serversById = new Map(servers.map(s => [s.id, s]));
  const connState = useConnections();
  const manifests = useAdapterManifests();

  function supportsImport(serverId: string): boolean {
    const driver = serversById.get(serverId)?.driver;
    const manifest = resolveManifest(manifests, driver);
    // Default to `true` while manifests load so the menu item doesn't
    // flicker in/out; once resolved, unsupported drivers hide it.
    return manifest ? manifest.capabilities.import.length > 0 : true;
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
      onMouseEnter={() => onExpandChange(true)}
      onMouseLeave={() => onExpandChange(false)}
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
          const secondary = ver
            ? `${ver} · ${tile.databaseName}`
            : `${server?.driver ?? '?'} · ${tile.databaseName}`;
          const connected = connectedServerIds.has(tile.serverId);
          const isDragging = draggingId === tile.id;
          const isOver = overId === tile.id;
          return (
            <ContextMenu key={tile.id}>
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
                    {connected && (
                      <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-background" />
                    )}
                  </span>
                  {expanded ? (
                    <span className="min-w-0 flex-1 transition-opacity duration-150 opacity-100">
                      <span className="block text-[13px] font-medium truncate leading-tight">{primary}</span>
                      <span className="block text-[10.5px] text-muted-foreground truncate leading-tight">
                        {secondary}
                      </span>
                    </span>
                  ) : (
                    <span className="block w-full text-[9px] font-medium text-center truncate leading-tight">
                      {tile.databaseName}
                    </span>
                  )}
                </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-56">
                <ContextMenuItem onClick={() => onFocusTile(tile)}>Focus</ContextMenuItem>
                {server && (
                  <ContextMenuItem onClick={() => onEditServer(server.id)}>
                    <Pencil className="w-3.5 h-3.5 mr-2" /> Edit server
                  </ContextMenuItem>
                )}
                {server && connected && supportsImport(server.id) && (
                  <ContextMenuItem onClick={() => onImportSql(server.id)}>
                    <FileUp className="w-3.5 h-3.5 mr-2" /> Import SQL…
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
                  className="text-destructive focus:text-destructive"
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
                      className="text-destructive focus:text-destructive"
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
                      className="text-destructive focus:text-destructive"
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
