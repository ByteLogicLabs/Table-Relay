import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { QueryLogEntry } from '../../types';
import { highlight, tokenClass } from '../../lib/highlight';
import { prefillChat } from '../../state/ai';

interface QueryLogProps {
  entries: QueryLogEntry[];
  onClear: () => void;
  defaultOpen?: boolean;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3).slice(0, 4)}`;
}

function detectDialect(stmt: string): 'sql' | 'mongo' | 'redis' {
  const s = stmt.trim();
  if (/^\s*db\./i.test(s) || /getCollection\s*\(/.test(s)) return 'mongo';
  if (/^(GET|SET|DEL|HGET|HSET|HGETALL|LPUSH|RPUSH|LRANGE|SADD|SMEMBERS|ZADD|ZRANGE|XRANGE|PUBLISH|SUBSCRIBE|PSUBSCRIBE|UNSUBSCRIBE|SCAN|KEYS|TYPE|TTL|EXPIRE|SELECT|INFO|PING)\b/i.test(s)) {
    return 'redis';
  }
  return 'sql';
}

export default function QueryLog({ entries, onClear, defaultOpen = true }: QueryLogProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [highlightOn, setHighlightOn] = useState(true);
  const [height, setHeight] = useState(180);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);

  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startYRef.current = e.clientY;
    const onMove = (ev: MouseEvent) => {
      // Drag up = grow, down = shrink, so subtract dy.
      const dy = ev.clientY - startYRef.current;
      startYRef.current = ev.clientY;
      setHeight(h => Math.max(80, Math.min(800, h - dy)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const ordered = useMemo(() => [...entries].sort((a, b) => a.timestamp - b.timestamp), [entries]);

  // Auto-scroll to bottom as new entries arrive.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ordered.length, open]);

  const handleToggleOpen = useCallback(() => setOpen(o => !o), []);

  const handleHighlightChange = useCallback((v: boolean | 'indeterminate') => setHighlightOn(v === true), []);

  const makeHandleAssist = useCallback(
    (statement: string, kind: 'fix' | 'explain', message?: string) => () =>
      prefillChat({
        kind,
        sql: statement,
        errorMessage: kind === 'fix' ? message : undefined,
      }),
    [],
  );

  const lastEntry = ordered[ordered.length - 1];

  return (
    <div className="border-t border-border bg-muted/20 flex flex-col shrink-0 relative">
      {/* Drag handle along the top edge — only useful when the panel is open,
          since a collapsed log has fixed height. */}
      {open && (
        <div
          onMouseDown={onResizeDown}
          role="separator"
          aria-orientation="horizontal"
          className="absolute left-0 right-0 -top-0.5 h-1.5 cursor-ns-resize hover:bg-primary/30 active:bg-primary/50 z-20"
        />
      )}
      {/* Header */}
      <div className="h-8 px-3 flex items-center justify-between border-b border-border/60">
        <button
          type="button"
          onClick={handleToggleOpen}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          <span className="font-medium">Query Log</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{ordered.length}</span>
          {!open && lastEntry && (
            <span className="ml-2 font-mono text-[11px] text-muted-foreground truncate max-w-md">
              {lastEntry.statement.replace(/\s+/g, ' ').slice(0, 120)}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none cursor-pointer">
            <Checkbox
              id="syntax-highlight"
              checked={highlightOn}
              onCheckedChange={handleHighlightChange}
              className="h-3.5 w-3.5"
            />
            Syntax highlighting
          </label>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClear}
            disabled={ordered.length === 0}
            title="Clear query log"
            aria-label="Clear query log"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      {open && (
        <div
          ref={scrollRef}
          style={{ height }}
          className="overflow-auto font-mono text-[12px] leading-5 px-3 py-2 bg-(--editor-bg)"
        >
          {ordered.length === 0 ? (
            <div className="text-muted-foreground text-xs">No queries executed yet.</div>
          ) : (
            ordered.map((e) => {
              const statusLabel = e.status === 'error' ? 'ERROR' : 'OK';
              const statusColor = e.status === 'error'
                ? 'var(--destructive)'
                : 'var(--syntax-success)';
              const errColor = 'var(--destructive)';
              const isSql = detectDialect(e.statement) === 'sql';
              const canAssist = isSql && e.statement.trim().length > 0;
              const assistKind = e.status === 'error' ? 'fix' : 'explain';
              const assistLabel = assistKind === 'fix' ? 'Fix with AI' : 'Explain with AI';
              return (
                <div key={e.id} className="group mb-2 border-l-2 pl-2 relative" style={{ borderColor: statusColor }}>
                  <div className="text-muted-foreground italic flex items-start justify-between gap-2">
                    <div className="min-w-0 wrap-break-word">
                      -- {formatTimestamp(e.timestamp)}
                      {e.durationMs !== undefined && <span className="opacity-80"> · {e.durationMs.toFixed(1)}ms</span>}
                      <span className="not-italic font-medium" style={{ color: statusColor }}> · {statusLabel}</span>
                      {e.status === 'error' && e.message && <span className="not-italic" style={{ color: errColor }}>: {e.message}</span>}
                      {e.status === 'ok' && e.message && <span className="opacity-80 not-italic"> · {e.message}</span>}
                      <span className="opacity-70"> · {e.source}</span>
                    </div>
                    {canAssist && (
                      <button
                        type="button"
                        title={assistLabel}
                        aria-label={assistLabel}
                        onClick={makeHandleAssist(e.statement, assistKind, e.message)}
                        className="shrink-0 not-italic opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 border border-primary/30 hover:border-primary/60 rounded px-1.5 py-0.5 bg-background/40"
                      >
                        <Sparkles className="w-3 h-3" />
                        {assistKind === 'fix' ? 'Fix' : 'Explain'}
                      </button>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-all">
                    {highlightOn
                      ? highlight(e.statement, detectDialect(e.statement)).map((t, i) => (
                          <span key={i} className={tokenClass[t.kind]}>{t.text}</span>
                        ))
                      : <span className="text-foreground">{e.statement}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
