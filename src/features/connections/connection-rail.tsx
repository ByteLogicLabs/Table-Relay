import { useCallback, useEffect, useRef, useState } from 'react';
import SettingsDialog from '../settings/settings-dialog';
import { ConnectionProfile } from '../../types';
import MacWindowControls from '../workspace/mac-window-controls';
import { Database, Settings, Unplug, Pencil, FileUp, FileDown, Loader2, Copy, Power } from 'lucide-react';
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
import { copyText } from '../../lib/clipboard';
import { SSH_BADGE_CLASS } from '../../lib/driver-colors';
import { isUriHost } from '../../lib/connection-display';
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

const URI_SCHEME: Record<ConnectionProfile['driver'], string | null> = {
  PostgreSQL: 'postgresql',
  MySQL: 'mysql',
  MongoDB: 'mongodb',
  Redis: 'redis',
  SQLite: null,
};

/** Best-effort connection string for the driver, or null when one doesn't
 *  apply (SQLite is a file path; URI hosts already carry their own string). */
function buildConnectionString(c: ConnectionProfile): string | null {
  // Mongo (and any URI-host driver) already stores a full URI in `host`.
  if (isUriHost(c.host)) return c.host;
  const scheme = URI_SCHEME[c.driver];
  if (!scheme) return c.driver === 'SQLite' ? c.host : null;
  const auth = c.user
    ? `${encodeURIComponent(c.user)}${c.password ? `:${encodeURIComponent(c.password)}` : ''}@`
    : '';
  const port = c.port ? `:${c.port}` : '';
  const db = c.database ? `/${c.database}` : '';
  return `${scheme}://${auth}${c.host}${port}${db}`;
}

