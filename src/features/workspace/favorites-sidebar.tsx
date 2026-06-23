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
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { MoreVertical, Edit, Trash2, Star, ChevronRight, ChevronDown, Folder, FolderPlus, Check, X, GripVertical, Zap } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '../../components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from '../../components/ui/context-menu';
import { toast } from 'sonner';
import MacWindowControls from './mac-window-controls';
import { useConnections } from '../../state/connections';
import { getAppState, setAppState } from '../../lib/app-state-store';
import type { FavoriteGroup } from './favorites-types';

const UNGROUPED = '__ungrouped__';

interface FavoritesSidebarProps {
  /** All connections; only favorites are shown, grouped/ordered locally. */
  connections: ConnectionProfile[];
  onConnect: (id: string) => void;
  onEditConnection: (conn: ConnectionProfile, previousId?: string) => void | Promise<void>;
}

/** The home-screen Favorites sidebar: groups, drag-and-drop reordering, and
 *  per-connection actions. Owns its own group/mapping/order persistence so the
 *  parent only supplies the connection list + connect/edit callbacks. */
export default function FavoritesSidebar({ connections, onConnect, onEditConnection }: FavoritesSidebarProps) {
  const connState = useConnections();

  const [groups, setGroups] = useState<FavoriteGroup[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({}); // connectionId -> groupId
  const [order, setOrder] = useState<Record<string, string[]>>({}); // bucketKey -> ordered connectionIds
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  // Drag-and-drop (favorites). Native HTML5 DnD doesn't fire in the Tauri
  // WebView, so we use @dnd-kit (pointer-based). PointerSensor with a small
  // activation distance so a click still connects but a drag moves the item.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    void (async () => {
      const storedGroups = await getAppState<FavoriteGroup[]>('favorite_groups_v1');
      if (storedGroups) setGroups(storedGroups);

      const storedMappings = await getAppState<Record<string, string>>('favorite_group_mappings_v1');
      if (storedMappings) setMappings(storedMappings);

      const storedOrder = await getAppState<Record<string, string[]>>('favorite_order_v1');
      if (storedOrder) setOrder(storedOrder);
    })();
  }, []);

  const handleConnect = (id: string) => {
    if (connState.connectingIds.has(id)) return;
    onConnect(id);
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

  const favoriteConnections = connections.filter(c => c.isFavorite);

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
    <div className="w-64 border-r border-border/50 flex flex-col bg-sidebar-bg/50 shrink-0">
      <MacWindowControls />
      <div className="p-4 flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex items-center justify-between mb-3 shrink-0">
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
                  <div className="pl-3 space-y-0.5 min-h-2">
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
                          isConnected={connState.activeById.has(conn.id)}
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
                    isConnected={connState.activeById.has(conn.id)}
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
  conn, isConnecting, isConnected = false, dragging, onConnect, onToggleFavorite, onMoveToGroup, groups, draggable = true,
}: {
  conn: ConnectionProfile;
  isConnecting: boolean;
  /** When connected/open, dragging is disabled and the grip is hidden. */
  isConnected?: boolean;
  dragging: boolean;
  onConnect: (id: string) => void;
  onToggleFavorite: () => void;
  onMoveToGroup: (connId: string, groupId: string) => void;
  groups: FavoriteGroup[];
  /** When false (e.g. the tag view), hide the drag grip + reorder drop target. */
  draggable?: boolean;
}) {
  // Only show drag affordances on idle, home-screen rows — not while a
  // connection is connecting or already connected/open.
  const canDrag = draggable && !isConnecting && !isConnected;
  const { setNodeRef: setDragRef, listeners, attributes } = useDraggable({ id: conn.id, disabled: !canDrag });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `row:${conn.id}`, disabled: !canDrag });

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          ref={setDropRef}
          className={`group relative flex items-center gap-1.5 pl-0.5 pr-1.5 py-2 hover:bg-muted/50 rounded-md cursor-pointer text-sm transition-colors ${isConnecting ? 'pointer-events-none opacity-75' : ''} ${dragging ? 'opacity-40' : ''} ${isOver ? 'ring-1 ring-primary/40 bg-primary/5' : ''}`}
          onClick={() => !isConnecting && onConnect(conn.id)}
        >
          {canDrag && (
            <span
              ref={setDragRef}
              {...listeners}
              {...attributes}
              onClick={stop}
              className="shrink-0 flex items-center justify-center w-0 group-hover:w-4 overflow-hidden cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-all touch-none"
              title="Drag to move"
            >
              <GripVertical className="w-3.5 h-3.5" />
            </span>
          )}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-2.5 h-2.5 flex items-center justify-center shrink-0">
              {isConnecting ? (
                <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              ) : (
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: conn.color || '#888' }} />
              )}
            </div>
            <span className="truncate">{conn.name}</span>
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
