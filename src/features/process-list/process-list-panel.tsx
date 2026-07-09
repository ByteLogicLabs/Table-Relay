import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X, Loader2, Search, Eye, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
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
  // Selection and the open-query row are keyed by PROCESS ID (not row index)
  // so a background auto-refresh that reshuffles / drops rows can never make a
  // later "Kill" hit the wrong process, and the user's selection survives the
  // poll instead of being wiped every 5s.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [killing, setKilling] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  // Free-text filter over the visible process rows (matches id/user/host/db/
  // command/state and the full query in Info). Purely client-side over the
  // last-fetched snapshot.
  const [search, setSearch] = useState('');
  // Id of the row whose Info (full query) is opened in place. The column is
  // truncated by default; clicking a cell swaps it for a focused read-only
  // editor box showing the full query — same as the data grid's cell edit, but
  // not editable. Only one is open at a time; blur / Escape closes it.
  const [openInfo, setOpenInfo] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Neutral focus target for dialog open (see `initialFocus` on DialogContent).
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  // `silent` is the auto-refresh poll: it must not flip `loading` (which would
  // flicker + disable the Refresh button every 5s) and must preserve the user's
  // selection / open query. It prunes both to the ids still present so nothing
  // dangles. A manual refresh (silent=false) shows the spinner and resets them.
  const fetchProcesses = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const list = await db.processList(connectionId);
      setProcesses(list);
      if (silent) {
        const alive = new Set(list.map((p) => p.id));
        setSelected((prev) => {
          const next = new Set(Array.from(prev).filter((id) => alive.has(id)));
          return next.size === prev.size ? prev : next;
        });
        setOpenInfo((prev) => (prev != null && alive.has(prev) ? prev : null));
      } else {
        setSelected(new Set());
        setOpenInfo(null);
      }
    } catch (err) {
      setError(isDbError(err) ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (open) {
      void fetchProcesses();
    } else {
      setSelected(new Set());
      setProcesses([]);
      setOpenInfo(null);
      setSearch('');
    }
  }, [open, fetchProcesses]);

  useEffect(() => {
    if (autoRefresh && open) {
      intervalRef.current = setInterval(() => void fetchProcesses(true), 5000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, open, fetchProcesses]);

  const toggleSelect = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // The filtered process rows (search matches id/user/host/db/command/state/
  // info). Selection etc. key off `p.id`, so no index bookkeeping is needed.
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return processes;
    return processes.filter((p) =>
      [p.id, p.user, p.host, p.database, p.command, p.state, p.info]
        .some((f) => f != null && String(f).toLowerCase().includes(q)),
    );
  }, [processes, search]);

  const toggleAll = useCallback((checked: boolean) => {
    if (checked) {
      // Select all VISIBLE rows (respecting the filter), keeping any
      // already-selected hidden rows intact.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of visibleRows) next.add(p.id);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of visibleRows) next.delete(p.id);
        return next;
      });
    }
  }, [visibleRows]);

  const killSelected = useCallback(async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
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
  }, [selected, processes, connectionId, fetchProcesses]);

  const killSingle = useCallback(async (id: string) => {
    try {
      await db.killProcess(connectionId, id);
      await fetchProcesses();
    } catch (err) {
      setError(isDbError(err) ? err.message : String(err));
    }
  }, [connectionId, fetchProcesses]);

  const handleRefreshClick = useCallback(() => {
    void fetchProcesses();
  }, [fetchProcesses]);

  const handleToggleWatch = useCallback(() => setAutoRefresh((v) => !v), []);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value),
    [],
  );

  const handleClearSearch = useCallback(() => setSearch(''), []);

  const handleKillSelectedClick = useCallback(() => {
    void killSelected();
  }, [killSelected]);

  const handleToggleAllChange = useCallback((v: boolean | 'indeterminate') => {
    toggleAll(v === true);
  }, [toggleAll]);

  const makeHandleToggleSelect = useCallback(
    (id: string) => (v: boolean | 'indeterminate') => toggleSelect(id, v === true),
    [toggleSelect],
  );

  const makeHandleKillSingle = useCallback(
    (id: string) => () => void killSingle(id),
    [killSingle],
  );

  const makeHandleOpenInfo = useCallback(
    (id: string) => () => setOpenInfo(id),
    [],
  );

  const handleInfoClose = useCallback(() => setOpenInfo(null), []);

  const handleInfoKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpenInfo(null);
  }, []);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const allSelected =
    visibleRows.length > 0 && visibleRows.every((p) => selected.has(p.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-4xl max-h-[80vh] flex flex-col"
        // Land initial focus on the (neutral) list container, not the first
        // tabbable control. The Refresh button is disabled while the initial
        // fetch runs, which would otherwise make the search box the first
        // tabbable and steal focus + pop the keyboard cursor on open.
        initialFocus={listContainerRef}
      >
        <DialogHeader>
          <DialogTitle>Processes</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-3">
          {/* Left: actions + count */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshClick}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </Button>
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleKillSelectedClick}
              disabled={killing}
            >
              {killing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              Kill {selected.size}
            </Button>
          )}
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {search.trim()
              ? `${visibleRows.length} / ${processes.length}`
              : `${processes.length} total`}
          </span>

          {/* Right: watch toggle, then search — both h-8 so they line up. */}
          <div className="ml-auto flex items-center gap-2">
            {/* Auto-refresh toggle. A pulsing dot signals live polling
                (every 5s, see the autoRefresh effect). */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleWatch}
              className={`h-8 ${autoRefresh ? 'text-primary border-primary/50' : ''}`}
              title={
                autoRefresh
                  ? 'Auto-refreshing every 5s — click to stop'
                  : 'Auto-refresh every 5s'
              }
            >
              {autoRefresh ? (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
              {autoRefresh ? 'Watching' : 'Watch'}
            </Button>
            <div className="relative w-56">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={handleSearchChange}
                placeholder="Filter processes…"
                className="h-8 rounded-md pl-8 pr-7 text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  title="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded bg-destructive/10 text-destructive text-xs p-2 mb-2">
            {error}
          </div>
        )}

        <div ref={listContainerRef} tabIndex={-1} className="flex-1 overflow-auto border rounded outline-none">
          <table className="w-full text-xs">
            <thead className="text-xs text-muted-foreground bg-muted sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="px-4 py-2 border-b border-r border-border font-medium text-center w-8">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={handleToggleAllChange}
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
              {visibleRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-4 text-center text-muted-foreground">
                    {processes.length === 0
                      ? 'No active processes'
                      : 'No processes match your filter'}
                  </td>
                </tr>
              )}
              {visibleRows.map((p, i) => (
                <tr
                  key={p.id || i}
                  className={`border-b border-border hover:bg-muted/50 ${selected.has(p.id) ? 'bg-muted/30' : ''}`}
                >
                  <td className="px-4 py-1.5 border-r border-border">
                    <Checkbox
                      checked={selected.has(p.id)}
                      onCheckedChange={makeHandleToggleSelect(p.id)}
                    />
                  </td>
                  <td className="px-4 py-1.5 border-r border-border font-mono">{p.id}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.user ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.database ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.command ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border">{formatTime(p.time)}</td>
                  <td className="px-4 py-1.5 border-r border-border">{p.state ?? '-'}</td>
                  <td className="px-4 py-1.5 border-r border-border max-w-xs align-top">
                    {p.info ? (
                      openInfo === p.id ? (
                        <div
                          tabIndex={0}
                          ref={(el) => el?.focus()}
                          onBlur={handleInfoClose}
                          onKeyDown={handleInfoKeyDown}
                          className="w-full overflow-x-auto whitespace-nowrap bg-background text-foreground font-mono text-xs px-2 py-1 border-2 border-primary outline-none select-text"
                        >
                          {p.info}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="block w-full truncate text-left font-mono cursor-pointer hover:text-primary"
                          title="Click to view the full query"
                          onClick={makeHandleOpenInfo(p.id)}
                        >
                          {p.info}
                        </button>
                      )
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-4 py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={makeHandleKillSingle(p.id)}
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
          <Button variant="ghost" onClick={handleClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