/** Full, labeled dump of a connection including credentials. */
function buildFullInfo(c: ConnectionProfile): string {
  const lines: string[] = [];
  const add = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`);
  };
  add('Name', c.name);
  add('Driver', c.driver);
  add('Host', c.host);
  add('Port', c.port);
  add('User', c.user);
  add('Password', c.password);
  add('Database', c.database);
  add('SSL Mode', c.sslMode);
  if (c.sshEnabled) {
    add('SSH Host', c.sshHost);
    add('SSH Port', c.sshPort);
    add('SSH User', c.sshUser);
    add('SSH Auth', c.sshAuthKind);
    add('SSH Key Path', c.sshKeyPath);
    add('SSH Password', c.sshPassword);
    add('SSH Key Passphrase', c.sshKeyPassphrase);
  }
  const uri = buildConnectionString(c);
  if (uri) {
    lines.push('');
    add('Connection String', uri);
  }
  return lines.join('\n');
}

interface RailTileRowProps {
  tile: RailTile;
  server: ConnectionProfile | undefined;
  isFocused: boolean;
  primary: string;
  secondary: string;
  connected: boolean;
  isConnecting: boolean;
  expanded: boolean;
  tiles: RailTile[];
  onOpenChange: (open: boolean) => void;
  onFocusTile: (tile: RailTile) => void;
  onEditServer: (serverId: string) => void;
  onImportSql: (serverId: string) => void;
  onExport: (serverId: string) => void;
  onDisconnectServer: (serverId: string) => void;
  supportsImport: (serverId: string) => boolean;
  supportsExport: (serverId: string) => boolean;
}

function RailTileRow({
  tile,
  server,
  isFocused,
  primary,
  secondary,
  connected,
  isConnecting,
  expanded,
  tiles,
  onOpenChange,
  onFocusTile,
  onEditServer,
  onImportSql,
  onExport,
  onDisconnectServer,
  supportsImport,
  supportsExport,
}: RailTileRowProps) {
  const handleFocus = useCallback(() => onFocusTile(tile), [onFocusTile, tile]);
  const handleEdit = useCallback(() => {
    if (server) onEditServer(server.id);
  }, [onEditServer, server]);
  const handleImport = useCallback(() => {
    if (server) onImportSql(server.id);
  }, [onImportSql, server]);
  const handleExport = useCallback(() => {
    if (server) onExport(server.id);
  }, [onExport, server]);
  const handleCopyInfo = useCallback(() => {
    const text = server
      ? buildFullInfo(server)
      : [primary, secondary].join('\n');
    void copyText(text, server ? 'Copied connection info (with credentials)' : 'Copied pin info');
  }, [server, primary, secondary]);
  const handleDisconnect = useCallback(() => {
    if (server && connected) onDisconnectServer(server.id);
    void unpinTile(tile.id);
  }, [server, connected, onDisconnectServer, tile.id]);
  const handleDisconnectOthers = useCallback(() => {
    const others = tiles.filter(t => t.id !== tile.id);
    const otherServerIds = new Set(others.map(t => t.serverId));
    otherServerIds.forEach(id => onDisconnectServer(id));
    void unpinManyTiles(others.map(t => t.id));
  }, [tiles, tile.id, onDisconnectServer]);
  const handleDisconnectAll = useCallback(() => {
    const serverIds = new Set(tiles.map(t => t.serverId));
    serverIds.forEach(id => onDisconnectServer(id));
    void unpinManyTiles(tiles.map(t => t.id));
  }, [tiles, onDisconnectServer]);

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger>
        <div className="relative group/tile">
        <button
          type="button"
          // Focusing a tile must always work — even while it (or
          // another tile) is mid-connect. A slow connect, especially
          // over SSH, shouldn't trap the user on the connecting tile;
          // they need to be able to switch to a different connection.
          // The spinner badge still signals the in-flight state.
          onClick={handleFocus}
          title={expanded ? undefined : `${primary} · ${secondary}`}
          className={`relative w-full rounded-md text-left transition-colors cursor-pointer
            ${expanded
              ? 'h-11 flex items-center gap-2.5 px-2'
              : 'h-14 flex flex-col items-center justify-center gap-0.5 px-1 py-1.5'}
            ${isFocused
              ? 'bg-primary/15 text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
        >
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
                    className={`shrink-0 rounded px-1 py-px text-[8px] font-semibold tracking-wide leading-none ${SSH_BADGE_CLASS}`}
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
                  className={`shrink-0 rounded px-0.5 text-[7px] font-semibold tracking-wide leading-none ${SSH_BADGE_CLASS}`}
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
        {server && (
          <ContextMenuItem onClick={handleEdit}>
            <Pencil className="w-3.5 h-3.5 mr-2" /> Edit connection
          </ContextMenuItem>
        )}
        {server && connected && supportsImport(server.id) && (
          <ContextMenuItem onClick={handleImport}>
            <FileUp className="w-3.5 h-3.5 mr-2" /> Import data…
          </ContextMenuItem>
        )}
        {server && connected && supportsExport(server.id) && (
          <ContextMenuItem onClick={handleExport}>
            <FileDown className="w-3.5 h-3.5 mr-2" /> Export data…
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={handleCopyInfo}>
          <Copy className="w-3.5 h-3.5 mr-2" /> Copy info
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/*
          Disconnect is the unpin action now — dropping the tile from
          the rail and closing the underlying connection are the same
          user intent, so we collapsed the two into one item.
        */}
        <ContextMenuItem
          className="text-destructive focus:text-destructive whitespace-nowrap"
          onClick={handleDisconnect}
        >
          <Unplug className="w-3.5 h-3.5 mr-2" /> Disconnect
        </ContextMenuItem>
        {tiles.length > 1 && (
          <>
            <ContextMenuItem
              className="text-destructive focus:text-destructive whitespace-nowrap"
              onClick={handleDisconnectOthers}
            >
              <Unplug className="w-3.5 h-3.5 mr-2" /> Disconnect others
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive whitespace-nowrap"
              onClick={handleDisconnectAll}
            >
              <Power className="w-3.5 h-3.5 mr-2" /> Disconnect all
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
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
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  useEffect(() => {
    const handler = (e: Event) => {
      const section = (e as CustomEvent<{ section?: string }>).detail?.section;
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener('tablerelay:open-settings', handler);
    return () => window.removeEventListener('tablerelay:open-settings', handler);
  }, []);
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
    // portals/overlays that eat `pointerleave`.
    const checkOutside = (e: PointerEvent) => {
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
  }, [expanded, menuOpen, settingsOpen, onExpandChange]);


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

  const handleRootPointerEnter = useCallback(() => onExpandChange(true), [onExpandChange]);
  const handleRootPointerLeave = useCallback(() => {
    // Don't collapse while a menu/dialog is open — those own the pointer.
    if (!menuOpen && !settingsOpen) onExpandChange(false);
  }, [menuOpen, settingsOpen, onExpandChange]);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);

  return (
    <div
      ref={rootRef}
      onPointerEnter={handleRootPointerEnter}
      onPointerLeave={handleRootPointerLeave}
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
          return (
            <RailTileRow
              key={tile.id}
              tile={tile}
              server={server}
              isFocused={isFocused}
              primary={primary}
              secondary={secondary}
              connected={connected}
              isConnecting={isConnecting}
              expanded={expanded}
              tiles={rail.tiles}
              onOpenChange={setMenuOpen}
              onFocusTile={onFocusTile}
              onEditServer={onEditServer}
              onImportSql={onImportSql}
              onExport={onExport}
              onDisconnectServer={onDisconnectServer}
              supportsImport={supportsImport}
              supportsExport={supportsExport}
            />
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
          onClick={handleOpenSettings}
          title="Settings"
          className={`relative w-full rounded-lg text-left transition-colors cursor-pointer text-muted-foreground hover:bg-muted/60 hover:text-foreground
            ${expanded ? 'h-9 flex items-center gap-2.5 px-2' : 'h-10 flex flex-col items-center justify-center gap-0.5'}`}
        >
          <Settings className="w-4 h-4 shrink-0" />
          {expanded && <span className="text-[13px] font-medium">Settings</span>}
        </button>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialSection={settingsSection} />
    </div>
  );
}
