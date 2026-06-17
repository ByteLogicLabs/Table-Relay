import { useState, useEffect, useMemo } from 'react';
import { ConnectionProfile } from '../../types';
import { Button, buttonVariants } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Search, Plus, Settings, Database, MoreVertical, Edit, Copy, Trash2, Star, ChevronDown, Check, X, LayoutGrid, List, Zap } from 'lucide-react';
import ConnectionModal from '../connections/connection-modal';
import SettingsDialog from '../settings/settings-dialog';
import FavoritesSidebar from './favorites-sidebar';
import { tagsOf, visibleTags, getTagColors } from './favorites-types';
import { getTagColor } from '../../lib/tag-colors';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '../../components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { toast } from 'sonner';
import DbIcon from '../../components/db-icon';
import { useConnections, cancelConnect } from '../../state/connections';
import { getAppState, setAppState } from '../../lib/app-state-store';
import { displayEndpoint } from '../../lib/connection-display';
import { SSH_BADGE_CLASS } from '../../lib/driver-colors';

interface WelcomeViewProps {
  connections: ConnectionProfile[];
  onConnect: (id: string) => void;
  onAddConnection: (conn: ConnectionProfile) => void | Promise<void>;
  onEditConnection: (conn: ConnectionProfile, previousId?: string) => void | Promise<void>;
  onDeleteConnection: (id: string) => void;
}

