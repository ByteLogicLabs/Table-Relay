import { useEffect, useRef, useState } from 'react';
import { X, Sparkles, Square, Loader2, AlertCircle, Plus, ArrowUp } from 'lucide-react';
import { ConversationHistory } from './conversation-history';
import { Button } from '../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { useAi, start, end, sendMessage, stopStreaming, syncStatus, newChat, setFocusedConnection, currentChat, type ChatPrefill } from '../../state/ai';
import { ai, isAiError, type AiProviderKind, type ChatFocus } from '../../lib/ai';
import {
  type CredentialProfile,
  getActiveCredentialId,
  hydrateCredentials,
  loadCredentials,
  setActiveCredentialId,
} from '../../lib/ai-credentials';
import { Settings as SettingsIcon } from 'lucide-react';
import { toast } from 'sonner';
import { openSettings, focusLabel } from './chat-utils';
import { PermissionsButton } from './chat-permissions';
import { AssistantOrUserBubble, ToolBubble } from './chat-bubbles';

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
