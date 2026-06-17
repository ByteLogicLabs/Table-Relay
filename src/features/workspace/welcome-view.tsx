import { useState, useEffect, useMemo } from 'react';
import { ConnectionProfile } from '../../types';
import { Button, buttonVariants } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Search, Plus, Settings, Database, MoreVertical, Edit, Copy, Trash2, Star, ChevronRight, ChevronDown, Folder, FolderPlus, Check, X } from 'lucide-react';
import ConnectionModal from '../connections/connection-modal';
import SettingsDialog from '../settings/settings-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '../../components/ui/dropdown-menu';
import { toast } from 'sonner';
import MacWindowControls from './mac-window-controls';
import DbIcon from '../../components/db-icon';
import { useConnections, cancelConnect } from '../../state/connections';
import { getAppState, setAppState } from '../../lib/app-state-store';
const getTagColors = (colorName?: string) => {
  switch (colorName) {
    case 'Red':
      return { bg: 'bg-rose-100 dark:bg-rose-950/40', text: 'text-rose-700 dark:text-rose-300' };
    case 'Orange':
      return { bg: 'bg-orange-100 dark:bg-orange-950/40', text: 'text-orange-700 dark:text-orange-300' };
    case 'Yellow':
      return { bg: 'bg-amber-100 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-300' };
    case 'Green':
      return { bg: 'bg-emerald-100 dark:bg-emerald-950/40', text: 'text-emerald-700 dark:text-emerald-300' };
    case 'Blue':
      return { bg: 'bg-blue-100 dark:bg-blue-950/40', text: 'text-blue-700 dark:text-blue-300' };
    case 'Purple':
      return { bg: 'bg-purple-100 dark:bg-purple-950/40', text: 'text-purple-700 dark:text-purple-300' };
    case 'Gray':
    default:
      return { bg: 'bg-slate-100 dark:bg-slate-900/60', text: 'text-slate-700 dark:text-slate-300' };
  }
};

