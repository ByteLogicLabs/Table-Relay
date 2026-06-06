import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, AlertCircle, Copy, CheckCircle2, Wrench, Check as CheckIcon, X as XIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { approveToolCall, type ChatMessage as StoreChatMessage } from '../../state/ai';
import { type QueryTier } from '../../lib/ai';
import { markdownClass, renderMarkdown } from '../../lib/markdown';
import { highlight, tokenClass } from '../../lib/highlight';
import { toast } from 'sonner';
import { formatMessageTime, prettyToolName, extractErrorString, truncate } from './chat-utils';

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      className={`flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground bg-background/60 hover:bg-background border border-border rounded px-1.5 py-0.5 transition-colors ${className}`}
      title={copied ? 'Copied!' : 'Copy'}
    >
      {copied ? <CheckIcon className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function HighlightedSql({ sql, className }: { sql: string; className?: string }) {
  const tokens = highlight(sql, 'sql');
  return (
    <div className="relative group/sql">
      <pre className={`${className ?? ''} select-text`}>
        {tokens.map((t, i) => (
          <span key={i} className={tokenClass[t.kind]}>{t.text}</span>
        ))}
      </pre>
      <CopyButton
        text={sql}
        className="absolute top-1 right-1 opacity-0 group-hover/sql:opacity-100 focus:opacity-100"
      />
    </div>
  );
}

/**
 * User and assistant chat bubbles. Assistant replies are rendered as
 * sanitized markdown (tables, fenced code, lists, links) once the stream
 * finishes — during streaming we keep the content as plain text so
 * half-rendered tables don't flash broken HTML.
 */
export function AssistantOrUserBubble({ message: m }: { message: StoreChatMessage }) {
  const isUser = m.role === 'user';
  const renderMd = !isUser && !m.streaming && m.content.length > 0;
  const html = useMemo(
    () => (renderMd ? renderMarkdown(m.content) : ''),
    [renderMd, m.content]
  );

  return (
    <div className={`group/msg flex min-w-0 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`relative min-w-0 max-w-[85%] overflow-hidden rounded-lg px-3 py-2 wrap-break-word select-text ${
          isUser
            ? 'bg-primary text-primary-foreground text-sm whitespace-pre-wrap'
            : 'bg-muted text-foreground'
        } ${renderMd ? '' : 'text-sm whitespace-pre-wrap'}`}
      >
        {!isUser && m.content.length > 0 && !m.streaming && (
          <CopyButton
            text={m.content}
            className="absolute top-1 right-1 opacity-0 group-hover/msg:opacity-100 focus:opacity-100 z-10"
          />
        )}
        {m.streaming && m.content.length === 0 ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="italic">Thinking…</span>
          </span>
        ) : renderMd ? (
          <div
            className={markdownClass}
            onClick={async (e) => {
              const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-md-copy]');
              if (!btn) return;
              const text = btn.dataset.mdCopy ?? '';
              try {
                await navigator.clipboard.writeText(text);
                const orig = btn.textContent;
                btn.textContent = 'Copied';
                setTimeout(() => { btn.textContent = orig; }, 1500);
              } catch { toast.error('Copy failed'); }
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <>
            {m.content}
            {m.streaming && (
              <span className="inline-block w-1.5 h-3 ml-1 bg-current opacity-60 animate-pulse align-middle" />
            )}
          </>
        )}
        {m.finishReason === 'canceled' && (
          <span className="block text-[10px] text-muted-foreground mt-1 italic">(canceled)</span>
        )}
        {m.finishReason === 'error' && (
          <span className="block text-[10px] text-destructive mt-1 italic">(error)</span>
        )}
        {m.createdAt && !m.streaming && (
          <span className={`block text-[10px] mt-1 ${isUser ? 'text-primary-foreground/60' : 'text-muted-foreground/60'}`}>
            {formatMessageTime(m.createdAt)}
          </span>
        )}
      </div>
    </div>
  );
}

export function ToolBubble({ message }: { message: StoreChatMessage }) {
  const t = message.tool;
  const cardRef = useRef<HTMLDivElement>(null);
  const pending = !!t?.pendingApproval;

  // Pull the approval card into view when it first appears. Without this
  // the model's prose can push it below the fold and the user stares at
  // "Thinking…" waiting for a button they can't see.
  useEffect(() => {
    if (pending && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [pending]);

  if (!t) return null;
  const denied = !!t.denied;
  const succeeded = !!t.result && !denied;

  return (
    <div className="flex justify-start" ref={cardRef}>
      <div className={`max-w-[92%] w-full rounded-lg px-3 py-2 text-xs select-text ${
        pending
          ? 'border-2 border-primary bg-primary/5 shadow-[0_0_0_4px_rgba(var(--primary-rgb,59,130,246),0.1)]'
          : 'border border-border bg-muted/30'
      }`}>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Wrench className="w-3 h-3" />
          <span className="text-foreground font-medium" title={t.name}>{prettyToolName(t.name)}</span>
          {pending && (
            <span className="ml-auto flex items-center gap-1 text-[10px] font-medium text-primary">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Approval needed
            </span>
          )}
          {!pending && !succeeded && !denied && (
            <span className="ml-auto flex items-center gap-1 text-[10px] opacity-80">
              <Loader2 className="w-3 h-3 animate-spin" />
              running…
            </span>
          )}
          {succeeded && (
            <span className="ml-auto text-[10px] text-green-600 dark:text-green-400">done</span>
          )}
          {denied && (
            <span className="ml-auto text-[10px] text-destructive">denied</span>
          )}
        </div>

        {t.pendingApproval ? (
          <ApprovalCard
            toolCallId={message.id}
            sql={t.pendingApproval.sql}
            summary={t.pendingApproval.summary}
            toolName={t.pendingApproval.toolName ?? t.name}
            mode={t.pendingApproval.mode}
            title={t.pendingApproval.title}
            tier={t.pendingApproval.tier}
            object={t.pendingApproval.object}
            objectName={t.pendingApproval.objectName}
          />
        ) : (
          <ToolCardBody name={t.name} args={t.arguments} result={t.result} denied={denied} />
        )}
      </div>
    </div>
  );
}

/**
 * Pretty renderer for completed (or denied) tool calls. Replaces the
 * raw-JSON `arguments` / `result` dump with a per-tool summary: SQL
 * goes in a fenced block, schema listings render as a compact name
 * list, errors surface on one line. Falls back to JSON preview for
 * unknown tools so the info isn't lost if we add a new tool later.
 */
function ToolCardBody({
  name,
  args,
  result,
  denied,
}: {
  name: string;
  args: string;
  result?: string;
  denied: boolean;
}) {
  const parsedArgs = useMemo<Record<string, unknown> | null>(() => {
    if (!args || args === '{}') return null;
    try {
      const v = JSON.parse(args);
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [args]);

  const parsedResult = useMemo<unknown>(() => {
    if (result === undefined) return undefined;
    try { return JSON.parse(result); } catch { return result; }
  }, [result]);

  const argSummary = renderToolArgs(name, parsedArgs);
  const resultBlock = denied
    ? null
    : renderToolResult(name, parsedResult);

  const resultErr = extractErrorString(parsedResult);

  return (
    <div className="mt-1.5 space-y-1.5">
      {argSummary}
      {resultErr && (
        <div className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertCircle className="w-3 h-3 mt-px shrink-0" />
          <span className="flex-1 min-w-0 break-words">{resultErr}</span>
        </div>
      )}
      {!resultErr && resultBlock}
      {/* Fallback: raw JSON tucked inside a details so nothing is lost
          when the model adds a new tool we don't render specially. */}
      {!argSummary && !resultBlock && !resultErr && (parsedArgs || parsedResult !== undefined) && (
        <details>
          <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
            Details
          </summary>
          {parsedArgs && (
            <pre className="mt-1 text-[10px] font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1">
              {truncate(JSON.stringify(parsedArgs, null, 2), 400)}
            </pre>
          )}
          {parsedResult !== undefined && (
            <pre className="mt-1 text-[10px] font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1 max-h-48 overflow-auto">
              {truncate(typeof parsedResult === 'string' ? parsedResult : JSON.stringify(parsedResult, null, 2), 2000)}
            </pre>
          )}
        </details>
      )}
    </div>
  );
}

/** Per-tool pretty printer for the arguments. Returns null when the
 *  tool has nothing interesting to show (or we have no parsed args). */
function renderToolArgs(
  name: string,
  args: Record<string, unknown> | null,
): ReactNode {
  if (!args) return null;
  switch (name) {
    case 'call_query':
    case 'call_sql':
    case 'run_query':
    case 'write_query_tab': {
      const sql = typeof args.sql === 'string' ? args.sql : '';
      if (!sql) return null;
      const mode = typeof args.mode === 'string' ? args.mode : undefined;
      const title = typeof args.title === 'string' ? args.title : undefined;
      return (
        <>
          {(mode || title) && (
            <div className="text-[10.5px] text-muted-foreground">
              {mode && <span>mode: <code className="font-mono">{mode}</code></span>}
              {mode && title && <span> · </span>}
              {title && <span>title: <code className="font-mono">{title}</code></span>}
            </div>
          )}
          <HighlightedSql
            sql={sql}
            className="text-[11px] font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1.5 max-h-48 overflow-auto"
          />
        </>
      );
    }
    case 'open_object_tab': {
      const object = typeof args.object === 'string' ? args.object : '';
      const objName = typeof args.name === 'string' ? args.name : undefined;
      const sql = typeof args.sql === 'string' ? args.sql : '';
      return (
        <>
          <div className="text-[10.5px] text-muted-foreground">
            {object && <span>open: <code className="font-mono">{object}</code></span>}
            {object && objName && <span> · </span>}
            {objName ? (
              <span>edit <code className="font-mono">{objName}</code></span>
            ) : (
              object && <span>(new)</span>
            )}
          </div>
          {sql && (
            <HighlightedSql
              sql={sql}
              className="text-[11px] font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1.5 max-h-48 overflow-auto"
            />
          )}
        </>
      );
    }
    case 'publish_notify': {
      const channel = typeof args.channel === 'string' ? args.channel : '';
      const payload = typeof args.payload === 'string' ? args.payload : '';
      return (
        <div className="text-[11px] space-y-1">
          <div>
            <span className="text-muted-foreground">channel: </span>
            <code className="font-mono">{channel}</code>
          </div>
          {payload && (
            <pre className="font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1 max-h-32 overflow-auto text-[10.5px]">
              {payload}
            </pre>
          )}
        </div>
      );
    }
    case 'subscribe_channel': {
      const channel = typeof args.channel === 'string' ? args.channel : '';
      return (
        <div className="text-[11px]">
          <span className="text-muted-foreground">channel: </span>
          <code className="font-mono">{channel}</code>
        </div>
      );
    }
    case 'list_tables':
    case 'describe_table': {
      const schema = typeof args.schema === 'string' ? args.schema : undefined;
      const table = typeof args.table === 'string' ? args.table : undefined;
      if (!schema && !table) return null;
      return (
        <div className="text-[11px] text-muted-foreground">
          {schema && <span>schema: <code className="font-mono text-foreground">{schema}</code></span>}
          {schema && table && <span> · </span>}
          {table && <span>table: <code className="font-mono text-foreground">{table}</code></span>}
        </div>
      );
    }
    default:
      return null;
  }
}

/** Per-tool pretty printer for the result payload. Null means "let the
 *  caller decide" — usually the fallback details block or nothing. */
function renderToolResult(name: string, result: unknown): ReactNode {
  if (result === undefined) return null;
  if (result === null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if ('error' in r) return null; // surfaced separately by `resultErr`
  switch (name) {
    case 'list_schemas': {
      const schemas = Array.isArray(r.schemas) ? (r.schemas as unknown[]).filter(s => typeof s === 'string') as string[] : [];
      if (schemas.length === 0) {
        return <div className="text-[11px] text-muted-foreground">No schemas.</div>;
      }
      return (
        <div className="text-[11px]">
          <div className="text-muted-foreground mb-1">{schemas.length} schema{schemas.length === 1 ? '' : 's'}:</div>
          <div className="flex flex-wrap gap-1">
            {schemas.map(s => (
              <code key={s} className="font-mono px-1.5 py-0.5 rounded bg-muted/60 border border-border">{s}</code>
            ))}
          </div>
        </div>
      );
    }
    case 'list_tables': {
      const schema = typeof r.schema === 'string' ? r.schema : '';
      const tables = Array.isArray(r.tables) ? (r.tables as Array<Record<string, unknown>>) : [];
      if (tables.length === 0) {
        return (
          <div className="text-[11px] text-muted-foreground">
            No tables in <code className="font-mono">{schema}</code>.
          </div>
        );
      }
      return (
        <div className="text-[11px]">
          <div className="text-muted-foreground mb-1">
            {tables.length} object{tables.length === 1 ? '' : 's'} in <code className="font-mono text-foreground">{schema}</code>:
          </div>
          <div className="flex flex-wrap gap-1">
            {tables.map((t, i) => {
              const n = typeof t.name === 'string' ? t.name : String(i);
              const k = typeof t.kind === 'string' ? t.kind : '';
              return (
                <code key={`${n}-${i}`} className="font-mono px-1.5 py-0.5 rounded bg-muted/60 border border-border">
                  {n}
                  {k && k !== 'table' && <span className="text-muted-foreground"> · {k}</span>}
                </code>
              );
            })}
          </div>
        </div>
      );
    }
    case 'describe_table': {
      const schema = typeof r.schema === 'string' ? r.schema : '';
      const table = typeof r.table === 'string' ? r.table : '';
      const columns = Array.isArray(r.columns) ? (r.columns as Array<Record<string, unknown>>) : [];
      const pk = Array.isArray(r.primaryKey) ? (r.primaryKey as unknown[]).filter(s => typeof s === 'string') as string[] : [];
      const fks = Array.isArray(r.foreignKeys) ? (r.foreignKeys as Array<Record<string, unknown>>) : [];
      return (
        <div className="text-[11px] space-y-1.5">
          <div className="text-muted-foreground">
            <code className="font-mono text-foreground">{schema}.{table}</code>
            {' · '}
            {columns.length} col{columns.length === 1 ? '' : 's'}
            {pk.length > 0 && <>, PK (<code className="font-mono text-foreground">{pk.join(', ')}</code>)</>}
            {fks.length > 0 && <>, {fks.length} FK</>}
          </div>
          <details>
            <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
              Columns
            </summary>
            <div className="mt-1 flex flex-col gap-0.5 font-mono">
              {columns.map((c, i) => {
                const n = typeof c.name === 'string' ? c.name : String(i);
                const ty = typeof c.type === 'string' ? c.type : '';
                const isPk = c.pk === true;
                const notNull = c.notNull === true;
                return (
                  <div key={`${n}-${i}`} className="flex items-baseline gap-2 text-[10.5px]">
                    <span className={isPk ? 'text-primary font-medium' : ''}>{n}</span>
                    <span className="text-muted-foreground">{ty}</span>
                    {isPk && <span className="text-[9px] text-primary">PK</span>}
                    {notNull && !isPk && <span className="text-[9px] text-muted-foreground">NOT NULL</span>}
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      );
    }
    case 'call_query':
    case 'call_sql':
    case 'run_query': {
      const cols = Array.isArray(r.columns) ? (r.columns as unknown[]).filter(s => typeof s === 'string') as string[] : [];
      const rows = Array.isArray(r.rows) ? (r.rows as unknown[]) : [];
      const shown = typeof r.row_count_shown === 'number' ? r.row_count_shown : rows.length;
      const truncated = r.truncated === true;
      const durationMs = typeof r.duration_ms === 'number' ? r.duration_ms : null;
      if (cols.length === 0 && rows.length === 0) {
        return <div className="text-[11px] text-muted-foreground">Query ok — no rows.</div>;
      }
      return (
        <div className="text-[11px] space-y-1">
          <div className="text-muted-foreground">
            {shown} row{shown === 1 ? '' : 's'}
            {truncated && <span> (truncated)</span>}
            {cols.length > 0 && <> · {cols.length} col{cols.length === 1 ? '' : 's'}</>}
            {durationMs !== null && <> · {durationMs.toFixed(0)}ms</>}
          </div>
          <details>
            <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
              Preview
            </summary>
            <pre className="mt-1 font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1 max-h-48 overflow-auto text-[10.5px]">
              {truncate(JSON.stringify({ columns: cols, rows }, null, 2), 2000)}
            </pre>
          </details>
        </div>
      );
    }
    case 'write_query_tab':
    case 'open_object_tab':
    case 'publish_notify':
    case 'subscribe_channel': {
      const ok = r.ok === true;
      const msg = typeof r.message === 'string' ? r.message : (ok ? 'Done.' : '');
      if (!msg) return null;
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <CheckCircle2 className="w-3 h-3 mt-px text-green-600 dark:text-green-400 shrink-0" />
          <span className="flex-1 min-w-0">{msg}</span>
        </div>
      );
    }
    default:
      return null;
  }
}

function ApprovalCard({
  toolCallId,
  sql,
  summary,
  toolName,
  mode,
  title,
  tier,
  object,
  objectName,
}: {
  toolCallId: string;
  sql?: string;
  summary?: string;
  toolName?: string;
  mode?: 'new' | 'replace';
  title?: string;
  tier?: QueryTier;
  object?: 'trigger' | 'table';
  objectName?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const doApprove = async (approve: boolean) => {
    setBusy(true);
    try { await approveToolCall(toolCallId, approve); }
    finally { setBusy(false); }
  };
  const isTabWrite = toolName === 'write_query_tab';
  const isPublish = toolName === 'publish_notify';
  const isSubscribe = toolName === 'subscribe_channel';
  const isOpenObject = toolName === 'open_object_tab';
  const isRead = toolName === 'list_schemas' || toolName === 'list_tables' || toolName === 'describe_table';
  let prompt: string;
  let approveLabel: string;
  if (isTabWrite) {
    prompt = mode === 'replace'
      ? `Model wants to replace the current query tab with this query${title ? ` (title: ${title})` : ''}:`
      : `Model wants to open a new query tab with this query${title ? ` (title: ${title})` : ''}:`;
    approveLabel = mode === 'replace' ? 'Approve & replace' : 'Approve & open';
  } else if (isOpenObject) {
    const obj = object ?? 'object';
    prompt = objectName
      ? `Model wants to open the ${obj} editor for "${objectName}":`
      : `Model wants to open a new ${obj} editor:`;
    approveLabel = 'Approve & open';
  } else if (isPublish) {
    prompt = 'Model wants to publish this message:';
    approveLabel = 'Approve & publish';
  } else if (isSubscribe) {
    prompt = 'Model wants to start a realtime subscription:';
    approveLabel = 'Approve & subscribe';
  } else if (isRead) {
    prompt = 'Model wants to read schema info:';
    approveLabel = 'Approve & read';
  } else {
    prompt = 'Model wants to run this query:';
    approveLabel = 'Approve & run';
  }
  // Prefer the query preview when we have it; fall back to `summary` for
  // read-only shape tools. Both go through the same monospace preview
  // block so the card layout stays uniform.
  const hasSql = !!(sql && sql.length > 0);
  const body = hasSql ? sql! : (summary ?? '(no preview)');
  // Tier badge — only for SQL query approvals carrying a classified tier.
  // Mirrors the small rounded-full pill style used elsewhere in this file.
  const tierBadgeClass: Record<QueryTier, string> = {
    read: 'bg-muted text-muted-foreground',
    write: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    create: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    delete: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    destructive: 'bg-destructive/15 text-destructive',
  };
  const showTier = toolName === 'call_query' && !!tier;
  return (
    <div className="mt-1 space-y-2">
      {showTier && tier ? (
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${tierBadgeClass[tier]}`}>
            {tier.toUpperCase()}
          </span>
          {tier === 'destructive' ? (
            <span className="text-[10px] text-destructive">Irreversible — always requires approval</span>
          ) : null}
        </div>
      ) : null}
      <div className="text-[11px] text-muted-foreground">{prompt}</div>
      {hasSql ? (
        <HighlightedSql
          sql={body}
          className="text-[11px] font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1.5 max-h-48 overflow-auto"
        />
      ) : (
        <pre className="text-[11px] font-mono whitespace-pre-wrap wrap-break-word bg-background/60 border border-border rounded px-2 py-1.5 max-h-48 overflow-auto">
          {body}
        </pre>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => void doApprove(true)}
        >
          <CheckIcon className="w-3 h-3 mr-1" />
          {approveLabel}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-destructive"
          disabled={busy}
          onClick={() => void doApprove(false)}
        >
          <XIcon className="w-3 h-3 mr-1" />
          Deny
        </Button>
      </div>
    </div>
  );
}
