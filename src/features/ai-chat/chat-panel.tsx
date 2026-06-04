import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X, Sparkles, Square, Loader2, AlertCircle, Eye, EyeOff, RefreshCw, Plus, ArrowUp, Shield } from 'lucide-react';
import { ConversationHistory } from './conversation-history';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Checkbox } from '../../components/ui/checkbox';
import { useAi, start, end, sendMessage, stopStreaming, syncStatus, approveToolCall, newChat, setFocusedConnection, currentChat, type ChatMessage as StoreChatMessage, type ChatPrefill } from '../../state/ai';
import { ai, isAiError, type AiProviderKind, type ChatFocus, type LocalModelInfo, type DownloadDoneEvent, type LlamaRuntimeStatus, type AutoApprovalFlags, type QueryTier } from '../../lib/ai';
import {
  type CredentialProfile,
  getActiveCredentialId,
  hydrateCredentials,
  loadCredentials,
  setActiveCredentialId,
} from '../../lib/ai-credentials';
import { Settings as SettingsIcon } from 'lucide-react';
import { markdownClass, renderMarkdown } from '../../lib/markdown';
import { highlight, tokenClass } from '../../lib/highlight';
import { Trash2, Download as DownloadIcon, StopCircle, Copy, CheckCircle2, ExternalLink, Wrench, Check as CheckIcon, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';

interface ChatPanelProps {
  onClose: () => void;
  /** Currently-focused DB connection, piped from WorkspaceView. Used to
   *  auto-attach schema context on the first chat turn. */
  focusedConnectionId?: string;
  focusedSchema?: string;
  /** Human-readable label for the header chip, e.g. "conn_name / schema_name". */
  focusedLabel?: string;
  /** What the user has open in the active tab — query buffer, routine
   *  definition, or focused table. Forwarded verbatim to `ai_chat_send`
   *  so the model can answer "this" questions without a paste. */
  focus?: ChatFocus;
}

interface ProviderOption {
  kind: AiProviderKind;
  label: string;
  sublabel: string;
  available: boolean;
  /** Default model id shown pre-filled in the config form. */
  defaultModel?: string;
  /** Does this provider require an API key on Start? */
  needsKey: boolean;
  /** Does this provider optionally accept an API key? */
  optionalKey?: boolean;
  /** Does this provider require a base URL (OpenAI-compatible only)? */
  needsBaseUrl?: boolean;
}

function parseKeyFromUrlLike(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  // Direct key paste.
  if (/^AIza[0-9A-Za-z\-_]{10,}$/.test(raw) || /^ya29\.[0-9A-Za-z\-_\.]+$/.test(raw)) {
    return raw;
  }
  try {
    const url = new URL(raw);
    const params = url.searchParams;
    const candidates = ['key', 'api_key', 'apikey', 'access_token', 'token'];
    for (const name of candidates) {
      const found = params.get(name);
      if (found && found.trim()) return found.trim();
    }
    if (url.hash.startsWith('#')) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      for (const name of candidates) {
        const found = hashParams.get(name);
        if (found && found.trim()) return found.trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Echo is kept in the backend for tests and as a fallback, but hidden from
// the UI now that hosted providers are live. Local Llama stays listed but
// disabled until M8.1 lands.
const PROVIDERS: ProviderOption[] = [
  { kind: 'openai', label: 'OpenAI', sublabel: 'chat/completions', available: true, needsKey: true, defaultModel: 'gpt-4o-mini' },
  { kind: 'anthropic', label: 'Anthropic', sublabel: 'messages API', available: true, needsKey: true, defaultModel: 'claude-3-5-haiku-latest' },
  { kind: 'gemini', label: 'Google', sublabel: 'generativelanguage', available: true, needsKey: true, defaultModel: 'gemini-2.5-pro' },
  { kind: 'openai_compatible', label: 'OpenAI-compatible', sublabel: 'Ollama / Groq / LM Studio', available: true, needsKey: false, optionalKey: true, needsBaseUrl: true, defaultModel: 'llama3.1' },
  { kind: 'llama_local', label: 'Local Llama', sublabel: 'GGUF · on-device', available: true, needsKey: false },
];

export default function ChatPanel({ onClose, focusedConnectionId, focusedSchema, focusedLabel, focus }: ChatPanelProps) {
  const s = useAi();
  // Per-connection chat bucket. The state machine for provider/model is
  // global; only transcripts + in-flight request + last error split by
  // connection so switching rail tiles keeps each conversation intact.
  const chat = currentChat(s);
  // `end()` now resets to `inactive` optimistically (backend teardown runs
  // in the background), so `ending` is effectively unreachable — the UI
  // flips to the StartScreen immediately on click. Keep the check anyway
  // in case an external caller sets the state directly.
  const showActive = s.status === 'active';

  // Reconcile with backend state on mount, and keep the store in sync with
  // whatever connection the workspace is looking at. The store uses this
  // to route new messages / tool events into the right bucket.
  useEffect(() => { void syncStatus(); }, []);
  useEffect(() => { setFocusedConnection(focusedConnectionId); }, [focusedConnectionId]);

  // Pending Fix / Explain / Generate prefill. Set by shortcuts fired from
  // QueryLog / SqlEditor; fires once the session is active. Survives panel
  // re-renders via a ref so the receiver isn't stale.
  const pendingPrefillRef = useRef<ChatPrefill | null>(null);
  const [prefillTick, setPrefillTick] = useState(0);
  useEffect(() => {
    const onPrefill = (ev: Event) => {
      const detail = (ev as CustomEvent<ChatPrefill>).detail;
      if (!detail) return;
      pendingPrefillRef.current = detail;
      setPrefillTick(t => t + 1);
    };
    window.addEventListener('tablerelay:ai-prefill', onPrefill);
    return () => window.removeEventListener('tablerelay:ai-prefill', onPrefill);
  }, []);

  return (
    <div className="h-full flex flex-col bg-background min-w-0 relative">
      <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-3 bg-muted/10">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          {/* Hide the static "AI Chat" label once a session is active — the
              credential + model pickers need the horizontal room, and without
              this they overflowed under the right-side action buttons. */}
          {!showActive && <span className="text-sm font-medium truncate">AI Chat</span>}
          {showActive && <ActiveCredentialPicker />}
          {showActive && <ActiveModelPicker providerKind={s.providerKind} model={s.model} />}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <ConversationHistory />
          {showActive && (
            <>
              <PermissionsButton />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="New chat — previous conversation is saved in history"
                aria-label="New chat"
                onClick={() => newChat()}
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[10px] uppercase tracking-wide text-muted-foreground"
                title="End the session — closes the current chat and returns to credential picker. Conversations remain saved."
                onClick={() => void end()}
              >
                End
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {showActive
        ? <ActiveSession
            focusedConnectionId={focusedConnectionId}
            focusedSchema={focusedSchema}
            focusedLabel={focusedLabel}
            focus={focus}
            pendingPrefillRef={pendingPrefillRef}
            prefillTick={prefillTick}
          />
        : <StartScreen pendingPrefill={pendingPrefillRef.current} prefillTick={prefillTick} />}
    </div>
  );
}

/**
 * Inline model switcher shown in the chat header during an active session.
 * Swap = end current session + start a fresh one with the saved credentials
 * and the newly-picked model. Conversation history is dropped (different
 * models don't share token boundaries; retaining chat history across models
 * produces subtly broken behavior, not worth the complexity).
 *
 * The trigger looks like the old provider/model chip so the header layout
 * is unchanged; clicking it opens the model list for the current provider.
 */
/** Permissions popover — lets the user preauthorize tools so the AI can
 *  call them without an Approve/Deny prompt every time. Flags live in the
 *  Rust `AutoApprovals` state (in-memory) and reset on app restart. */
function PermissionsButton() {
  const [flags, setFlags] = useState<AutoApprovalFlags | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Fetch once on mount. We re-fetch when the popover opens to pick up
    // out-of-band changes (e.g. another permissions UI, future settings).
    void ai.getAutoApprovals().then(setFlags).catch(() => setFlags({
      read_schema: true,
      read_structure: true,
      call_query: false,
      call_query_read: false,
      call_query_write: false,
      call_query_create: false,
      call_query_delete: false,
      cross_database: false,
      write_query_tab: false,
      publish_notify: false,
      subscribe_channel: false,
    }));
  }, []);

  useEffect(() => {
    if (!open) return;
    void ai.getAutoApprovals().then(setFlags).catch(() => {});
  }, [open]);

  const toggle = async (key: keyof AutoApprovalFlags) => {
    if (!flags) return;
    const next = { ...flags, [key]: !flags[key] };
    setFlags(next);
    try {
      await ai.setAutoApprovals(next);
    } catch (err) {
      toast.error(isAiError(err) ? err.message : String(err));
      setFlags(flags);
    }
  };

  const grantedCount = flags
    ? PERMISSIONS.reduce((n, p) => n + (flags[p.key] ? 1 : 0), 0)
    : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="icon"
            className="h-7 w-7 relative"
            title="AI permissions — auto-approve tool calls"
            aria-label="AI permissions"
          >
            <Shield className="w-3.5 h-3.5" />
            {grantedCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[8px] leading-[14px] text-center font-medium">
                {grantedCount}
              </span>
            )}
          </Button>
        )}
      />
      <PopoverContent align="end" className="w-80 p-3 max-h-[70vh] overflow-auto">
        <div className="text-xs font-medium mb-1">AI permissions</div>
        <div className="text-[10.5px] text-muted-foreground mb-3">
          Checked tools run without prompting. Resets when the app restarts.
        </div>
        {PERMISSION_GROUPS.map(group => (
          <div key={group.label} className="mb-3 last:mb-0">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
              {group.label}
            </div>
            <div className="flex flex-col gap-2">
              {group.permissions.map(p => (
                <label
                  key={p.key}
                  className="flex items-start gap-2 text-xs cursor-pointer"
                >
                  <Checkbox
                    checked={flags?.[p.key] ?? false}
                    onCheckedChange={() => void toggle(p.key)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{p.label}</div>
                    <div className="text-[10.5px] text-muted-foreground leading-snug">
                      {p.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface Permission {
  key: keyof AutoApprovalFlags;
  label: string;
  description: string;
}

const PERMISSION_GROUPS: Array<{ label: string; permissions: Permission[] }> = [
  {
    label: 'Read',
    permissions: [
      {
        key: 'read_schema',
        label: 'List schemas / tables',
        description: 'Let the AI list every schema and the tables inside each. Shape only — no rows.',
      },
      {
        key: 'read_structure',
        label: 'Describe table',
        description: 'Let the AI fetch column definitions, indexes, and foreign keys for a specific table.',
      },
    ],
  },
  {
    label: 'Scope',
    permissions: [
      {
        key: 'cross_database',
        label: 'Cross-database access',
        description: 'Off by default — the AI is locked to your active database. It only sees that one database and cannot list, describe, or query others. Turn on to let it reach every database on the connection.',
      },
    ],
  },
  {
    label: 'Run queries',
    permissions: [
      {
        key: 'call_query_read',
        label: 'Read (SELECT)',
        description: 'Run read-only queries — SELECT, SHOW, EXPLAIN. Returns up to 25 rows to the model.',
      },
      {
        key: 'call_query_write',
        label: 'Write (INSERT / UPDATE)',
        description: 'Insert rows and update existing rows (UPDATE must have a WHERE clause).',
      },
      {
        key: 'call_query_create',
        label: 'Create (CREATE / ALTER)',
        description: 'Create or alter tables, indexes, views, columns. Schema-changing DDL.',
      },
      {
        key: 'call_query_delete',
        label: 'Delete (DELETE)',
        description: 'Delete rows (DELETE must have a WHERE clause). DROP / TRUNCATE / no-WHERE deletes always prompt and can never be auto-approved.',
      },
    ],
  },
  {
    label: 'Editor',
    permissions: [
      {
        key: 'write_query_tab',
        label: 'Open / replace query tabs',
        description: 'Let the AI scaffold, refactor, or rewrite queries directly in the editor.',
      },
    ],
  },
  {
    label: 'Realtime',
    permissions: [
      {
        key: 'publish_notify',
        label: 'Publish messages',
        description: 'Let the AI send NOTIFY (Postgres) or PUBLISH (Redis) on your behalf.',
      },
      {
        key: 'subscribe_channel',
        label: 'Start subscriptions',
        description: 'Let the AI prefill and start LISTEN / SUBSCRIBE on the realtime tab.',
      },
    ],
  },
];

const PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap(g => g.permissions);

function openSettings() {
  window.dispatchEvent(new CustomEvent('tablerelay:open-settings'));
}

// Per-message timestamp shown under each chat bubble. Shows just the time for
// messages sent today, and date + time for older ones (so a reloaded history
// conversation reads correctly).
function formatMessageTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// Pretty labels for AI tool calls. Falls back to a generic snake → Title
// conversion for unknown tools so new backends still get a sensible label.
const TOOL_LABELS: Record<string, string> = {
  write_query_tab:   'Write Query Tab',
  call_query:        'Run Query',
  list_schemas:      'List Schemas',
  list_tables:       'List Tables',
  describe_table:    'Describe Table',
  publish_notify:    'Publish Notification',
  subscribe_channel: 'Subscribe Channel',
};
function prettyToolName(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  return name
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function CopyButton({ text, className = '' }: { text: string; className?: string }) {
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

function HighlightedSql({ sql, className }: { sql: string; className?: string }) {
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
 * Switch between saved credential profiles from the chat header. Calls
 * `end()` + `start()` so the active session takes the new credential's
 * provider/key/baseUrl. The model picker still operates within the active
 * credential's provider.
 */
function ActiveCredentialPicker() {
  const [credentials, setCredentials] = useState<CredentialProfile[]>(() => loadCredentials());
  const [activeId, setActiveId]       = useState<string | null>(() => getActiveCredentialId());
  const [switching, setSwitching]     = useState(false);
  const [opened, setOpened]           = useState(false);

  // Refresh on each open so changes from the Settings dialog are picked up
  // without forcing a full chat-panel remount.
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    void hydrateCredentials().then(() => {
      if (cancelled) return;
      setCredentials(loadCredentials());
      setActiveId(getActiveCredentialId());
    });
    return () => { cancelled = true; };
  }, [opened]);

  const swap = async (id: string) => {
    const next = credentials.find(c => c.id === id);
    if (!next || switching || id === activeId) return;
    setSwitching(true);
    try {
      // Await the backend teardown before starting the new session — the slot
      // is single-slot and a racing start() would throw SessionAlreadyActive,
      // leaving the chat unsendable. See end({ awaitBackend }) in state/ai.ts.
      await end({ awaitBackend: true });
      await start({
        kind:    next.kind,
        model:   next.model,
        apiKey:  next.apiKey,
        baseUrl: next.baseUrl,
      });
      setActiveCredentialId(next.id);
      setActiveId(next.id);
      toast.success(`Switched to ${next.name}`);
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  };

  const active = credentials.find(c => c.id === activeId);
  const label  = active ? active.name : '(unsaved)';

  return (
    <Select
      value={activeId ?? ''}
      onValueChange={swap}
      onOpenChange={setOpened}
      disabled={switching}
    >
      <SelectTrigger
        size="sm"
        className="h-7 max-w-32 min-w-0 text-[11px] font-medium text-foreground bg-background border-border hover:bg-muted/40 px-2 rounded-md"
        title="Switch credential — keeps chat open"
      >
        {switching
          ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> switching…</>
          : <SelectValue placeholder={label} className="truncate">{label}</SelectValue>}
      </SelectTrigger>
      <SelectContent>
        {credentials.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">No saved credentials</div>
        )}
        {credentials.map(c => (
          <SelectItem key={c.id} value={c.id} className="text-xs">
            <span className="font-medium">{c.name}</span>
            <span className="text-muted-foreground ml-2">· {c.kind}</span>
          </SelectItem>
        ))}
        <div className="border-t border-border mt-1 pt-1">
          <button
            type="button"
            onClick={openSettings}
            className="w-full text-left px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground rounded flex items-center gap-2"
          >
            <SettingsIcon className="w-3 h-3" /> Manage credentials in Settings…
          </button>
        </div>
      </SelectContent>
    </Select>
  );
}

function ActiveModelPicker({
  providerKind,
  model,
}: {
  providerKind?: AiProviderKind;
  model?: string;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [opened, setOpened] = useState(false);

  // Fetch models on first open only — the list doesn't change between opens
  // and re-fetching on every header click would be chatty. Tap "Refresh" to
  // force it later if we ever add such a button.
  useEffect(() => {
    if (!opened || !providerKind || providerKind === 'llama_local' || models.length > 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const saved = await ai.settingsGet(providerKind);
        const list = await ai.listModels(providerKind, {
          apiKey: saved?.apiKey,
          baseUrl: saved?.baseUrl,
        });
        if (cancelled) return;
        // Promote the current model so it's always the selected row even
        // when the provider's /models endpoint doesn't echo it.
        const withCurrent = model && !list.includes(model) ? [model, ...list] : list;
        setModels(withCurrent);
      } catch (e) {
        if (!cancelled) toast.error(isAiError(e) ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [opened, providerKind, model, models.length]);

  const swap = async (nextModel: string) => {
    if (!providerKind || swapping || nextModel === model) return;
    setSwapping(true);
    try {
      // Pull saved credentials so we can restart with the same auth.
      const saved = await ai.settingsGet(providerKind);
      if (!saved && providerKind !== 'llama_local') {
        toast.error('Saved credentials missing — use Switch/End to pick a provider first.');
        return;
      }
      // Await backend teardown before restart — same single-slot race as the
      // credential picker (see end({ awaitBackend }) in state/ai.ts).
      await end({ awaitBackend: true });
      await start({
        kind: providerKind,
        model: nextModel,
        apiKey: saved?.apiKey,
        baseUrl: saved?.baseUrl,
      });
      toast.success(`Switched to ${nextModel}`);
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setSwapping(false);
    }
  };

  const label = `${providerKind ?? ''} · ${model ?? ''}`;
  if (!providerKind || providerKind === 'llama_local') {
    // Local Llama only has one model per session — swapping means
    // respawning llama-server, which isn't a "mid-chat" operation. Fall
    // back to the plain chip.
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
        {label}
      </span>
    );
  }

  return (
    <Select
      value={model ?? ''}
      onValueChange={swap}
      onOpenChange={setOpened}
      disabled={swapping}
    >
      <SelectTrigger
        size="sm"
        className="h-7 max-w-44 min-w-0 text-[11px] font-mono text-foreground bg-background border-border hover:bg-muted/40 px-2 rounded-md"
        title="Switch model — keeps credentials, clears history"
      >
        {swapping
          ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> switching…</>
          : <SelectValue placeholder={label} className="truncate">{label}</SelectValue>}
      </SelectTrigger>
      <SelectContent>
        {loading && (
          <div className="px-2 py-1 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading models…
          </div>
        )}
        {!loading && models.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            No models found
          </div>
        )}
        {models.map(m => (
          <SelectItem key={m} value={m} className="text-xs font-mono">{m}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StartScreen({ pendingPrefill, prefillTick }: { pendingPrefill: ChatPrefill | null; prefillTick: number }) {
  const s = useAi();
  const starting = s.status === 'starting';

  // Reload credentials when the user returns from Settings. The credential
  // module keeps a decrypted in-memory copy after the app unlocks.
  const [credentials, setCredentials] = useState<CredentialProfile[]>(() => loadCredentials());
  const reload = () => {
    void hydrateCredentials().then(() => setCredentials(loadCredentials()));
  };
  useEffect(() => {
    reload();
    window.addEventListener('focus', reload);
    window.addEventListener('tablerelay:credentials-changed', reload);
    return () => {
      window.removeEventListener('focus', reload);
      window.removeEventListener('tablerelay:credentials-changed', reload);
    };
  }, []);

  const handlePick = async (cred: CredentialProfile) => {
    try {
      await start({
        kind:    cred.kind,
        model:   cred.model,
        apiKey:  cred.apiKey,
        baseUrl: cred.baseUrl,
      });
      setActiveCredentialId(cred.id);
      toast.success(`${cred.name} activated`);
    } catch (e) {
      if (isAiError(e) && e.kind === 'SessionAlreadyActive') {
        try {
          await end();
          await start({
            kind:    cred.kind,
            model:   cred.model,
            apiKey:  cred.apiKey,
            baseUrl: cred.baseUrl,
          });
          setActiveCredentialId(cred.id);
          return;
        } catch (e2) {
          toast.error(isAiError(e2) ? e2.message : String(e2));
          return;
        }
      }
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  // Banner when a Fix / Explain / Generate was triggered without an active
  // session — tells the user to pick a credential so the queued action can fire.
  const queued = pendingPrefill;
  void prefillTick;
  const queuedLabel = queued
    ? queued.kind === 'fix' ? 'Fix Query'
      : queued.kind === 'explain' ? 'Explain Query'
      : queued.kind === 'generate' ? 'Generate Query'
      : null
    : null;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
      <div className="text-center text-muted-foreground text-xs">
        <Sparkles className="w-8 h-8 opacity-50 mx-auto mb-2" />
        <p className="font-medium text-sm text-foreground">Start an AI chat</p>
        <p className="mt-1 opacity-80">
          {credentials.length > 0
            ? 'Pick a credential to begin.'
            : 'Add a provider credential in Settings to get started.'}
        </p>
      </div>

      {queuedLabel && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-primary/30 bg-primary/10 text-primary text-xs">
          <Sparkles className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="wrap-break-word">
            <strong>{queuedLabel}</strong> will run once you start a chat.
          </span>
        </div>
      )}

      {credentials.length === 0 ? (
        <Button onClick={openSettings} className="w-full">
          <SettingsIcon className="w-4 h-4 mr-2" /> Open Settings
        </Button>
      ) : (
        <div className="space-y-1.5">
          {credentials.map(cred => (
            <button
              key={cred.id}
              onClick={() => void handlePick(cred)}
              disabled={starting}
              className="w-full text-left rounded-lg border border-border hover:border-primary/50 hover:bg-muted/40 transition-colors px-3 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate flex-1">{cred.name}</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
                  {cred.kind}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground truncate mt-0.5 font-mono">
                {cred.model}
                {cred.baseUrl && ` · ${cred.baseUrl}`}
              </p>
            </button>
          ))}
          <button
            onClick={openSettings}
            className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-2 flex items-center justify-center gap-1.5"
          >
            <SettingsIcon className="w-3 h-3" /> Manage credentials in Settings
          </button>
        </div>
      )}

      {s.lastError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="wrap-break-word">{s.lastError}</span>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground text-center opacity-70">
        Session-scoped · no chat history persists across restarts
      </p>

      {starting && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Starting session…
        </div>
      )}
    </div>
  );
}

function ActiveSession({
  focusedConnectionId,
  focusedSchema,
  focusedLabel,
  focus,
  pendingPrefillRef,
  prefillTick,
}: {
  focusedConnectionId?: string;
  focusedSchema?: string;
  focusedLabel?: string;
  focus?: ChatFocus;
  pendingPrefillRef: React.MutableRefObject<ChatPrefill | null>;
  prefillTick: number;
}) {
  const s = useAi();
  const chat = currentChat(s);
  const messages = chat.messages;
  const [draft, setDraft] = useState('');
  const streaming = !!chat.pendingRequestId;
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // When the user arrives via a `focusOnly` prefill (e.g. Generate from an
  // empty editor) we remember the kind so the next Send uses it.
  const [stickyKind, setStickyKind] = useState<ChatPrefill['kind'] | null>(null);
  // Outgoing message queue. The textarea stays editable while a turn is in
  // flight; pressing Send mid-stream enqueues the text and it fires
  // automatically once the current turn finishes. FIFO.
  const [queue, setQueue] = useState<Array<{ text: string; kind?: ChatPrefill['kind'] | null }>>([]);

  // Auto-scroll to bottom as messages stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, messages.map(m => m.content).join('|').length]);

  // Drain any pending prefill now that the session is active. Two paths:
  //   - `focusOnly`: drop the text into the textarea + focus it, wait for Send.
  //   - otherwise: auto-send with the provided kind/sql/error.
  useEffect(() => {
    const prefill = pendingPrefillRef.current;
    if (!prefill) return;
    if (streaming) return;
    pendingPrefillRef.current = null;
    if (prefill.focusOnly) {
      setDraft(prefill.text ?? '');
      setStickyKind(prefill.kind && prefill.kind !== 'chat' ? prefill.kind : null);
      // Next tick — textarea needs to be mounted.
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }
    void sendMessage(prefill.text ?? prefill.sql ?? '', {
      connectionId: focusedConnectionId,
      schema: focusedSchema,
      focus,
      kind: prefill.kind,
      sql: prefill.sql,
      errorMessage: prefill.errorMessage,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillTick, streaming]);

  const handleSend = async () => {
    const outgoing = draft;
    if (!outgoing.trim()) return;
    const kind = stickyKind ?? null;

    // Clear the textarea immediately on send so it feels instant — don't wait
    // on the async round-trip. We hold the text in `outgoing` and restore it
    // only if the send is rejected.
    setDraft('');
    setStickyKind(null);

    // If a turn is already in flight, queue this one. The drain effect fires
    // it the moment the current turn finishes.
    if (streaming) {
      setQueue(q => [...q, { text: outgoing, kind }]);
      return;
    }

    const accepted = await sendMessage(outgoing, {
      connectionId: focusedConnectionId,
      schema: focusedSchema,
      focus,
      kind: kind ?? undefined,
    });
    if (!accepted) {
      // Rejected (no active session) — restore the text + kind so the user
      // doesn't lose it, and tell them why.
      setDraft(outgoing);
      setStickyKind(kind);
      toast.error('No active AI session — pick a credential to start a chat.');
    }
  };

  // Drain the queue: when a turn finishes (streaming → false) and there's a
  // queued message, send the next one. One at a time, FIFO.
  useEffect(() => {
    if (streaming) return;
    if (queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void sendMessage(next.text, {
      connectionId: focusedConnectionId,
      schema: focusedSchema,
      focus,
      kind: next.kind ?? undefined,
    }).then(accepted => {
      if (!accepted) {
        toast.error('Queued message could not be sent — no active AI session.');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, queue]);

  return (
    <>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-xs gap-2 px-4 text-center">
            <Sparkles className="w-6 h-6 opacity-50" />
            <p className="font-medium text-sm text-foreground">Ask anything</p>
            <p className="opacity-80">
              {focusedConnectionId && focusedSchema ? (
                <>
                  The model will auto-see the schema of{' '}
                  <span className="font-mono text-foreground">{focusedLabel ?? focusedSchema}</span>{' '}
                  on the first turn.
                </>
              ) : (
                <>Open a database tile to give the model schema awareness.</>
              )}
            </p>
          </div>
        ) : (
          messages.map(m =>
            m.role === 'tool' ? (
              <ToolBubble key={m.id} message={m} />
            ) : (
              <AssistantOrUserBubble key={m.id} message={m} />
            )
          )
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2 bg-muted/5">
        <div className="rounded-2xl border border-border bg-background focus-within:border-primary/40 transition-colors overflow-hidden">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              streaming
                ? 'Type to queue your next message…'
                : stickyKind === 'generate'
                  ? 'Describe the query you want…'
                  : 'Ask anything about your database…'
            }
            rows={2}
            // Always editable — even mid-stream. Sending while a turn is in
            // flight queues the message rather than blocking the input.
            className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            {/* Focus chip — the context that goes out with the next turn.
                Lives on the input bar like claude-code's chat.log chip so
                the user can see what's attached at a glance. */}
            {focusedLabel && (
              <span
                className="text-[10px] text-muted-foreground bg-muted/60 border border-border px-1.5 py-0.5 rounded truncate font-mono max-w-40"
                title={`Schema context: ${focusedLabel}${focus ? ` · focus: ${focusLabel(focus)}` : ''}`}
              >
                {focus ? focusLabel(focus) : focusedLabel}
              </span>
            )}
            <div className="flex-1" />
            {stickyKind && stickyKind !== 'chat' && (
              <span className="text-[10px] text-primary uppercase tracking-wide pr-1">
                {stickyKind}
              </span>
            )}
            {/* Queue count chip — shows how many messages are waiting to send. */}
            {queue.length > 0 && (
              <span
                className="text-[10px] text-primary bg-primary/10 border border-primary/30 px-1.5 py-0.5 rounded-full"
                title={`${queue.length} message${queue.length === 1 ? '' : 's'} queued`}
              >
                {queue.length} queued
              </span>
            )}
            {/* Stop button — only while a turn is streaming. */}
            {streaming && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-full bg-destructive/10 text-destructive hover:bg-destructive/20"
                onClick={() => void stopStreaming()}
                title="Stop current turn"
                aria-label="Stop"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </Button>
            )}
            {/* Send / queue button — always available when there's text. While
                streaming it enqueues; otherwise it sends immediately. */}
            <Button
              variant="default"
              size="icon"
              className="h-7 w-7 rounded-full shrink-0"
              onClick={() => void handleSend()}
              disabled={!draft.trim()}
              title={streaming ? 'Queue message' : 'Send (Enter)'}
              aria-label={streaming ? 'Queue message' : 'Send'}
            >
              {streaming ? <Plus className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5 px-1 text-center opacity-70">
          {streaming ? 'Enter to queue · Shift+Enter for newline' : 'Enter to send · Shift+Enter for newline'}
        </p>
      </div>
    </>
  );
}

function focusLabel(focus: ChatFocus): string {
  switch (focus.type) {
    case 'query':   return 'query buffer';
    case 'routine': return `${focus.kind} ${focus.schema}.${focus.name}`;
    case 'table':   return `${focus.schema}.${focus.name}`;
    case 'realtime':
      return focus.pattern
        ? `realtime: ${focus.pattern}`
        : 'realtime';
  }
}

// -----------------------------------------------------------------------------
// Local Llama — model catalog with download / delete controls.
// -----------------------------------------------------------------------------

interface DownloadProgress {
  downloaded: number;
  total: number;
  speedBps: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtRate(bps: number): string {
  if (bps <= 0) return '—';
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function LocalModelPanel({
  selectedId,
  onPick,
}: {
  selectedId: string;
  onPick: (id: string) => void;
}) {
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [runtime, setRuntime] = useState<LlamaRuntimeStatus | null>(null);
  const [checkingRuntime, setCheckingRuntime] = useState(false);

  const refreshRuntime = async () => {
    setCheckingRuntime(true);
    try {
      setRuntime(await ai.checkLlamaServer());
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setCheckingRuntime(false);
    }
  };

  const refresh = async () => {
    try {
      const list = await ai.listLocalModels();
      setModels(list);
      // If nothing is selected yet, auto-pick the first downloaded entry so
      // Start Chat enables the moment the user has something usable.
      if (!selectedId) {
        const first = list.find(m => m.downloaded);
        if (first) onPick(first.id);
      }
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    void refreshRuntime();
    let cancelProg: (() => void) | undefined;
    let cancelDone: (() => void) | undefined;
    void (async () => {
      cancelProg = await ai.onDownloadProgress(ev => {
        setProgress(p => ({
          ...p,
          [ev.modelId]: { downloaded: ev.downloaded, total: ev.total, speedBps: ev.speedBps },
        }));
      });
      cancelDone = await ai.onDownloadDone((ev: DownloadDoneEvent) => {
        setInFlight(prev => {
          const next = new Set(prev);
          next.delete(ev.modelId);
          return next;
        });
        setProgress(p => {
          const copy = { ...p };
          delete copy[ev.modelId];
          return copy;
        });
        if (ev.status === 'error') {
          toast.error(`Download failed: ${ev.message ?? 'unknown error'}`);
        }
        void refresh();
      });
    })();
    return () => {
      cancelProg?.();
      cancelDone?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDownload = async (id: string) => {
    setInFlight(prev => new Set(prev).add(id));
    try {
      await ai.downloadModel(id);
    } catch (e) {
      if (isAiError(e) && e.kind === 'Canceled') {
        // Cancel path — already handled by onDownloadDone, nothing to surface.
        return;
      }
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await ai.cancelDownload(id);
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  const handleDelete = async (id: string) => {
    const ok = window.confirm('Delete this model? The weights will be removed from disk.');
    if (!ok) return;
    try {
      await ai.deleteModel(id);
      if (selectedId === id) onPick('');
      await refresh();
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading catalog…
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Local models</label>
        <span className="text-[10px] text-muted-foreground opacity-70">
          Stored in <span className="font-mono">ai-models/</span>
        </span>
      </div>

      <LlamaRuntimeCard runtime={runtime} checking={checkingRuntime} onRecheck={refreshRuntime} />

      {models.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No models in catalog.</p>
      )}

      <RadioGroup
        // Selection model: the RadioGroup drives `onPick` and the card
        // click target also calls `onPick` — both converge on the same
        // state setter so either path works for the user.
        value={selectedId ?? ''}
        onValueChange={(v) => { if (typeof v === 'string') onPick(v); }}
        className="contents"
      >
      {models.map(m => {
        const prog = progress[m.id];
        const downloading = inFlight.has(m.id) || !!prog;
        const pct = prog && prog.total > 0
          ? Math.min(100, Math.round((prog.downloaded / prog.total) * 100))
          : (m.downloaded ? 100 : 0);
        const isSelected = selectedId === m.id;
        const canSelect = m.downloaded && !downloading;

        return (
          <div
            key={m.id}
            className={`rounded-md border px-2.5 py-2 transition-colors ${
              isSelected ? 'border-primary bg-primary/5' : 'border-border'
            } ${canSelect ? 'cursor-pointer hover:bg-muted/20' : ''}`}
            onClick={() => { if (canSelect) onPick(m.id); }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value={m.id} disabled={!canSelect} />
                  <span className="text-xs font-medium truncate">{m.display}</span>
                  {!m.hashPinned && (
                    <span
                      className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 shrink-0"
                      title="Catalog entry has no pinned sha256 — install proceeds and the computed hash is logged. Paste it back into models_catalog.rs to pin."
                    >
                      Unverified
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {fmtBytes(m.sizeBytes)} · {m.minRamGb}GB+ RAM recommended
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {downloading ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void handleCancel(m.id); }}
                    className="p-1 text-muted-foreground hover:text-destructive"
                    title="Cancel download"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                  </button>
                ) : m.downloaded ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(m.id); }}
                    className="p-1 text-muted-foreground hover:text-destructive"
                    title="Delete model"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void handleDownload(m.id); }}
                    className="flex items-center gap-1 text-[11px] text-foreground bg-muted/50 hover:bg-muted px-2 py-1 rounded"
                    title="Download model"
                  >
                    <DownloadIcon className="w-3 h-3" />
                    {m.hasPartial ? 'Resume' : 'Download'}
                  </button>
                )}
              </div>
            </div>

            {(downloading || m.hasPartial) && (
              <div className="mt-1.5">
                <div className="h-1 w-full bg-muted/40 rounded overflow-hidden">
                  <div
                    className="h-full bg-primary transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center justify-between">
                  <span>
                    {fmtBytes(prog?.downloaded ?? m.partialBytes)} / {fmtBytes(prog?.total ?? m.sizeBytes)}
                    {' '}({pct}%)
                  </span>
                  {prog && <span>{fmtRate(prog.speedBps)}</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
      </RadioGroup>

      <p className="text-[10px] text-muted-foreground opacity-70">
        Pick a downloaded model, then Start chat. Weights stay on disk after End chat.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Runtime install card. Shown inside LocalModelPanel: green banner when
// llama-server is detected, yellow install-instructions card when missing.
// Keeps the install action outside the app process — we open the provider's
// install path rather than run privileged commands ourselves.
// -----------------------------------------------------------------------------

function LlamaRuntimeCard({
  runtime,
  checking,
  onRecheck,
}: {
  runtime: LlamaRuntimeStatus | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  if (!runtime) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/20 text-[11px] text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        Checking llama-server…
      </div>
    );
  }

  if (runtime.installed) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-green-500/30 bg-green-500/10 text-[11px]">
        <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400 shrink-0" />
        <span className="font-medium text-green-700 dark:text-green-300">llama-server detected</span>
        {runtime.path && (
          <span className="text-muted-foreground font-mono truncate opacity-80" title={runtime.path}>
            · {runtime.path}
          </span>
        )}
      </div>
    );
  }

  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText(runtime.installCommand);
      toast.success('Install command copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const openReleases = () => {
    window.open('https://github.com/ggerganov/llama.cpp/releases', '_blank');
  };

  const platformLabel =
    runtime.platform === 'macos' ? 'macOS' :
    runtime.platform === 'linux' ? 'Linux' :
    runtime.platform === 'windows' ? 'Windows' : 'your system';

  return (
    <div className="space-y-2 px-3 py-2.5 rounded-md border border-yellow-500/30 bg-yellow-500/10">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-yellow-700 dark:text-yellow-300">
            llama-server not installed
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            To run local models on {platformLabel}, install the <span className="font-mono">llama.cpp</span> CLI. It's open-source and free.
          </p>
        </div>
      </div>

      <div className="relative">
        <pre className="text-[11px] font-mono bg-background/60 border border-border rounded px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap wrap-break-word">
          {runtime.installCommand}
        </pre>
        <button
          type="button"
          onClick={copyInstall}
          className="absolute top-1 right-1 p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground"
          title="Copy"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onRecheck}
          disabled={checking}
        >
          {checking ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1.5" />}
          {checking ? 'Checking…' : 'Re-check'}
        </Button>
        <button
          type="button"
          onClick={openReleases}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="w-3 h-3" />
          Manual download
        </button>
      </div>
    </div>
  );
}


// -----------------------------------------------------------------------------
// Tool-call bubble: compact card showing "model called X(args) → result". For
// `call_sql`, shows an inline Approve/Deny before the tool runs.
// -----------------------------------------------------------------------------

/**
 * User and assistant chat bubbles. Assistant replies are rendered as
 * sanitized markdown (tables, fenced code, lists, links) once the stream
 * finishes — during streaming we keep the content as plain text so
 * half-rendered tables don't flash broken HTML.
 */
function AssistantOrUserBubble({ message: m }: { message: StoreChatMessage }) {
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

function ToolBubble({ message }: { message: StoreChatMessage }) {
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

function extractErrorString(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const err = r.error;
  if (typeof err === 'string' && err.length > 0) return err;
  return null;
}

function ApprovalCard({
  toolCallId,
  sql,
  summary,
  toolName,
  mode,
  title,
  tier,
}: {
  toolCallId: string;
  sql?: string;
  summary?: string;
  toolName?: string;
  mode?: 'new' | 'replace';
  title?: string;
  tier?: QueryTier;
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
  const isRead = toolName === 'list_schemas' || toolName === 'list_tables' || toolName === 'describe_table';
  let prompt: string;
  let approveLabel: string;
  if (isTabWrite) {
    prompt = mode === 'replace'
      ? `Model wants to replace the current query tab with this query${title ? ` (title: ${title})` : ''}:`
      : `Model wants to open a new query tab with this query${title ? ` (title: ${title})` : ''}:`;
    approveLabel = mode === 'replace' ? 'Approve & replace' : 'Approve & open';
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `… (${s.length - n} more chars)`;
}
