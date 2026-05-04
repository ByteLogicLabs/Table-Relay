import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, X, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { db, isDbError, type ProcessInfo, type KillResult } from '../../lib/db';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
}

function formatTime(seconds?: number | null): string {
  if (seconds == null) return '-';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ProcessListPanel({ open, onOpenChange, connectionId }: Props) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [killing, setKilling] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchProcesses = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await db.processList(connectionId);
      setProcesses(list);
      setSelected(new Set());
    } catch (err) {
      setError(isDbError(err) ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (open) {
      void fetchProcesses();
    } else {
      setSelected(new Set());
      setProcesses([]);
    }
  }, [open, fetchProcesses]);

  useEffect(() => {
    if (autoRefresh && open) {
      intervalRef.current = setInterval(() => void fetchProcesses(), 5000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, open, fetchProcesses]);

  const toggleSelect = (idx: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(idx);
      else next.delete(idx);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    if (checked) {
      setSelected(new Set(processes.map((_, i) => i)));
    } else {
      setSelected(new Set());
    }
  };

  const killSelected = async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected).map((i) => processes[i].id);
    setKilling(true);
    try {
      const results: KillResult[] = await db.killProcesses(connectionId, ids);
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        setError(
          `Failed to kill ${failed.length} process(es): ${failed.map((f) => `${f.id}: ${f.error}`).join('; ')}`,
        );
      }
      setSelected(new Set());
      await fetchProcesses();
    } catch (err) {
      setError(isDbError(err) ? err.message : String(err));
    } finally {
      setKilling(false);
    }
  };

  const killSingle = async (id: string) => {
    try {
      await db.killProcess(connectionId, id);
      await fetchProcesses();
    } catch (err) {
      setError(isDbError(err) ? err.message : String(err));
    }
  };

  const allSelected = processes.length > 0 && selected.size === processes.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Processes</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchProcesses()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </Button>
          <Button
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            Auto {autoRefresh ? 'ON' : 'OFF'}
          </Button>
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void killSelected()}
              disabled={killing}
            >
              {killing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : null}
              Kill Selected ({selected.size})
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            {processes.length} process{processes.length !== 1 ? 'es' : ''}
          </span>
        </div>

        {error && (
          <div className="rounded bg-destructive/10 text-destructive text-xs p-2 mb-2">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto border rounded">
          <table className="w-full text-xs">
            <thead className="text-xs text-muted-foreground bg-muted sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="px-4 py-2 border-b border-r border-border font-medium text-center w-8">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(v) => toggleAll(v === true)}
                  />
                </th>
                <th className="px-4 py-2 border-b border-r border-border font-medium text-center">ID</th>
                <th className="px-4 py-2 border-b border-r border-border font-medium">User</th>
                <th className="px-4 py-2 border-b border-r border-border font-medium">Database</th>
                <th className="px-4 py-2 border-b border-r border-border font-medium">Command</th>
                <th className="px-4 py-2 border-b border-r border-border font-medium">Time</th>
                <th className="px-4 py-2 border-b border-r border-border font-medium">State</th>
                <th className="px-4 py-2 border-b border-r border-border font-medium max-w-xs">Info</th>
                <th className="px-4 py-2 border-b border-border font-medium w-10" />
              </tr>
            </thead>
            <tbody>
              {processes.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-4 text-center text-muted-foreground">
                    No active processes
                  </td>
                </tr>
              )}
              {processes.map((p, idx) => (
                <tr
                  key={idx}
                  className={`border-b border-border hover:bg-muted/50 ${selected.has(idx) ? 'bg-muted/30' : ''}`}
                >
                  <td className="px-4 py-1.5 border-r border-border">
                    <Checkbox
                      checked={selected.has(idx)}
                      onCheckedChange={(v) => toggleSelect(idx, v === true)}
                    />
                  </td>
                  <td className="px-4 py-1.5 border-r border-border font-mono">{p.id}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.user ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.database ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.command ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border">{formatTime(p.time)}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.state ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border max-w-xs truncate" title={p.info ?? undefined}>
                    {p.info ?? '-'}
                  </td>
                  <td className="px-4 py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => void killSingle(p.id)}
                      title="Kill this process"
                    >
                      <X className="w-3 h-3 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