export default function WelcomeView({
  connections,
  onConnect,
  onAddConnection,
  onEditConnection,
  onDeleteConnection
}: WelcomeViewProps) {
  const [search, setSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionProfile | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const connState = useConnections();

  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');

  useEffect(() => {
    void (async () => {
      const storedView = await getAppState<'card' | 'list'>('connections_view_mode_v1');
      if (storedView === 'card' || storedView === 'list') setViewMode(storedView);
    })();
  }, []);

  const changeViewMode = (mode: 'card' | 'list') => {
    setViewMode(mode);
    void setAppState('connections_view_mode_v1', mode);
  };

  // The Settings dialog normally lives in the connection rail, but the rail
  // isn't mounted on this welcome screen — so the native menu "Settings…"
  // (⌘+,) and the in-app gear button had nothing to open. Host a dialog here
  // and listen for the same `tablerelay:open-settings` event the rail uses.
  useEffect(() => {
    const handler = (e: Event) => {
      const section = (e as CustomEvent<{ section?: string }>).detail?.section;
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener('tablerelay:open-settings', handler);
    return () => window.removeEventListener('tablerelay:open-settings', handler);
  }, []);

  // All distinct tags across connections (name + first-seen color), for the
  // tag filter beside the search bar.
  const allTags = useMemo(() => {
    const byName = new Map<string, { name: string; color: string }>();
    for (const c of connections) for (const t of tagsOf(c)) {
      if (t.name.trim() === '' || byName.has(t.name)) continue;
      byName.set(t.name, { name: t.name, color: t.color });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [connections]);

  const toggleTagFilter = (name: string) =>
    setSelectedTags(prev => (prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]));

  const q = search.toLowerCase();
  const filteredConnections = connections.filter(c => {
    const matchesSearch = c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    // OR match: a connection passes if it carries ANY of the selected tags.
    if (selectedTags.length === 0) return true;
    const names = new Set(tagsOf(c).map(t => t.name));
    return selectedTags.some(t => names.has(t));
  });

  const handleConnect = (id: string) => {
    // Kicks off the real connect in app.tsx, which drives the
    // store's `connectingIds` set we read from below.
    if (connState.connectingIds.has(id)) return;
    onConnect(id);
  };

  const handleDuplicate = (conn: ConnectionProfile) => {
    const newConn = { ...conn, id: Date.now().toString(), name: `${conn.name} (Copy)` };
    onAddConnection(newConn);
    toast.success('Connection duplicated');
  };

  const hasFavorites = connections.some(c => c.isFavorite);

  return (
    <div className="flex-1 flex bg-background relative mac-vibrancy">
      {hasFavorites && (
        <FavoritesSidebar
          connections={connections}
          onConnect={handleConnect}
          onEditConnection={onEditConnection}
        />
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <div
          data-tauri-drag-region
          className={`h-12 border-b border-border/50 flex items-center justify-end pr-6 ${
            // No "Connections" heading here — it collided with / sat awkwardly
            // beside the macOS traffic lights. The header is now just a drag
            // region carrying the search + Add Connection controls on the right.
            // Still reserve left clearance for the traffic lights (78px = the
            // rail's RAIL_COLLAPSED_WIDTH) when there's no Favorites sidebar to
            // cover that corner.
            hasFavorites ? 'pl-6' : 'pl-19.5'
            }`}
        >
          <div className="flex items-center gap-2">
            <div className="relative w-72">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search connections..."
                className="pl-9 h-9 bg-muted/50 border-none focus-visible:ring-1"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Tag filter (multi-select, OR match) */}
            {allTags.length > 0 && (
              <Popover>
                <PopoverTrigger
                  className={buttonVariants({
                    variant: 'outline',
                    className: `h-9 gap-1.5 data-popup-open:bg-accent ${selectedTags.length > 0 ? 'text-foreground' : 'text-muted-foreground'}`,
                  })}
                >
                  <span>{selectedTags.length > 0 ? `${selectedTags.length} tag${selectedTags.length > 1 ? 's' : ''} selected` : 'Tags'}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                </PopoverTrigger>
                <PopoverContent align="end" className="w-60 p-0 overflow-hidden">
                  {selectedTags.length > 0 && (
                    <div className="flex items-center justify-end px-3 py-2 border-b border-border">
                      <button
                        type="button"
                        onClick={() => setSelectedTags([])}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                  <div className="max-h-72 overflow-y-auto p-1 flex flex-col gap-1">
                    {allTags.map(t => {
                      const c = getTagColor(t.color);
                      const active = selectedTags.includes(t.name);
                      return (
                        <button
                          key={t.name}
                          type="button"
                          onClick={() => toggleTagFilter(t.name)}
                          className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left transition-colors ${active ? 'bg-accent' : 'hover:bg-muted'}`}
                        >
                          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${c.dot}`} />
                          <span className="truncate flex-1">{t.name}</span>
                          {active && <Check className="w-4 h-4 shrink-0 text-primary" />}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            <Button className="h-9" onClick={() => { setEditingConnection(undefined); setIsModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              Add Connection
            </Button>
            <div className="inline-flex items-center h-9 rounded-md border border-border bg-muted/40 p-1">
              <button
                type="button"
                onClick={() => changeViewMode('card')}
                title="Card view"
                aria-label="Card view"
                aria-pressed={viewMode === 'card'}
                className={`flex items-center justify-center h-7 w-7 rounded transition-colors ${
                  viewMode === 'card'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => changeViewMode('list')}
                title="List view"
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
                className={`flex items-center justify-center h-7 w-7 rounded transition-colors ${
                  viewMode === 'list'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <List className="w-4 h-4" />
              </button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-8 py-6">
          {connections.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <Database className="w-16 h-16 mb-4 opacity-20" />
              <p className="text-lg font-medium mb-2">No connections yet</p>
              <p className="text-sm mb-6">Add a database connection to get started.</p>
              <Button onClick={() => { setEditingConnection(undefined); setIsModalOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" />
                Add Connection
              </Button>
            </div>
          ) : filteredConnections.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <Search className="w-14 h-14 mb-6 opacity-20" />
              <p className="text-lg font-medium mb-2">No connections match</p>
              <p className="text-sm mb-8">
                {search.trim() && selectedTags.length > 0
                  ? 'Try a different search or tag filter.'
                  : selectedTags.length > 0
                    ? 'No connections have the selected tag' + (selectedTags.length > 1 ? 's' : '') + '.'
                    : 'No connections match your search.'}
              </p>
              <div className="flex items-center gap-3">
                {search.trim() && (
                  <Button variant="outline" onClick={() => setSearch('')}>Clear search</Button>
                )}
                {selectedTags.length > 0 && (
                  <Button variant="outline" onClick={() => setSelectedTags([])}>Clear tag filter</Button>
                )}
              </div>
            </div>
          ) : viewMode === 'list' ? (
            <div className="flex flex-col gap-2">
              {filteredConnections.map(conn => {
                const isConnecting = connState.connectingIds.has(conn.id);
                return (
                  <div
                    key={conn.id}
                    className={`group relative flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 cursor-pointer transition-all hover:border-primary/40 hover:shadow-sm ${isConnecting ? 'pointer-events-none opacity-75' : ''}`}
                    onClick={() => handleConnect(conn.id)}
                  >
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                      <DbIcon driver={conn.driver} className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate">{conn.name}</span>
                        {visibleTags(conn).shown.map(t => (
                          <span key={t.name} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full select-none shrink-0 ${getTagColors(t.color).bg} ${getTagColors(t.color).text}`}>
                            {t.name}
                          </span>
                        ))}
                        {visibleTags(conn).overflow > 0 && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">+{visibleTags(conn).overflow}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 min-w-0">
                        {conn.sshEnabled && (
                          <span className={`px-1.5 py-0.5 rounded shrink-0 ${SSH_BADGE_CLASS}`}>SSH</span>
                        )}
                        <span className="truncate">{displayEndpoint(conn)}</span>
                      </div>
                    </div>
                    {isConnecting ? (
                      <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
                        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        Connecting…
                        <Button size="sm" variant="outline" className="h-7" onClick={(e) => { e.stopPropagation(); cancelConnect(conn.id); }}>Cancel</Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className={`h-8 w-8 hover:bg-transparent ${conn.isFavorite ? 'text-amber-500 hover:text-amber-600' : 'hidden! group-hover:inline-flex! focus:inline-flex! text-muted-foreground hover:text-amber-500'}`}
                          onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); }}
                          title={conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                        >
                          <Star className={`w-4 h-4 ${conn.isFavorite ? 'fill-current text-amber-500' : ''}`} />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'h-8 w-8 hidden! group-hover:inline-flex! focus:inline-flex! data-popup-open:inline-flex!' })}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }}>
                              <Zap className="w-4 h-4 mr-2" /> Connect
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); }}>
                              <Star className="w-4 h-4 mr-2" /> {conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setEditingConnection(conn); setIsModalOpen(true); }}>
                              <Edit className="w-4 h-4 mr-2" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDuplicate(conn); }}>
                              <Copy className="w-4 h-4 mr-2" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={(e) => { e.stopPropagation(); if (confirm(`Are you sure you want to delete '${conn.name}'?`)) onDeleteConnection(conn.id); }}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5">
              {filteredConnections.map(conn => (
                <div
                  key={conn.id}
                  className="group bg-card border border-border hover:shadow-md transition-all cursor-pointer relative rounded-xl p-5"
                  onClick={() => handleConnect(conn.id)}
                >
                  {connState.connectingIds.has(conn.id) && (
                    <div className="absolute inset-0 bg-background/80 backdrop-blur-sm rounded-xl flex items-center justify-center z-10">
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs font-medium">Connecting...</span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 mt-1"
                          onClick={(e) => { e.stopPropagation(); cancelConnect(conn.id); }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {(() => {
                    const actions = (
                      <div className="flex items-center gap-1 shrink-0 -mt-2">
                        {/* Star: always shown (filled) when favorited; otherwise
                            only appears on hover, like the kebab. */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className={`h-8 w-8 hover:bg-transparent transition-colors duration-200 ${conn.isFavorite ? 'text-amber-500 hover:text-amber-600' : 'hidden! group-hover:inline-flex! text-muted-foreground hover:text-amber-500'}`}
                          onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); }}
                          title={conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                        >
                          <Star className={`w-4 h-4 ${conn.isFavorite ? 'fill-current text-amber-500' : ''}`} />
                        </Button>
                        {/* Kebab is display:none at rest (takes no space, so the
                            star sits flush at the right), shown on hover / when
                            its menu is open. */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'h-8 w-8 hidden! group-hover:inline-flex! focus:inline-flex! data-popup-open:inline-flex!' })}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }}>
                              <Zap className="w-4 h-4 mr-2" /> Connect
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); }}>
                              <Star className="w-4 h-4 mr-2" /> {conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setEditingConnection(conn); setIsModalOpen(true); }}>
                              <Edit className="w-4 h-4 mr-2" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDuplicate(conn); }}>
                              <Copy className="w-4 h-4 mr-2" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive whitespace-nowrap"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Are you sure you want to delete '${conn.name}'?`)) onDeleteConnection(conn.id);
                              }}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                    const { shown: shownTags, overflow: tagOverflow } = visibleTags(conn);
                    const tag = (
                      <>
                        {shownTags.map(t => (
                          <span key={t.name} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full select-none ${getTagColors(t.color).bg} ${getTagColors(t.color).text}`}>
                            {t.name}
                          </span>
                        ))}
                        {tagOverflow > 0 && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">+{tagOverflow}</span>
                        )}
                      </>
                    );

                    return (
                      <>
                        <div className="flex justify-between items-start mb-4">
                          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                            <DbIcon driver={conn.driver} className="w-5 h-5" />
                          </div>
                          {actions}
                        </div>
                        <h3 className="font-semibold text-base mb-1 truncate">{conn.name}</h3>
                        <div className="text-sm text-muted-foreground flex flex-col gap-1">
                          <span className="truncate">{displayEndpoint(conn)}</span>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {conn.sshEnabled && (
                              <span className={`text-[10px] px-2 py-0.5 rounded-md w-fit ${SSH_BADGE_CLASS}`}>SSH</span>
                            )}
                            {tag}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConnectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={async (conn) => {
          if (editingConnection) {
            await onEditConnection(conn, editingConnection.id);
          } else {
            await onAddConnection(conn);
          }
          setIsModalOpen(false);
        }}
        initialData={editingConnection}
        existingTags={(() => {
          const byName = new Map<string, { name: string; color: string }>();
          for (const c of connections) for (const t of tagsOf(c)) {
            if (t.name.trim() === '' || byName.has(t.name)) continue;
            byName.set(t.name, { name: t.name, color: t.color });
          }
          return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
        })()}
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialSection={settingsSection} />
    </div>
  );
}
