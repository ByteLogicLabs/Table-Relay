import { useMemo, useState } from 'react';
import { Database, Edit, MoreVertical, Plug, Plus, Search, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu';
import { ConnectionProfile } from '../../types';
import DbIcon from '../../components/db-icon';

interface ConnectionManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionProfile[];
  onConnect: (connectionId: string) => void;
  onEditConnection: (connection: ConnectionProfile) => void;
  onDeleteConnection: (connectionId: string) => void;
  onCreateNew: () => void;
}

export default function ConnectionManagerDialog({
  open,
  onOpenChange,
  connections,
  onConnect,
  onEditConnection,
  onDeleteConnection,
  onCreateNew,
}: ConnectionManagerDialogProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.host.toLowerCase().includes(q) ||
      c.driver.toLowerCase().includes(q),
    );
  }, [connections, query]);

  const connect = (id: string) => {
    onConnect(id);
    onOpenChange(false);
  };

  const edit = (connection: ConnectionProfile) => {
    onEditConnection(connection);
    onOpenChange(false);
  };

  const remove = (connection: ConnectionProfile) => {
    if (!window.confirm(`Are you sure you want to delete '${connection.name}'?`)) return;
    onDeleteConnection(connection.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl w-[92vw] max-h-[82vh] overflow-hidden p-0 gap-0">
        <DialogHeader className="px-5 py-4 border-b border-border/50">
          <DialogTitle className="text-sm">Connections</DialogTitle>
        </DialogHeader>

        <div className="px-5 py-3 border-b border-border/50 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Search connections..."
              className="pl-9 h-9"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            className="h-9"
            onClick={() => {
              onOpenChange(false);
              onCreateNew();
            }}
          >
            <Plus className="w-4 h-4 mr-2" /> New connection
          </Button>
        </div>

        <div className="max-h-[58vh] overflow-auto">
          {filtered.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Database className="w-8 h-8 opacity-50" />
              <div>{connections.length === 0 ? 'No saved connections.' : 'No matches.'}</div>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {filtered.map((conn) => (
                <div
                  key={conn.id}
                  className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] items-center gap-4 px-5 py-3 hover:bg-muted/35"
                >
                  <div className="min-w-0 flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-md bg-muted/70 flex items-center justify-center shrink-0"
                      style={conn.color ? { color: conn.color } : undefined}
                    >
                      <DbIcon driver={conn.driver} className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{conn.name}</div>
                    </div>
                  </div>

                  <div className="min-w-0 text-xs text-muted-foreground">
                    <div className="truncate">{conn.user || '-'}@{conn.host}:{conn.port}</div>
                    {conn.database && <div className="truncate">{conn.database}</div>}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded bg-muted px-2 py-1">{conn.driver}</span>
                    {conn.sshEnabled && (
                      <span className="rounded bg-primary text-primary-foreground px-2 py-1">
                        SSH
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="outline" onClick={() => connect(conn.id)}>
                      <Plug className="w-3.5 h-3.5 mr-1.5" /> Connect
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted"
                        aria-label={`Connection actions for ${conn.name}`}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuItem className="whitespace-nowrap" onClick={() => edit(conn)}>
                          <Edit className="w-3.5 h-3.5 mr-2" /> Edit connection
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive whitespace-nowrap"
                          onClick={() => remove(conn)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
