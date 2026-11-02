import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoreVertical, Pencil, Plug, Plus, Search, Trash2 } from 'lucide-react';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ConnectionProfile } from '../../types';
import DbIcon from '../../components/db-icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu';

export interface ConnectionPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionProfile[];
  /** Called with the chosen connection id. Caller handles connect + focus. */
  onPick: (connectionId: string) => void;
  /** Three-dot menu → edit the saved profile. */
  onEditConnection?: (connection: ConnectionProfile) => void;
  /** Three-dot menu → delete the saved profile. */
  onDeleteConnection?: (connection: ConnectionProfile) => void;
  /** "Create new…" footer action. */
  onCreateNew: () => void;
}

function driverIcon(driver: ConnectionProfile['driver']) {
  return <DbIcon driver={driver} className="w-4 h-4 shrink-0" />;
}

interface ConnectionRowProps {
  connection: ConnectionProfile;
  isActive: boolean;
  onHighlight: (id: string) => void;
  onConfirm: (id: string | null) => void;
  onEdit: (connection: ConnectionProfile) => void;
  onDelete: (connection: ConnectionProfile) => void;
  canEdit: boolean;
  canDelete: boolean;
}

function ConnectionRow({
  connection: c,
  isActive,
  onHighlight,
  onConfirm,
  onEdit,
  onDelete,
  canEdit,
  canDelete,
}: ConnectionRowProps) {
  const handleMouseEnter = useCallback(() => onHighlight(c.id), [onHighlight, c.id]);
  const handleConfirm = useCallback(() => onConfirm(c.id), [onConfirm, c.id]);
  const handleTriggerClick = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);
  const handleEdit = useCallback(() => onEdit(c), [onEdit, c]);
  const handleDelete = useCallback(() => onDelete(c), [onDelete, c]);

  return (
    <div
      data-id={c.id}
      className={`group/row w-full px-2 py-1.5 text-sm flex items-center gap-1 transition-colors ${
        isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted/40'
      }`}
      onMouseEnter={handleMouseEnter}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left flex items-center gap-2.5 rounded px-1 py-0.5"
        onClick={handleConfirm}
        onDoubleClick={handleConfirm}
      >
        <span
          className="w-6 h-6 rounded-md bg-background/60 flex items-center justify-center shrink-0"
          style={c.color ? { color: c.color } : undefined}
        >
          {driverIcon(c.driver)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-tight">{c.name}</span>
          <span className="block text-[10.5px] text-muted-foreground truncate leading-tight">
            {c.driver} · {c.host}
          </span>
        </span>
        {/* SSH-tunnel marker — signals this profile connects through a
            jump host, which is why it may take longer to open. Colored
            badge to match the rail's SSH marker. */}
        {c.sshEnabled && (
          <span
            className="shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide bg-primary text-primary-foreground"
            title={c.sshHost ? `SSH tunnel via ${c.sshHost}` : 'SSH tunnel'}
          >
            SSH
          </span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="h-7 w-7 shrink-0 opacity-0 group-hover/row:opacity-100 data-[state=open]:opacity-100 inline-flex items-center justify-center rounded-md hover:bg-muted"
          onClick={handleTriggerClick}
          aria-label={`Connection actions for ${c.name}`}
        >
          <MoreVertical className="w-3.5 h-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem className="whitespace-nowrap" onClick={handleEdit} disabled={!canEdit}>
            <Pencil className="w-3.5 h-3.5 mr-2" /> Edit connection
          </DropdownMenuItem>
          <DropdownMenuItem className="whitespace-nowrap" onClick={handleConfirm}>
            <Plug className="w-3.5 h-3.5 mr-2" /> Connect now
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive whitespace-nowrap"
            onClick={handleDelete}
            disabled={!canDelete}
          >
            <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function ConnectionPickerDialog({
  open,
  onOpenChange,
  connections,
  onPick,
  onEditConnection,
  onDeleteConnection,
  onCreateNew,
}: ConnectionPickerDialogProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setHighlight(null);
      return;
    }
    setHighlight(connections[0]?.id ?? null);
  }, [open, connections.length]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(c =>
      c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q),
    );
  }, [connections, query]);

  useEffect(() => {
    if (!filtered.some(c => c.id === highlight)) {
      setHighlight(filtered[0]?.id ?? null);
    }
  }, [filtered, highlight]);

  const confirm = useCallback((id: string | null) => {
    if (!id) return;
    onPick(id);
    onOpenChange(false);
  }, [onPick, onOpenChange]);

  const editConnection = useCallback((connection: ConnectionProfile) => {
    onOpenChange(false);
    onEditConnection?.(connection);
  }, [onOpenChange, onEditConnection]);

  const deleteConnection = useCallback((connection: ConnectionProfile) => {
    if (!onDeleteConnection) return;
    if (!window.confirm(`Are you sure you want to delete '${connection.name}'?`)) return;
    onOpenChange(false);
    onDeleteConnection(connection);
  }, [onDeleteConnection, onOpenChange]);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onOpenChange(false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm(highlight);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      const idx = Math.max(0, filtered.findIndex(c => c.id === highlight));
      const next = e.key === 'ArrowDown'
        ? Math.min(filtered.length - 1, idx + 1)
        : Math.max(0, idx - 1);
      setHighlight(filtered[next].id);
      const el = listRef.current?.querySelector(`[data-id="${CSS.escape(filtered[next].id)}"]`);
      (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    }
  }, [onOpenChange, confirm, highlight, filtered]);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  }, []);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleCreateNew = useCallback(() => {
    onOpenChange(false);
    onCreateNew();
  }, [onOpenChange, onCreateNew]);

  const handleOpen = useCallback(() => {
    confirm(highlight);
  }, [confirm, highlight]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md! w-[28rem]! p-0! rounded-xl! gap-0! overflow-hidden"
        onKeyDown={handleKey}
      >
        <div className="px-4 pt-4 pb-3 border-b border-border/50 text-center">
          <div className="text-sm font-medium">Open connection</div>
        </div>

        <div className="p-3 border-b border-border/50">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Search connections…"
              className="pl-8 h-9 text-sm"
              value={query}
              onChange={handleQueryChange}
            />
          </div>
        </div>

        <div ref={listRef} className="max-h-80 overflow-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {connections.length === 0 ? 'No saved connections.' : 'No matches.'}
            </div>
          )}
          {filtered.map(c => (
            <ConnectionRow
              key={c.id}
              connection={c}
              isActive={c.id === highlight}
              onHighlight={setHighlight}
              onConfirm={confirm}
              onEdit={editConnection}
              onDelete={deleteConnection}
              canEdit={!!onEditConnection}
              canDelete={!!onDeleteConnection}
            />
          ))}
        </div>

        <div className="px-3 py-3 border-t border-border/50 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreateNew}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" /> New connection
          </Button>
          <Button
            size="sm"
            disabled={!highlight}
            onClick={handleOpen}
          >
            Open
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
