import { useEffect } from 'react';
import { ConnectionProfile } from '../../types';
import MacWindowControls from '../workspace/mac-window-controls';
import { Database, Unplug, Pencil, FileUp } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '../../components/ui/context-menu';
import { refreshRail, unpinTile, useRail, unpinManyTiles } from '../../state/rail';
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

export const RAIL_COLLAPSED_WIDTH = 72;
export const RAIL_EXPANDED_WIDTH = 220;

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
      className="shrink-0 flex flex-col bg-sidebar-bg/70 border-r border-border/50 h-full transition-[width] duration-200 ease-out overflow-hidden"
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
          return (
            <ContextMenu key={tile.id}>
              <ContextMenuTrigger>
                <button
                  type="button"
                  onClick={() => onFocusTile(tile)}
                  title={expanded ? undefined : `${primary} · ${secondary}`}
                  className={`relative w-full rounded-md text-left transition-colors cursor-pointer
                    ${expanded
                      ? 'h-11 flex items-center gap-2.5 px-2'
                      : 'h-14 flex flex-col items-center justify-center gap-0.5 px-1 py-1.5'}
                    ${isFocused
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
                >
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

    </div>
  );
}
