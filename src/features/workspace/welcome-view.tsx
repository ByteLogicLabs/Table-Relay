import { useState, useEffect, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ConnectionProfile } from '../../types';
import { Button, buttonVariants } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Search, Plus, Settings, Database, MoreVertical, Edit, Copy, Trash2, Star, ChevronRight, ChevronDown, Folder, FolderPlus, Check, X, LayoutGrid, List, GripVertical, Zap } from 'lucide-react';
import ConnectionModal from '../connections/connection-modal';
import SettingsDialog from '../settings/settings-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '../../components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from '../../components/ui/context-menu';
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
  const [order, setOrder] = useState<Record<string, string[]>>({}); // bucketKey -> ordered connectionIds
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  // Drag-and-drop (favorites). Native HTML5 DnD doesn't fire in the Tauri
  // WebView, so we use @dnd-kit (pointer-based). PointerSensor with a small
  // activation distance so a click still connects but a drag moves the item.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const UNGROUPED = '__ungrouped__';

  useEffect(() => {
    void (async () => {
      const storedGroups = await getAppState<FavoriteGroup[]>('favorite_groups_v1');
      if (storedGroups) setGroups(storedGroups);

      const storedMappings = await getAppState<Record<string, string>>('favorite_group_mappings_v1');
      if (storedMappings) setMappings(storedMappings);

      const storedOrder = await getAppState<Record<string, string[]>>('favorite_order_v1');
      if (storedOrder) setOrder(storedOrder);

      const storedView = await getAppState<'card' | 'list'>('connections_view_mode_v1');
      if (storedView === 'card' || storedView === 'list') setViewMode(storedView);
    })();
  }, []);

  const changeViewMode = (mode: 'card' | 'list') => {
    setViewMode(mode);
    void setAppState('connections_view_mode_v1', mode);
  };

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

  const bucketOf = (connId: string) => mappings[connId] || UNGROUPED;

  // Drop `draggedId` into `targetBucket`, positioned before `beforeId` (or at the
  // end when dropping on a header / empty area). Updates group membership and
  // per-bucket order in one pass, then persists both.
  const handleFavoriteDrop = (draggedId: string, targetBucket: string, beforeId?: string) => {
    if (!draggedId || draggedId === beforeId) return;

    const fromBucket = bucketOf(draggedId);

    // 1. Membership: move into the target group (or out to ungrouped).
    const nextMappings = { ...mappings };
    if (targetBucket === UNGROUPED) delete nextMappings[draggedId];
    else nextMappings[draggedId] = targetBucket;

    // 2. Order: rebuild the affected buckets from the currently-rendered order
    //    so positions are stable, then splice the dragged id into place.
    const currentIds = (bucketKey: string): string[] => {
      if (bucketKey === UNGROUPED) return groupedFavorites.ungrouped.map(c => c.id);
      const g = groupedFavorites.groups.find(x => x.id === bucketKey);
      return g ? g.connections.map(c => c.id) : [];
    };

    const nextOrder = { ...order };
    // Remove from its old bucket.
    nextOrder[fromBucket] = currentIds(fromBucket).filter(id => id !== draggedId);
    // Insert into the target bucket at the right spot.
    const targetIds = (nextOrder[targetBucket] ?? currentIds(targetBucket)).filter(id => id !== draggedId);
    const insertAt = beforeId ? targetIds.indexOf(beforeId) : -1;
    if (insertAt === -1) targetIds.push(draggedId);
    else targetIds.splice(insertAt, 0, draggedId);
    nextOrder[targetBucket] = targetIds;

    setMappings(nextMappings);
    setOrder(nextOrder);
    void setAppState('favorite_group_mappings_v1', nextMappings);
    void setAppState('favorite_order_v1', nextOrder);
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

    // Sort each bucket by the saved order; unseen items (new favorites) keep
    // their natural position at the end.
    const sortBucket = (bucketKey: string, list: ConnectionProfile[]) => {
      const ord = order[bucketKey];
      if (!ord) return list;
      const idx = (id: string) => {
        const i = ord.indexOf(id);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      return [...list].sort((a, b) => idx(a.id) - idx(b.id));
    };

    return {
      groups: groups.map(g => ({
        ...g,
        connections: sortBucket(g.id, groupedMap.get(g.id) || []),
      })),
      ungrouped: sortBucket(UNGROUPED, ungrouped),
    };
  }, [favoriteConnections, groups, mappings, order]);

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

            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragStart={(e: DragStartEvent) => setDraggingId(String(e.active.id))}
              onDragCancel={() => setDraggingId(null)}
              onDragEnd={(e: DragEndEvent) => {
                setDraggingId(null);
                const activeId = String(e.active.id);
                const over = e.over;
                if (!over) return;
                const overId = String(over.id);
                if (overId.startsWith('row:')) {
                  const targetConnId = overId.slice(4);
                  if (targetConnId === activeId) return;
                  handleFavoriteDrop(activeId, bucketOf(targetConnId), targetConnId);
                } else if (overId.startsWith('bucket:')) {
                  handleFavoriteDrop(activeId, overId.slice(7));
                }
              }}
            >
              <div className="space-y-2 overflow-y-auto pr-1 flex-1 min-h-0">
                {/* Groups first */}
                {groupedFavorites.groups.map(group => (
                  <FavoriteBucket key={group.id} bucketId={group.id}>
                    <ContextMenu>
                      <ContextMenuTrigger>
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
                              className="w-5 h-5 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground/50 hover:text-foreground opacity-0 group-hover/header:opacity-100 focus:opacity-100 data-popup-open:opacity-100 transition-opacity"
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
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-40">
                        <ContextMenuItem onClick={() => handleRenameGroup(group.id, group.name)}>
                          <Edit className="w-4 h-4 mr-2" /> Rename
                        </ContextMenuItem>
                        <ContextMenuItem variant="destructive" onClick={() => handleDeleteGroup(group.id)}>
                          <Trash2 className="w-4 h-4 mr-2" /> Delete Group
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>

                    {!group.isCollapsed && (
                      <div className="pl-3 space-y-0.5 min-h-[8px]">
                        {group.connections.length === 0 ? (
                          <div className="text-[11px] text-muted-foreground/60 italic pl-5 py-1">
                            Empty group
                          </div>
                        ) : (
                          group.connections.map(conn => (
                            <FavoriteRow
                              key={conn.id}
                              conn={conn}
                              isConnecting={connState.connectingIds.has(conn.id)}
                              dragging={draggingId === conn.id}
                              onConnect={handleConnect}
                              onToggleFavorite={() => onEditConnection({ ...conn, isFavorite: false })}
                              onMoveToGroup={handleMoveToGroup}
                              groups={groups.filter(g => g.id !== group.id)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </FavoriteBucket>
                ))}

                {/* Ungrouped items */}
                {groupedFavorites.ungrouped.length > 0 && (
                  <FavoriteBucket bucketId={UNGROUPED}>
                    {groups.length > 0 && (
                      <div className="px-1.5 py-1 text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                        Ungrouped
                      </div>
                    )}
                    {groupedFavorites.ungrouped.map(conn => (
                      <FavoriteRow
                        key={conn.id}
                        conn={conn}
                        isConnecting={connState.connectingIds.has(conn.id)}
                        dragging={draggingId === conn.id}
                        onConnect={handleConnect}
                        onToggleFavorite={() => onEditConnection({ ...conn, isFavorite: false })}
                        onMoveToGroup={handleMoveToGroup}
                        groups={groups}
                      />
                    ))}
                  </FavoriteBucket>
                )}
              </div>
            </DndContext>
          </div>
        </div>
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
                        {conn.tag && (
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full select-none shrink-0 ${getTagColors(conn.tagColor).bg} ${getTagColors(conn.tagColor).text}`}>
                            {conn.tag}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 min-w-0">
                        <span className="px-1.5 py-0.5 bg-muted rounded shrink-0">{conn.driver}</span>
                        {conn.sshEnabled && (
                          <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 font-medium shrink-0">SSH</span>
                        )}
                        {conn.user && <span className="truncate">{conn.user}@{conn.host}:{conn.port}</span>}
                        {!conn.user && <span className="truncate">{conn.host}:{conn.port}</span>}
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
                          className={`h-8 w-8 hover:bg-transparent ${conn.isFavorite ? 'text-amber-500 hover:text-amber-600' : 'opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-amber-500 transition-opacity'}`}
                          onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); }}
                          title={conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                        >
                          <Star className={`w-4 h-4 ${conn.isFavorite ? 'fill-amber-500 text-amber-500' : ''}`} />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'h-8 w-8 opacity-0 group-hover:opacity-100 focus:opacity-100 data-popup-open:opacity-100 transition-opacity' })}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }}>Connect</DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); }}>
                              {conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
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
                      <div className="flex items-center gap-1 shrink-0">
                        {conn.isFavorite && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-amber-500 hover:text-amber-600 hover:bg-transparent"
                            onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: false }); }}
                            title="Remove from Favorites"
                          >
                            <Star className="w-4 h-4 fill-amber-500 text-amber-500" />
                          </Button>
                        )}
                        {!conn.isFavorite && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-amber-500 hover:bg-transparent transition-opacity duration-200"
                            onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: true }); }}
                            title="Add to Favorites"
                          >
                            <Star className="w-4 h-4" />
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'h-8 w-8 opacity-0 group-hover:opacity-100 focus:opacity-100 data-popup-open:opacity-100 transition-opacity duration-200' })}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }}>
                              Connect
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); }}>
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
                                    <DropdownMenuItem disabled>No groups created</DropdownMenuItem>
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
                                if (confirm(`Are you sure you want to delete '${conn.name}'?`)) onDeleteConnection(conn.id);
                              }}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                    const tag = conn.tag && (
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full select-none ${getTagColors(conn.tagColor).bg} ${getTagColors(conn.tagColor).text}`}>
                        {conn.tag}
                      </span>
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
                          <span className="truncate">{conn.user}@{conn.host}:{conn.port}</span>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs px-2 py-0.5 bg-muted rounded-md w-fit">{conn.driver}</span>
                            {conn.sshEnabled && (
                              <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-400 w-fit">SSH</span>
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
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialSection={settingsSection} />
    </div>
  );
}

/** A droppable favorites bucket (a group, or the ungrouped section). Dropping
 *  anywhere on it that isn't a specific row moves the item into this bucket. */
function FavoriteBucket({ bucketId, children }: { bucketId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `bucket:${bucketId}` });
  return (
    <div ref={setNodeRef} className={`space-y-0.5 rounded-md transition-colors ${isOver ? 'ring-1 ring-primary/50 bg-primary/5' : ''}`}>
      {children}
    </div>
  );
}

/** One draggable favorite connection row. The whole row is the drag source (via
 *  the grip listeners) and also a droppable target for reordering. */
function FavoriteRow({
  conn, isConnecting, dragging, onConnect, onToggleFavorite, onMoveToGroup, groups,
}: {
  conn: ConnectionProfile;
  isConnecting: boolean;
  dragging: boolean;
  onConnect: (id: string) => void;
  onToggleFavorite: () => void;
  onMoveToGroup: (connId: string, groupId: string) => void;
  groups: FavoriteGroup[];
}) {
  const { setNodeRef: setDragRef, listeners, attributes } = useDraggable({ id: conn.id, disabled: isConnecting });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `row:${conn.id}` });

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          ref={setDropRef}
          className={`group relative flex items-center gap-2 pl-1 pr-1.5 py-2 hover:bg-muted/50 rounded-md cursor-pointer text-sm transition-colors ${isConnecting ? 'pointer-events-none opacity-75' : ''} ${dragging ? 'opacity-40' : ''} ${isOver ? 'ring-1 ring-primary/40 bg-primary/5' : ''}`}
          onClick={() => !isConnecting && onConnect(conn.id)}
        >
          <span
            ref={setDragRef}
            {...listeners}
            {...attributes}
            onClick={stop}
            className="shrink-0 flex items-center justify-center w-4 cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity touch-none"
            title="Drag to move"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </span>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-2.5 h-2.5 flex items-center justify-center shrink-0">
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
          {/* Hover: three-dot menu on the right */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 focus:opacity-100 data-popup-open:opacity-100 transition-opacity"
              onClick={stop}
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52" onClick={stop}>
              <DropdownMenuItem className="whitespace-nowrap" onClick={(e) => { stop(e); onConnect(conn.id); }}>
                <Zap className="w-4 h-4 mr-2" /> Connect
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onClick={(e) => { stop(e); onToggleFavorite(); }}>
                <Star className="w-4 h-4 mr-2" /> Remove from Favorites
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="whitespace-nowrap">
                  <Folder className="w-4 h-4 mr-2" /> Move to Group
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  <DropdownMenuItem className="whitespace-nowrap" onClick={(e) => { stop(e); onMoveToGroup(conn.id, ''); }}>
                    <X className="w-4 h-4 mr-2" /> None (Ungrouped)
                  </DropdownMenuItem>
                  {groups.length > 0 && <DropdownMenuSeparator />}
                  {groups.map(g => (
                    <DropdownMenuItem key={g.id} className="whitespace-nowrap" onClick={(e) => { stop(e); onMoveToGroup(conn.id, g.id); }}>
                      <Folder className="w-4 h-4 mr-2" /> {g.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>

      {/* Right-click context menu — same actions */}
      <ContextMenuContent className="w-52">
        <ContextMenuItem className="whitespace-nowrap" onClick={() => onConnect(conn.id)}>
          <Zap className="w-4 h-4 mr-2" /> Connect
        </ContextMenuItem>
        <ContextMenuItem className="whitespace-nowrap" onClick={() => onToggleFavorite()}>
          <Star className="w-4 h-4 mr-2" /> Remove from Favorites
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger className="whitespace-nowrap">
            <Folder className="w-4 h-4 mr-2" /> Move to Group
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuItem className="whitespace-nowrap" onClick={() => onMoveToGroup(conn.id, '')}>
              <X className="w-4 h-4 mr-2" /> None (Ungrouped)
            </ContextMenuItem>
            {groups.length > 0 && <ContextMenuSeparator />}
            {groups.map(g => (
              <ContextMenuItem key={g.id} className="whitespace-nowrap" onClick={() => onMoveToGroup(conn.id, g.id)}>
                <Folder className="w-4 h-4 mr-2" /> {g.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
