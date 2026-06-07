import { useMemo, useRef, useState } from 'react';
import { Search, Edit, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { ConnectionProfile } from '../../types';
import DbIcon from '../../components/db-icon';

interface ConnectPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionProfile[];
  onConnect: (connectionId: string) => void;
  onEditConnection: (connection: ConnectionProfile) => void;
  onDeleteConnection: (connectionId: string) => void;
}

export default function ConnectPickerDialog({
  open,
  onOpenChange,
  connections,
  onConnect,
  onEditConnection,
  onDeleteConnection,
}: ConnectPickerDialogProps) {
  const [query, setQuery] = useState('');
  const contextMenuOpenRef = useRef(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        c.driver.toLowerCase().includes(q),
    );
  }, [connections, query]);

  const connect = (id: string) => {
    onOpenChange(false);
    setQuery('');
    onConnect(id);
  };

  const edit = (conn: ConnectionProfile) => {
    onOpenChange(false);
    setQuery('');
    onEditConnection(conn);
  };

  const remove = (conn: ConnectionProfile) => {
    if (!window.confirm(`Delete '${conn.name}'?`)) return;
    onOpenChange(false);
    setQuery('');
    onDeleteConnection(conn.id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v, details) => {
        // Don't close the dialog when the user dismisses a context menu by
        // clicking outside — the outside click lands on the backdrop but the
        // intent was to close the context menu, not this dialog.
        if (!v && details.reason === 'outside-press' && contextMenuOpenRef.current) return;
        if (!v) setQuery('');
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-sm w-[90vw] p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle className="text-sm">Open connection</DialogTitle>
        </DialogHeader>

        <div className="px-4 py-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Filter connections…"
              className="pl-8 h-8 text-sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length === 1) connect(filtered[0].id);
              }}
            />
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto pb-2">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No connections found.
            </div>
          ) : (
            <div className="px-2 space-y-0.5">
              {filtered.map((conn) => (
                <ContextMenu
                  key={conn.id}
                  onOpenChange={(v) => { contextMenuOpenRef.current = v; }}
                >
                  <ContextMenuTrigger>
                    <button
                      type="button"
                      onClick={() => connect(conn.id)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-left hover:bg-muted/60 transition-colors"
                    >
                      <div
                        className="w-8 h-8 rounded-md bg-muted/70 flex items-center justify-center shrink-0"
                        style={conn.color ? { color: conn.color } : undefined}
                      >
                        <DbIcon driver={conn.driver} className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{conn.name}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {conn.host}:{conn.port}
                          {conn.database ? ` / ${conn.database}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {conn.sshEnabled && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                            SSH
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground">{conn.driver}</span>
                      </div>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="min-w-40">
                    <ContextMenuItem onClick={() => edit(conn)}>
                      <Edit className="w-3.5 h-3.5 mr-2" /> Edit connection
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => remove(conn)}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          )}
        </div>

      </DialogContent>
    </Dialog>
  );
}
