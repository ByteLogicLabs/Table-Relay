import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus } from 'lucide-react';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ConnectionProfile } from '../../types';
import DbIcon from '../../components/db-icon';

export interface ConnectionPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionProfile[];
  /** Called with the chosen connection id. Caller handles connect + focus. */
  onPick: (connectionId: string) => void;
  /** "Create new…" footer action. */
  onCreateNew: () => void;
}

function driverIcon(driver: ConnectionProfile['driver']) {
  return <DbIcon driver={driver} className="w-4 h-4 shrink-0" />;
}

export default function ConnectionPickerDialog({
  open,
  onOpenChange,
  connections,
  onPick,
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

  const confirm = (id: string | null) => {
    if (!id) return;
    onPick(id);
    onOpenChange(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
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
  };

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
              onChange={e => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div ref={listRef} className="max-h-80 overflow-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {connections.length === 0 ? 'No saved connections.' : 'No matches.'}
            </div>
          )}
          {filtered.map(c => {
            const isActive = c.id === highlight;
            return (
              <button
                key={c.id}
                data-id={c.id}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 transition-colors ${
                  isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted/40'
                }`}
                onMouseEnter={() => setHighlight(c.id)}
                onClick={() => confirm(c.id)}
                onDoubleClick={() => confirm(c.id)}
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
              </button>
            );
          })}
        </div>

        <div className="px-3 py-3 border-t border-border/50 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => { onOpenChange(false); onCreateNew(); }}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" /> New connection
          </Button>
          <Button
            size="sm"
            disabled={!highlight}
            onClick={() => confirm(highlight)}
          >
            Open
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