interface FavoriteGroup {
  id: string;
  name: string;
  isCollapsed?: boolean;
}

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
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionProfile | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const connState = useConnections();

  const [groups, setGroups] = useState<FavoriteGroup[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({}); // connectionId -> groupId
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  useEffect(() => {
    void (async () => {
      const storedGroups = await getAppState<FavoriteGroup[]>('favorite_groups_v1');
      if (storedGroups) setGroups(storedGroups);

      const storedMappings = await getAppState<Record<string, string>>('favorite_group_mappings_v1');
      if (storedMappings) setMappings(storedMappings);
    })();
  }, []);

  const handleSaveGroup = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;

    if (groups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
      toast.error('Group with this name already exists');
      return;
    }

    const newGroup: FavoriteGroup = {
      id: Date.now().toString(),
      name,
      isCollapsed: false,
    };

    const updated = [...groups, newGroup];
    setGroups(updated);
    void setAppState('favorite_groups_v1', updated);
    setIsCreatingGroup(false);
    setNewGroupName('');
    toast.success('Group created');
  };

  const handleMoveToGroup = (connectionId: string, groupId: string) => {
    const updated = { ...mappings };
    if (groupId) {
      updated[connectionId] = groupId;
    } else {
      delete updated[connectionId];
    }
    setMappings(updated);
    void setAppState('favorite_group_mappings_v1', updated);
    toast.success('Group updated');
  };

  const handleToggleCollapse = (groupId: string) => {
    const updated = groups.map(g =>
      g.id === groupId ? { ...g, isCollapsed: !g.isCollapsed } : g
    );
    setGroups(updated);
    void setAppState('favorite_groups_v1', updated);
  };

  const handleRenameGroup = (groupId: string, currentName: string) => {
    const newName = prompt('Enter new group name:', currentName);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed) return;

    if (groups.some(g => g.id !== groupId && g.name.toLowerCase() === trimmed.toLowerCase())) {
      toast.error('Group with this name already exists');
      return;
    }

    const updated = groups.map(g =>
      g.id === groupId ? { ...g, name: trimmed } : g
    );
    setGroups(updated);
    void setAppState('favorite_groups_v1', updated);
    toast.success('Group renamed');
  };

  const handleDeleteGroup = (groupId: string) => {
    if (!confirm('Are you sure you want to delete this group? Connections will be ungrouped.')) return;

    const updatedGroups = groups.filter(g => g.id !== groupId);
    setGroups(updatedGroups);
    void setAppState('favorite_groups_v1', updatedGroups);

    const updatedMappings = { ...mappings };
    Object.keys(updatedMappings).forEach(connId => {
      if (updatedMappings[connId] === groupId) {
        delete updatedMappings[connId];
      }
    });
    setMappings(updatedMappings);
    void setAppState('favorite_group_mappings_v1', updatedMappings);
    toast.success('Group deleted');
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

  const filteredConnections = connections.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.host.toLowerCase().includes(search.toLowerCase())
  );

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

  const favoriteConnections = connections.filter(c => c.isFavorite);
  const hasFavorites = favoriteConnections.length > 0;

  const groupedFavorites = useMemo(() => {
    const ungrouped: ConnectionProfile[] = [];
    const groupedMap = new Map<string, ConnectionProfile[]>();

    groups.forEach(g => groupedMap.set(g.id, []));

    favoriteConnections.forEach(conn => {
      const gId = mappings[conn.id];
      if (gId && groupedMap.has(gId)) {
        groupedMap.get(gId)!.push(conn);
      } else {
        ungrouped.push(conn);
      }
    });

    return {
      groups: groups.map(g => ({
        ...g,
        connections: groupedMap.get(g.id) || [],
      })),
      ungrouped,
    };
  }, [favoriteConnections, groups, mappings]);

  return (
    <div className="flex-1 flex bg-background relative mac-vibrancy">
      {/* Sidebar area with custom traffic-light controls. */}
      {hasFavorites && (
        <div className="w-64 border-r border-border/50 flex flex-col bg-sidebar-bg/50 shrink-0">
          <MacWindowControls />
          <div className="p-4 flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Favorites</h2>
              <Button
                variant="ghost"
                size="icon"
                className="w-5 h-5 text-muted-foreground hover:text-foreground hover:bg-transparent"
                title="New Group"
                onClick={() => setIsCreatingGroup(true)}
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </Button>
            </div>

            {isCreatingGroup && (
              <form onSubmit={handleSaveGroup} className="flex items-center gap-1 mb-3 shrink-0">
                <Input
                  autoFocus
                  placeholder="Group name..."
                  className="h-7 text-xs px-2 bg-muted/50 border-none focus-visible:ring-1"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
                <Button
                  type="submit"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-emerald-500 hover:text-emerald-600 hover:bg-transparent shrink-0"
                >
                  <Check className="w-3.5 h-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive hover:bg-transparent shrink-0"
                  onClick={() => { setIsCreatingGroup(false); setNewGroupName(''); }}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </form>
            )}

            <div className="space-y-2 overflow-y-auto pr-1 flex-1 min-h-0">
              {/* Groups first */}
              {groupedFavorites.groups.map(group => (
                <div key={group.id} className="space-y-0.5">
                  <div
                    className="group/header flex items-center justify-between px-1.5 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted/30 rounded-md cursor-pointer select-none"
                    onClick={() => handleToggleCollapse(group.id)}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {group.isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <Folder className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{group.name}</span>
                      <span className="text-[10px] opacity-70 font-normal">({group.connections.length})</span>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="w-5 h-5 flex items-center justify-center rounded-md hover:bg-muted opacity-0 group-hover/header:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="w-3.5 h-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleRenameGroup(group.id, group.name); }}>
                          <Edit className="w-4 h-4 mr-2" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group.id); }}
                        >
                          <Trash2 className="w-4 h-4 mr-2" /> Delete Group
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {!group.isCollapsed && (
                    <div className="pl-3 space-y-0.5">
                      {group.connections.length === 0 ? (
                        <div className="text-[11px] text-muted-foreground/60 italic pl-5 py-1">
                          Empty group
                        </div>
                      ) : (
                        group.connections.map(conn => {
                          const isConnecting = connState.connectingIds.has(conn.id);
                          return (
                            <div
                              key={conn.id}
                              className={`group flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-muted/50 rounded-md cursor-pointer text-sm ${isConnecting ? "pointer-events-none opacity-75" : ""}`}
                              onClick={() => !isConnecting && handleConnect(conn.id)}
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                  {isConnecting ? (
                                    <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                  ) : (
                                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: conn.color || '#888' }} />
                                  )}
                                </div>
                                <span className="truncate">{conn.name}</span>
                                {conn.tag && (
                                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full select-none shrink-0 ${getTagColors(conn.tagColor).bg} ${getTagColors(conn.tagColor).text}`}>
                                    {conn.tag}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    className="w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Folder className="w-3.5 h-3.5" />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-48">
                                    <div className="px-2 py-1 text-xs font-semibold text-muted-foreground select-none">Move to Group</div>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleMoveToGroup(conn.id, ''); }}>
                                      None (Ungrouped)
                                    </DropdownMenuItem>
                                    {groups.filter(g => g.id !== group.id).map(g => (
                                      <DropdownMenuItem key={g.id} onClick={(e) => { e.stopPropagation(); handleMoveToGroup(conn.id, g.id); }}>
                                        {g.name}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>

                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-amber-500 hover:bg-transparent"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onEditConnection({ ...conn, isFavorite: false });
                                  }}
                                  title="Remove from Favorites"
                                >
                                  <Star className="w-3 h-3 fill-amber-500 text-amber-500 hover:fill-none" />
                                </Button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Ungrouped items */}
              {groupedFavorites.ungrouped.length > 0 && (
                <div className="space-y-0.5">
                  {groups.length > 0 && (
                    <div className="px-1.5 py-1 text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                      Ungrouped
                    </div>
                  )}
                  {groupedFavorites.ungrouped.map(conn => {
                    const isConnecting = connState.connectingIds.has(conn.id);
                    return (
                      <div
                        key={conn.id}
                        className={`group flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-muted/50 rounded-md cursor-pointer text-sm ${isConnecting ? "pointer-events-none opacity-75" : ""}`}
                        onClick={() => !isConnecting && handleConnect(conn.id)}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                            {isConnecting ? (
                              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: conn.color || '#888' }} />
                            )}
                          </div>
                          <span className="truncate">{conn.name}</span>
                          {conn.tag && (
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full select-none shrink-0 ${getTagColors(conn.tagColor).bg} ${getTagColors(conn.tagColor).text}`}>
                              {conn.tag}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {groups.length > 0 && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                className="w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Folder className="w-3.5 h-3.5" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <div className="px-2 py-1 text-xs font-semibold text-muted-foreground select-none">Move to Group</div>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleMoveToGroup(conn.id, ''); }}>
                                  None (Ungrouped)
                                </DropdownMenuItem>
                                {groups.map(g => (
                                  <DropdownMenuItem key={g.id} onClick={(e) => { e.stopPropagation(); handleMoveToGroup(conn.id, g.id); }}>
                                    {g.name}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}

                          <Button
                            variant="ghost"
                            size="icon"
                            className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-amber-500 hover:bg-transparent"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditConnection({ ...conn, isFavorite: false });
                            }}
                            title="Remove from Favorites"
                          >
                            <Star className="w-3 h-3 fill-amber-500 text-amber-500 hover:fill-none" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="p-4 border-t border-border/50 flex justify-between items-center shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <div
          data-tauri-drag-region
          className={`h-14 border-b border-border/50 flex items-center justify-end pr-6 ${
            // No "Connections" heading here — it collided with / sat awkwardly
            // beside the macOS traffic lights. The header is now just a drag
            // region carrying the search + Add Connection controls on the right.
            // Still reserve left clearance for the traffic lights (78px = the
            // rail's RAIL_COLLAPSED_WIDTH) when there's no Favorites sidebar to
            // cover that corner.
            hasFavorites ? 'pl-6' : 'pl-19.5'
            }`}
        >
          <div className="flex items-center gap-4">
            <div className="relative w-64">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search connections..."
                className="pl-9 h-8 bg-muted/50 border-none focus-visible:ring-1"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={() => { setEditingConnection(undefined); setIsModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              Add Connection
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6">
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
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredConnections.map(conn => (
                <div
                  key={conn.id}
                  className="group bg-card border border-border rounded-xl p-4 hover:shadow-md transition-all cursor-pointer relative"
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

                  <div className="flex justify-between items-start mb-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                      <DbIcon driver={conn.driver} className="w-5 h-5" />
                    </div>

                    <div className="flex items-center gap-1">
                      {conn.isFavorite && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-amber-500 hover:text-amber-600 hover:bg-transparent transition-transform duration-200 ease-in-out translate-x-[36px] group-hover:translate-x-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditConnection({ ...conn, isFavorite: false });
                          }}
                          title="Remove from Favorites"
                        >
                          <Star className="w-4 h-4 fill-amber-500 text-amber-500" />
                        </Button>
                      )}
                      {!conn.isFavorite && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500 hover:bg-transparent transition-all duration-200 ease-in-out translate-x-[36px] group-hover:translate-x-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditConnection({ ...conn, isFavorite: true });
                          }}
                          title="Add to Favorites"
                        >
                          <Star className="w-4 h-4" />
                        </Button>
                      )}

                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'h-8 w-8 opacity-0 group-hover:opacity-100 transition-all duration-200 ease-in-out pointer-events-none group-hover:pointer-events-auto' })}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="w-4 h-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }}>
                            Connect
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => {
                            e.stopPropagation();
                            onEditConnection({ ...conn, isFavorite: !conn.isFavorite });
                          }}>
                            {conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                          </DropdownMenuItem>
                          {conn.isFavorite && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <Folder className="w-4 h-4 mr-2" /> Move to Group
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="w-48">
                                <div className="px-2 py-1 text-xs font-semibold text-muted-foreground select-none">Move to Group</div>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleMoveToGroup(conn.id, ''); }}>
                                  None (Ungrouped)
                                </DropdownMenuItem>
                                {groups.map(g => (
                                  <DropdownMenuItem key={g.id} onClick={(e) => { e.stopPropagation(); handleMoveToGroup(conn.id, g.id); }}>
                                    {g.name}
                                  </DropdownMenuItem>
                                ))}
                                {groups.length === 0 && (
                                  <DropdownMenuItem disabled>
                                    No groups created
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
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
                              if (confirm(`Are you sure you want to delete '${conn.name}'?`)) {
                                onDeleteConnection(conn.id);
                              }
                            }}
                          >
                            <Trash2 className="w-4 h-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  <h3 className="font-semibold text-base mb-1 truncate">{conn.name}</h3>
                  <div className="text-sm text-muted-foreground flex flex-col gap-1">
                    <span className="truncate">{conn.user}@{conn.host}:{conn.port}</span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs px-2 py-0.5 bg-muted rounded-md w-fit">{conn.driver}</span>
                      {conn.tag && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full select-none ${getTagColors(conn.tagColor).bg} ${getTagColors(conn.tagColor).text}`}>
                          {conn.tag}
                        </span>
                      )}
                    </div>
                  </div>
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
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialSection={settingsSection} />
    </div>
  );
}
