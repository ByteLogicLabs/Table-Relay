import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Trash2, Copy, Radio, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Checkbox } from '../../components/ui/checkbox';
import { ConnectionProfile } from '../../types';
import { db, isDbError, type SubscribeEvent } from '../../lib/db';
import { ai } from '../../lib/ai';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';

// Cap the in-memory buffer per tab. Redis on a busy channel can emit
// tens of thousands of events a second; without a cap the tab tree
// would grow unbounded and the browser would OOM before the user
// noticed. 2k keeps ~5–10 minutes of a chatty topic visible.
const MAX_EVENTS = 2000;
const MAX_PUBLISH_LOG = 50;

interface LogQueryOptions {
  source?: 'editor' | 'grid' | 'system';
  durationMs?: number;
  status?: 'ok' | 'error';
  message?: string;
}

interface RealtimeViewProps {
  connection: ConnectionProfile;
  initialPattern?: string;
  /** Persists the user's current pattern back onto the tab. */
  onPatternChange?: (pattern: string) => void;
  /** Appends a PUBLISH (or subscribe lifecycle) entry to the shared
   *  per-connection query log that renders at the bottom of the tab. */
  onLogQuery?: (statement: string, opts?: LogQueryOptions) => void;
}

interface RecordedEvent extends SubscribeEvent {
  /** Client-assigned counter so React keys stay stable even when a
   *  remote burst gives us two messages at the same `receivedAtMs`. */
  __seq: number;
}

interface PublishLogEntry {
  id: number;
  channel: string;
  payload: string;
  sentAtMs: number;
  receivers: number | null;
  error: string | null;
}

export default function RealtimeView({ connection, initialPattern, onPatternChange, onLogQuery }: RealtimeViewProps) {
  // Realtime semantics come from the active manifest, not the driver
  // name. Adapters declare their kind in `adapter.toml`:
  //   - listen_notify  → Postgres-style: literal channels, NOTIFY/LISTEN
  //   - pubsub         → Redis-style: globs allowed, PUBLISH/SUBSCRIBE
  //   - change_stream  → Mongo-style: collection-scoped change streams
  const manifests = useAdapterManifests();
  const activeManifest = useMemo(
    () => resolveManifest(manifests, connection.driver),
    [manifests, connection.driver],
  );
  const realtimeKind = activeManifest?.capabilities.realtimeKind ?? 'none';
  const adapterAllowsGlobs = activeManifest?.capabilities.globSubscriptions ?? false;
  const canPublish = realtimeKind !== 'none';
  // ---- subscribe side ----
  // Default depends on the adapter: glob-capable adapters get `*` as a
  // reasonable "match everything" starting point. Adapters with literal
  // channels (Postgres LISTEN) start empty and let the user type a real
  // channel name.
  const defaultPattern = adapterAllowsGlobs ? '*' : '';
  // Discard a wildcard `initialPattern` on adapters that don't support
  // globs — the persisted tab state may predate the per-adapter default.
  const usableInitial = initialPattern && (adapterAllowsGlobs || !/[*?\[]/.test(initialPattern))
    ? initialPattern
    : null;
  const [pattern, setPattern] = useState(usableInitial ?? defaultPattern);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [events, setEvents] = useState<RecordedEvent[]>([]);
  const [pending, setPending] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);

  // ---- publish side ----
  const [pubChannel, setPubChannel] = useState('');
  const [pubPayload, setPubPayload] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishLog, setPublishLog] = useState<PublishLogEntry[]>([]);
  const pubSeqRef = useRef(0);

  // ---- split layout ----
  // Left column width as a percentage of the split container. Percentages
  // (not pixels) so the split scales with window resize without extra math.
  const [leftPct, setLeftPct] = useState(50);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; startPct: number } | null>(null);

  useEffect(() => {
    return () => {
      const id = activeIdRef.current;
      if (id) void db.unsubscribe(id).catch(() => {});
      activeIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // AI-driven subscribe: the `subscribe_channel` tool emits an event with
  // a channel name after the user approves it. We match on connection id
  // so only the realtime tab on the same connection picks it up. The
  // listener sets the pattern and flags it so the next render can kick
  // the Start flow — we can't call `handleStart` directly here because
  // of React's stale-closure pitfall over `pending` / `isRunning`.
  const pendingAiStartRef = useRef<string | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void ai.onRealtimeSubscribe(e => {
      if (e.connectionId !== connection.id) return;
      if (!e.channel.trim()) return;
      pendingAiStartRef.current = e.channel;
      setPattern(e.channel);
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [connection.id]);

  const isRunning = subscriptionId !== null;

  // If the AI queued a channel to subscribe to, start it as soon as the
  // input state has caught up. One-shot: the ref is cleared before we
  // fire so a re-render won't loop.
  useEffect(() => {
    const queued = pendingAiStartRef.current;
    if (!queued || pattern !== queued) return;
    if (isRunning || pending) return;
    pendingAiStartRef.current = null;
    void handleStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, isRunning, pending]);

  const handleStart = async () => {
    if (isRunning || pending) return;
    const trimmed = pattern.trim();
    if (!trimmed) {
      toast.error('Enter a pattern to subscribe to');
      return;
    }
    // The log line mirrors the adapter-native verb so the user can see
    // what actually ran on the server. Redis picks PSUBSCRIBE for globs
    // and SUBSCRIBE for literals; Postgres always emits LISTEN <chan>.
    let cmd: string;
    if (realtimeKind === 'listenNotify') {
      const safeChannel = trimmed.replace(/"/g, '""');
      cmd = `LISTEN "${safeChannel}"`;
    } else if (realtimeKind === 'changeStream') {
      cmd = `WATCH ${trimmed}`;
    } else {
      const isGlob = /[*?\[]/.test(trimmed);
      const verb = isGlob ? 'PSUBSCRIBE' : 'SUBSCRIBE';
      cmd = `${verb} ${trimmed}`;
    }
    const started = performance.now();
    setPending(true);
    try {
      const res = await db.subscribe(connection.id, { pattern: trimmed }, (event) => {
        setEvents(prev => {
          const next = prev.concat({ ...event, __seq: ++seqRef.current });
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
      });
      setSubscriptionId(res.subscriptionId);
      activeIdRef.current = res.subscriptionId;
      onPatternChange?.(trimmed);
      onLogQuery?.(cmd, {
        source: 'system',
        status: 'ok',
        durationMs: performance.now() - started,
        message: 'subscription started',
      });
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      onLogQuery?.(cmd, {
        source: 'system',
        status: 'error',
        durationMs: performance.now() - started,
        message: msg,
      });
      toast.error(msg);
    } finally {
      setPending(false);
    }
  };

  const handleStop = async () => {
    const id = subscriptionId;
    if (!id) return;
    const started = performance.now();
    setPending(true);
    const stopVerb = realtimeKind === 'listenNotify'
      ? 'UNLISTEN'
      : realtimeKind === 'changeStream'
        ? 'STOP WATCH'
        : 'UNSUBSCRIBE';
    try {
      await db.unsubscribe(id);
      onLogQuery?.(stopVerb, {
        source: 'system',
        status: 'ok',
        durationMs: performance.now() - started,
        message: 'subscription stopped',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLogQuery?.(stopVerb, {
        source: 'system',
        status: 'error',
        durationMs: performance.now() - started,
        message: msg,
      });
      console.warn('unsubscribe failed', err);
    } finally {
      setSubscriptionId(null);
      activeIdRef.current = null;
      setPending(false);
    }
  };

  const handleClear = () => setEvents([]);

  const handleCopy = (event: RecordedEvent) => {
    const text = typeof event.payload === 'string'
      ? event.payload
      : JSON.stringify(event.payload);
    void navigator.clipboard.writeText(text);
    toast.success('Payload copied');
  };

  const countLabel = useMemo(
    () => `${events.length.toLocaleString()}${events.length >= MAX_EVENTS ? ' (capped)' : ''}`,
    [events.length],
  );

  const handlePublish = async () => {
    if (publishing) return;
    const channel = pubChannel.trim();
    if (!channel) {
      toast.error('Enter a channel to publish to');
      return;
    }
    // Build the adapter-native publish command.
    // Redis: `PUBLISH <chan> "<payload>"`
    // Postgres: `NOTIFY <chan>, '<payload>'`
    // Mongo: insertOne on target collection to emit a change-stream event.
    let cmd: string;
    if (realtimeKind === 'listenNotify') {
      const safeChannel = channel.replace(/"/g, '""');
      const safePayload = pubPayload.replace(/'/g, "''");
      cmd = `NOTIFY "${safeChannel}", '${safePayload}'`;
    } else if (realtimeKind === 'changeStream') {
      const target = parseMongoTarget(channel);
      if (!target) {
        toast.error('Mongo publish target must be `collection` or `db.collection`');
        return;
      }
      let payloadDoc: unknown;
      try {
        payloadDoc = JSON.parse(pubPayload.trim() || '{}');
      } catch {
        toast.error('Mongo payload must be valid JSON object');
        return;
      }
      if (!payloadDoc || typeof payloadDoc !== 'object' || Array.isArray(payloadDoc)) {
        toast.error('Mongo payload must be a JSON object');
        return;
      }
      const collEsc = target.collection.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const json = JSON.stringify(payloadDoc);
      if (target.db) {
        const dbEsc = target.db.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        cmd = `db.getSiblingDB("${dbEsc}").getCollection("${collEsc}").insertOne(${json})`;
      } else {
        cmd = `db.getCollection("${collEsc}").insertOne(${json})`;
      }
    } else {
      const escaped = pubPayload.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      cmd = `PUBLISH ${channel} "${escaped}"`;
    }
    const entryId = ++pubSeqRef.current;
    const started = performance.now();
    setPublishing(true);
    try {
      const res = await db.runQuery(connection.id, cmd);
      const stmt = res.statements[0];
      let receivers: number | null = null;
      const first = stmt?.rows?.[0]?.[0];
      if (typeof first === 'number') receivers = first;
      else if (typeof first === 'string') {
        const n = Number(first);
        if (Number.isFinite(n)) receivers = n;
      }
      const elapsed = performance.now() - started;
      if (stmt?.error) {
        onLogQuery?.(cmd, { source: 'editor', status: 'error', message: stmt.error, durationMs: elapsed });
      } else {
        // PG NOTIFY doesn't return a receiver count — the server doesn't
        // know how many listeners there are. Show a status instead.
        const statusMsg = realtimeKind === 'listenNotify'
          ? 'notified'
          : realtimeKind === 'changeStream'
            ? 'inserted'
            : `${receivers ?? 0} receiver${receivers === 1 ? '' : 's'}`;
        onLogQuery?.(cmd, {
          source: 'editor',
          status: 'ok',
          durationMs: elapsed,
          message: statusMsg,
        });
      }
      setPublishLog(prev => {
        const next = prev.concat({
          id: entryId,
          channel,
          payload: pubPayload,
          sentAtMs: Date.now(),
          receivers,
          error: stmt?.error ?? null,
        });
        return next.length > MAX_PUBLISH_LOG ? next.slice(next.length - MAX_PUBLISH_LOG) : next;
      });
      if (stmt?.error) toast.error(stmt.error);
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      setPublishLog(prev => {
        const next = prev.concat({
          id: entryId,
          channel,
          payload: pubPayload,
          sentAtMs: Date.now(),
          receivers: null,
          error: msg,
        });
        return next.length > MAX_PUBLISH_LOG ? next.slice(next.length - MAX_PUBLISH_LOG) : next;
      });
      onLogQuery?.(cmd, {
        source: 'editor',
        status: 'error',
        message: msg,
        durationMs: performance.now() - started,
      });
      toast.error(msg);
    } finally {
      setPublishing(false);
    }
  };

  const handleClearPublishLog = () => setPublishLog([]);

  const handleDividerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, startPct: leftPct };
    const onMove = (ev: MouseEvent) => {
      const container = splitRef.current;
      const start = dragStartRef.current;
      if (!container || !start) return;
      const width = container.getBoundingClientRect().width;
      if (width <= 0) return;
      const deltaPct = ((ev.clientX - start.x) / width) * 100;
      // Clamp to 15..85 so neither side can collapse below a usable size.
      const next = Math.max(15, Math.min(85, start.startPct + deltaPct));
      setLeftPct(next);
    };
    const onUp = () => {
      dragStartRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    // Kill text selection while dragging — otherwise the pane contents
    // get selected as the user sweeps across them.
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleOpenChat = () => {
    window.dispatchEvent(new CustomEvent('tablerelay:toggle-chat'));
  };

  return (
    <div ref={splitRef} className="flex-1 flex min-h-0 relative">
      {/* ───── Left: Publish ───── */}
      {canPublish && (
      <div
        style={{ width: `${leftPct}%` }}
        className="min-w-0 flex flex-col border-r border-border/50"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-muted/30">
          <Send className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">Publish</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {publishLog.length} sent
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClearPublishLog}
            disabled={publishLog.length === 0}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Clear
          </Button>
        </div>

        <div className="px-3 py-3 flex flex-col gap-2 border-b border-border/50">
          <div className="flex flex-col gap-1">
            <label className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
              {realtimeKind === 'changeStream' ? 'Collection' : 'Channel'}
            </label>
            <Input
              value={pubChannel}
              onChange={e => setPubChannel(e.target.value)}
              placeholder={realtimeKind === 'changeStream' ? 'e.g. users or clipbridge.users' : 'e.g. news.updates'}
              className="h-8"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
              Payload
            </label>
            <textarea
              value={pubPayload}
              onChange={e => setPubPayload(e.target.value)}
              placeholder={realtimeKind === 'changeStream' ? '{"event":"updated"}' : 'Message body (plain text or JSON)'}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onKeyDown={e => {
                // ⌘/Ctrl + Enter fires publish — standard for send-like
                // actions inside multi-line textareas.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handlePublish();
                }
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handlePublish}
              disabled={publishing || !pubChannel.trim()}
            >
              <Send className="w-3.5 h-3.5 mr-1.5" /> Publish
            </Button>
            <span className="text-[10.5px] text-muted-foreground">⌘+Enter</span>
          </div>
          {realtimeKind === 'changeStream' && (
            <p className="text-[10px] text-muted-foreground">
              Publish inserts one document into the target collection to trigger change streams.
            </p>
          )}
        </div>

        <div className="flex-1 overflow-auto font-mono text-[11.5px] leading-relaxed">
          {publishLog.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
              No messages sent yet.
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur text-muted-foreground text-[10.5px] uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-3 py-1.5 w-27.5">Time</th>
                  <th className="text-left font-medium px-3 py-1.5 w-45">Channel</th>
                  <th className="text-left font-medium px-3 py-1.5">Payload</th>
                  <th className="text-right font-medium px-3 py-1.5 w-17.5">Recv</th>
                </tr>
              </thead>
              <tbody>
                {[...publishLog].reverse().map(entry => (
                  <tr key={entry.id} className="border-b border-border/40 hover:bg-muted/40">
                    <td className="px-3 py-1 align-top whitespace-nowrap text-muted-foreground">
                      {formatTime(entry.sentAtMs)}
                    </td>
                    <td className="px-3 py-1 align-top text-foreground">
                      <span className="truncate inline-block max-w-40" title={entry.channel}>
                        {entry.channel}
                      </span>
                    </td>
                    <td className="px-3 py-1 align-top">
                      {entry.error ? (
                        <span className="text-destructive break-all">{entry.error}</span>
                      ) : (
                        <span className="break-all whitespace-pre-wrap">{entry.payload}</span>
                      )}
                    </td>
                    <td className="px-3 py-1 align-top text-right tabular-nums text-muted-foreground">
                      {entry.error ? '—' : entry.receivers ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      )}

      {/* Drag handle between Publish ↔ Subscribe. Sits on the border
          as a thin interactive strip; the visible border is still the
          adjacent column's `border-r`. */}
      {canPublish && (
      <div
        onMouseDown={handleDividerDown}
        onDoubleClick={() => setLeftPct(50)}
        title="Drag to resize — double-click to reset"
        className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/60 transition-colors"
      />
      )}

      {/* ───── Right: Subscribe ───── */}
      <div
        style={{ width: canPublish ? `calc(${100 - leftPct}% - 0.25rem)` : '100%' }}
        className="min-w-0 flex flex-col"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-muted/30">
          <Radio className={`w-4 h-4 shrink-0 ${isRunning ? 'text-emerald-500 animate-pulse' : 'text-muted-foreground'}`} />
          <span className="text-sm font-medium">Subscribe</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {countLabel} received
          </span>
          <Button size="sm" variant="ghost" onClick={handleClear} disabled={events.length === 0}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Clear
          </Button>
          <Button size="sm" variant="ghost" onClick={handleOpenChat} title="AI Chat">
            <Sparkles className="w-3.5 h-3.5 mr-1.5" /> Chat
          </Button>
        </div>

        <div className="px-3 py-3 flex flex-col gap-2 border-b border-border/50">
          <div className="flex flex-col gap-1">
            <label className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
              {realtimeKind === 'listenNotify' ? 'Channel' : 'Pattern'}
            </label>
            <Input
              value={pattern}
              onChange={e => setPattern(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !isRunning) void handleStart();
              }}
              placeholder={
                realtimeKind === 'listenNotify'
                  ? 'e.g. events_user_created'
                  : realtimeKind === 'changeStream'
                    ? 'e.g. * or users or clipbridge.users'
                    : 'e.g. * or foo.*'
              }
              disabled={isRunning || pending}
              className="h-8"
            />
            {realtimeKind === 'listenNotify' && (
              <p className="text-[10px] text-muted-foreground">
                LISTEN channels are literal identifiers — wildcards
                like <code>*</code> or <code>?</code> aren&apos;t supported.
              </p>
            )}
            {realtimeKind === 'changeStream' && (
              <p className="text-[10px] text-muted-foreground">
                Realtime uses change streams. Pattern can be <code>*</code>,
                a collection name, or <code>db.collection</code>.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Button size="sm" variant="destructive" onClick={handleStop} disabled={pending}>
                <Square className="w-3.5 h-3.5 mr-1.5" /> Stop
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleStart}
                disabled={
                  pending
                  || !pattern.trim()
                  || (!adapterAllowsGlobs && /[*?\[]/.test(pattern))
                }
              >
                <Play className="w-3.5 h-3.5 mr-1.5" /> Start
              </Button>
            )}
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <Checkbox
                checked={autoScroll}
                onCheckedChange={(c) => setAutoScroll(c === true)}
              />
              Auto-scroll
            </label>
          </div>
        </div>

        <div
          ref={listRef}
          className="flex-1 overflow-auto font-mono text-[11.5px] leading-relaxed"
          onScroll={e => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (atBottom !== autoScroll) setAutoScroll(atBottom);
          }}
        >
          {events.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
              {isRunning ? 'Waiting for events…' : 'Start a subscription to stream events.'}
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur text-muted-foreground text-[10.5px] uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-3 py-1.5 w-27.5">Time</th>
                  <th className="text-left font-medium px-3 py-1.5 w-45">Channel</th>
                  <th className="text-left font-medium px-3 py-1.5">Payload</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {events.map(ev => (
                  <tr key={ev.__seq} className="border-b border-border/40 hover:bg-muted/40 group">
                    <td className="px-3 py-1 align-top whitespace-nowrap text-muted-foreground">
                      {formatTime(ev.receivedAtMs)}
                    </td>
                    <td className="px-3 py-1 align-top text-foreground">
                      <span className="truncate inline-block max-w-40" title={ev.channel}>
                        {ev.channel}
                      </span>
                    </td>
                    <td className="px-3 py-1 align-top">
                      <span className="break-all whitespace-pre-wrap">{formatPayload(ev.payload)}</span>
                    </td>
                    <td className="px-2 py-1 align-top">
                      <button
                        onClick={() => handleCopy(ev)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                        title="Copy payload"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload === null || payload === undefined) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function parseMongoTarget(input: string): { db?: string; collection: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length === 1) {
    const collection = parts[0].trim();
    return collection ? { collection } : null;
  }
  if (parts.length === 2) {
    const db = parts[0].trim();
    const collection = parts[1].trim();
    if (!db || !collection) return null;
    return { db, collection };
  }
  return null;
}
