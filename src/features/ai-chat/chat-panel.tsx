import { useEffect, useRef, useState } from 'react';
import { X, Sparkles, Square, Loader2, AlertCircle, Plus, ArrowUp, Terminal, RefreshCw } from 'lucide-react';
import { ConversationHistory } from './conversation-history';
import { Button } from '../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { SearchableSelect } from '../../components/ui/searchable-select';
import { useAi, start, end, sendMessage, stopStreaming, syncStatus, newChat, setFocusedConnection, currentChat, restoreBackendTranscript, type ChatPrefill } from '../../state/ai';
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
import { openSettings, focusLabel, PROVIDERS } from './chat-utils';
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
      <div className="h-10 shrink-0 border-b border-border flex items-center justify-between px-3 bg-muted/10">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          {/* Hide the static "AI Chat" label once a session is active — the
              credential + model pickers need the horizontal room, and without
              this they overflowed under the right-side action buttons. */}
          {!showActive && <span className="text-sm font-medium truncate">AI Chat</span>}
          {showActive && <ActiveCredentialPicker sessionKind={s.providerKind} />}
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
                className="h-7 text-[10px] uppercase tracking-wide text-destructive hover:text-destructive hover:bg-destructive/10"
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
// `cli:<kind>` ids tag the detected-CLI entries so the unified picker can tell
// them apart from saved-credential ids (plain profile ids) on selection.
const CLI_OPTION_PREFIX = 'cli:';

// Small colored dot per provider so the picker reads at a glance.
function providerDot(kind?: AiProviderKind): string {
  switch (kind) {
    case 'openai':            return 'bg-emerald-500';
    case 'anthropic':
    case 'claude_cli':        return 'bg-orange-500';
    case 'gemini':
    case 'gemini_cli':        return 'bg-blue-500';
    case 'openai_compatible': return 'bg-purple-500';
    case 'codex_cli':         return 'bg-slate-400';
    case 'opencode':          return 'bg-amber-500';
    case 'llama_local':       return 'bg-rose-500';
    default:                  return 'bg-muted-foreground/50';
  }
}

function ActiveCredentialPicker({ sessionKind }: { sessionKind?: AiProviderKind }) {
  const [credentials, setCredentials] = useState<CredentialProfile[]>(() => loadCredentials());
  const [activeId, setActiveId]       = useState<string | null>(() => getActiveCredentialId());
  const [switching, setSwitching]     = useState(false);
  const [opened, setOpened]           = useState(false);

  // Detected machine CLIs (claude / codex / gemini / opencode). These are
  // switchable targets alongside saved API credentials. `null` = probing.
  const cliProviders = PROVIDERS.filter(p => p.requiresLocalCli);
  const [cliPaths, setCliPaths] = useState<Record<string, string | null> | null>(null);
  const [reloading, setReloading] = useState(false);

  // Re-probe both saved credentials and machine CLIs. Runs on mount, each time
  // the dropdown opens, and via the manual reload button — so Settings changes
  // and newly-installed CLIs are picked up.
  const refresh = async () => {
    setReloading(true);
    try {
      await hydrateCredentials();
      setCredentials(loadCredentials());
      setActiveId(getActiveCredentialId());
      const entries = await Promise.all(
        cliProviders.map(async p => [p.kind, await ai.cliAvailable(p.kind).catch(() => null)] as const),
      );
      setCliPaths(Object.fromEntries(entries));
    } finally {
      setReloading(false);
    }
  };

  // Probe on first render + whenever the menu opens, so Settings changes and
  // newly-installed CLIs are picked up without remounting the panel.
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (!opened) return;
    void refresh();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [opened]);

  const detectedClis = cliProviders.filter(p => cliPaths?.[p.kind]);

  const swapCredential = async (next: CredentialProfile) => {
    // keepTranscript: don't blank the visible chat on switch; re-seed backend.
    await end({ awaitBackend: true, keepTranscript: true });
    await start({ kind: next.kind, model: next.model, apiKey: next.apiKey, baseUrl: next.baseUrl });
    await restoreBackendTranscript();
    setActiveCredentialId(next.id);
    setActiveId(next.id);
    toast.success(`Switched to ${next.name}`);
  };

  const swapCli = async (kind: AiProviderKind) => {
    const meta = PROVIDERS.find(p => p.kind === kind);
    await end({ awaitBackend: true, keepTranscript: true });
    await start({ kind, model: meta?.defaultModel ?? '' });
    await restoreBackendTranscript();
    // CLI sessions have no saved profile — clear the credential id so the chip
    // labels the CLI provider, not a stale credential.
    setActiveCredentialId(null);
    setActiveId(null);
    toast.success(`Switched to ${meta?.label ?? kind}`);
  };

  // Single onValueChange handler: `cli:<kind>` → start that CLI; otherwise
  // treat the value as a saved-credential id.
  const swap = async (value: string) => {
    if (switching) return;
    setSwitching(true);
    try {
      // The slot is single-slot; await teardown before start() so a racing
      // start can't throw SessionAlreadyActive. (Each swap helper ends first.)
      if (value.startsWith(CLI_OPTION_PREFIX)) {
        const kind = value.slice(CLI_OPTION_PREFIX.length) as AiProviderKind;
        if (sessionKind === kind && !activeId) return; // already on this CLI
        await swapCli(kind);
      } else {
        const next = credentials.find(c => c.id === value);
        if (!next || value === activeId) return;
        await swapCredential(next);
      }
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  };

  const active = credentials.find(c => c.id === activeId);
  // The live session can diverge from the saved-credential selection — most
  // notably when a CLI provider is started (from here or from the StartScreen),
  // which sets no active credential id. When the active credential's kind
  // doesn't match the running session, fall back to the session provider's own
  // friendly label so the chip reflects what's actually answering.
  const sessionMatchesActive = active && (!sessionKind || active.kind === sessionKind);
  const sessionLabel = sessionKind
    ? (PROVIDERS.find(p => p.kind === sessionKind)?.label ?? sessionKind)
    : '(unsaved)';
  const label = sessionMatchesActive ? active!.name : sessionLabel;
  // The <Select> value: a credential id when it matches the session, else the
  // `cli:<kind>` id when the running session is a CLI, else nothing selected.
  const sessionIsCli = sessionKind ? cliProviders.some(p => p.kind === sessionKind) : false;
  const selectValue = sessionMatchesActive
    ? (activeId ?? '')
    : (sessionIsCli ? `${CLI_OPTION_PREFIX}${sessionKind}` : '');

  return (
    <div className="flex items-center gap-0.5 min-w-0">
    <Select
      value={selectValue}
      onValueChange={swap}
      onOpenChange={setOpened}
      disabled={switching}
    >
      <SelectTrigger
        size="sm"
        className="h-7 max-w-44 min-w-0 gap-1.5 text-[11px] font-medium text-foreground bg-background border-border hover:bg-muted/40 px-2 rounded-md"
        title="Switch provider — saved credentials or installed CLI tools; keeps chat open"
      >
        {switching
          ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> switching…</>
          : (
            <span className="flex items-center gap-1.5 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${providerDot(sessionKind)}`} />
              <span className="truncate">{label}</span>
            </span>
          )}
      </SelectTrigger>
      <SelectContent className="min-w-56">
        {credentials.length > 0 && (
          <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            Saved credentials
          </div>
        )}
        {credentials.map(c => (
          <SelectItem key={c.id} value={c.id} className="text-xs py-1.5">
            <span className="flex items-center gap-2 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${providerDot(c.kind)}`} />
              <span className="font-medium truncate">{c.name}</span>
              <span className="text-muted-foreground text-[10px] shrink-0">{c.kind}</span>
            </span>
          </SelectItem>
        ))}
        {detectedClis.length > 0 && (
          <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 border-t border-border/60 mt-1 flex items-center gap-1">
            <Terminal className="w-2.5 h-2.5" /> Installed CLI tools
          </div>
        )}
        {detectedClis.map(p => (
          <SelectItem key={p.kind} value={`${CLI_OPTION_PREFIX}${p.kind}`} className="text-xs py-1.5">
            <span className="flex items-center gap-2 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${providerDot(p.kind)}`} />
              <span className="font-medium truncate">{p.label}</span>
              <span className="text-emerald-600 dark:text-emerald-400 text-[10px] shrink-0">● ready</span>
            </span>
          </SelectItem>
        ))}
        {credentials.length === 0 && detectedClis.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {cliPaths === null ? 'Checking…' : 'No providers found'}
          </div>
        )}
        <div className="border-t border-border/60 mt-1 pt-1 flex items-center gap-1">
          <button
            type="button"
            onClick={() => openSettings('ai')}
            className="flex-1 text-left px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground rounded flex items-center gap-2"
          >
            <SettingsIcon className="w-3 h-3" /> Manage API providers in Settings…
          </button>
          <button
            type="button"
            // Stop the Select from closing/selecting; just re-probe in place.
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void refresh(); }}
            disabled={reloading}
            title="Reload credentials and installed CLI tools"
            aria-label="Reload providers"
            className="shrink-0 p-1.5 rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${reloading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </SelectContent>
    </Select>
    </div>
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

  // CLI providers (claude/codex/gemini/opencode) authenticate via the installed
  // binary, not a stored API key — so they have no saved credentials and must
  // be allowed to switch models without one.
  const isCli = providerKind ? PROVIDERS.find(p => p.kind === providerKind)?.requiresLocalCli ?? false : false;

  const swap = async (nextModel: string) => {
    if (!providerKind || swapping || nextModel === model) return;
    setSwapping(true);
    try {
      // Pull saved credentials so we can restart with the same auth. CLI
      // providers don't need any — they auth through the binary.
      const saved = await ai.settingsGet(providerKind);
      if (!saved && !isCli && providerKind !== 'llama_local') {
        toast.error('Saved credentials missing — use Switch/End to pick a provider first.');
        return;
      }
      // Await backend teardown before restart — same single-slot race as the
      // credential picker. keepTranscript so the visible chat doesn't vanish on
      // a model switch; we re-seed the backend session with it below.
      await end({ awaitBackend: true, keepTranscript: true });
      await start({
        kind: providerKind,
        model: nextModel,
        apiKey: saved?.apiKey,
        baseUrl: saved?.baseUrl,
      });
      await restoreBackendTranscript();
      toast.success(`Switched to ${nextModel}`);
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setSwapping(false);
    }
  };

  // Don't render a dangling "provider · " when no model is set (e.g. opencode
  // started without an explicit model — it uses its own configured default).
  const label = model ? `${providerKind ?? ''} · ${model}` : `${providerKind ?? ''} · (default)`;
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

  // Some CLIs (notably opencode) expose hundreds of `provider/model` ids — a
  // plain dropdown is unusable there. Lazy-load on mount for the searchable
  // variant (it has no open-driven fetch hook) and render a filterable picker
  // when the list is large.
  const useSearch = isCli;
  if (useSearch) {
    return (
      <CliModelSearchPicker
        providerKind={providerKind}
        model={model}
        onPick={swap}
        swapping={swapping}
      />
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

/**
 * Searchable model picker for CLI providers. opencode alone lists hundreds of
 * `provider/model` ids, so a filter box is essential. Fetches the catalog on
 * mount (the underlying SearchableSelect has no open-driven fetch hook).
 */
function CliModelSearchPicker({
  providerKind,
  model,
  onPick,
  swapping,
}: {
  providerKind: AiProviderKind;
  model?: string;
  onPick: (m: string) => void;
  swapping: boolean;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await ai.listModels(providerKind, {});
        if (cancelled) return;
        const withCurrent = model && !list.includes(model) ? [model, ...list] : list;
        setModels(withCurrent);
      } catch {
        if (!cancelled && model) setModels([model]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [providerKind, model]);

  const options = models.map(m => ({ value: m, label: m }));
  // When no model is set, the CLI uses its own configured default — say so
  // rather than showing a blank trigger (the opencode "no active model" case).
  const placeholder = loading
    ? 'Loading models…'
    : (model || `${providerKind} default — pick to change`);

  return (
    <SearchableSelect
      value={model ?? ''}
      options={options}
      onChange={onPick}
      disabled={swapping || loading}
      placeholder={placeholder}
      searchPlaceholder="Search or type a model id…"
      className="h-7 max-w-44 text-[11px] font-mono"
      allowCustom
    />
  );
}

function StartScreen({ pendingPrefill, prefillTick }: { pendingPrefill: ChatPrefill | null; prefillTick: number }) {
  const s = useAi();
  const starting = s.status === 'starting';

  // Reload credentials when the user returns from Settings. The credential
  // module keeps a decrypted in-memory copy after the app unlocks.
  const [credentials, setCredentials] = useState<CredentialProfile[]>(() => loadCredentials());
  const [reloading, setReloading] = useState(false);
  const reload = () => {
    void hydrateCredentials().then(() => setCredentials(loadCredentials()));
  };
  // Re-probe EVERYTHING (credentials + CLIs + llama) for the manual reload
  // button, so a just-installed CLI / downloaded model / added key appears
  // without restarting the app.
  const reloadAll = async () => {
    setReloading(true);
    try {
      await hydrateCredentials();
      setCredentials(loadCredentials());
      const entries = await Promise.all(
        cliProviders.map(async p => [p.kind, await ai.cliAvailable(p.kind).catch(() => null)] as const),
      );
      setCliPaths(Object.fromEntries(entries));
      const status = await ai.checkLlamaServer().catch(() => null);
      setLlamaReady(!!status?.installed);
      if (status?.installed) {
        const models = await ai.listLocalModels().catch(() => []);
        setLlamaModel(models.find(m => m.downloaded)?.id ?? null);
      }
    } finally {
      setReloading(false);
    }
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

  // Detect installed CLI tools so the user can start them in one click without
  // first adding a credential in Settings. `null` = checking; map of kind→path.
  const cliProviders = PROVIDERS.filter(p => p.requiresLocalCli);
  const [cliPaths, setCliPaths] = useState<Record<string, string | null> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      cliProviders.map(async p => [p.kind, await ai.cliAvailable(p.kind).catch(() => null)] as const),
    ).then(entries => {
      if (!cancelled) setCliPaths(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const detectedClis = cliProviders.filter(p => cliPaths?.[p.kind]);

  // Detect a local llama.cpp install (the `llama-server` binary) + any
  // downloaded GGUF model, so on-device Llama can be started in one click like
  // the CLIs. `llamaReady`: binary found. `llamaModel`: first downloaded model id
  // (null = installed but no model yet → point the user at Settings to download).
  const [llamaReady, setLlamaReady] = useState(false);
  const [llamaModel, setLlamaModel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await ai.checkLlamaServer();
        if (cancelled) return;
        setLlamaReady(status.installed);
        if (status.installed) {
          const models = await ai.listLocalModels().catch(() => []);
          if (cancelled) return;
          const dl = models.find(m => m.downloaded);
          setLlamaModel(dl?.id ?? null);
        }
      } catch { /* leave llamaReady false */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleStartLlama = async () => {
    if (!llamaModel) {
      // Binary present but no model — open Settings → AI where downloads live.
      toast.info('Download a GGUF model in Settings → AI to use on-device Llama.');
      openSettings('ai');
      return;
    }
    try {
      await end({ awaitBackend: true }).catch(() => {});
      await start({ kind: 'llama_local', model: llamaModel });
      setActiveCredentialId(null);
      toast.success('Local Llama session started');
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  const handleStartCli = async (kind: AiProviderKind, model?: string) => {
    try {
      await end({ awaitBackend: true }).catch(() => {});
      await start({ kind, model: model ?? '' });
      // A CLI session has no saved-credential profile; clear any previously
      // selected credential id so the header chip labels the running CLI
      // provider instead of the stale last-used credential ("B Deepseek").
      setActiveCredentialId(null);
      toast.success('CLI session started');
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

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
        <p className="mt-1 opacity-80 leading-relaxed max-w-xs mx-auto">
          Chat with your database — runs on Claude Code, Codex, Gemini, opencode,
          a local model, or your API key.
        </p>
        <p className="mt-1.5 opacity-70 max-w-xs mx-auto">
          {credentials.length > 0 || detectedClis.length > 0 || llamaReady
            ? 'Pick a provider to begin.'
            : 'Add one in Settings, or install a CLI to see it here.'}
        </p>
      </div>

      {/* Installed runtimes detected on this machine — start in one click, no key. */}
      {(detectedClis.length > 0 || llamaReady) && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1">
            <Terminal className="w-3 h-3" /> Detected on this machine
          </div>
          {detectedClis.map(p => (
            <button
              key={p.kind}
              onClick={() => void handleStartCli(p.kind, p.defaultModel)}
              disabled={starting}
              title={cliPaths?.[p.kind] ?? undefined}
              className="w-full text-left rounded-lg border border-border hover:border-primary/50 hover:bg-muted/40 transition-colors px-3 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-sm font-medium truncate flex-1">{p.label}</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
                  installed
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                {p.defaultModel ? `${p.sublabel} · ${p.defaultModel}` : p.sublabel}
              </p>
            </button>
          ))}
          {llamaReady && (
            <button
              onClick={() => void handleStartLlama()}
              disabled={starting}
              title="llama-server detected"
              className="w-full text-left rounded-lg border border-border hover:border-primary/50 hover:bg-muted/40 transition-colors px-3 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                <span className="text-sm font-medium truncate flex-1">Local Llama</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
                  llamaModel
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                }`}>
                  {llamaModel ? 'installed' : 'needs model'}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                {llamaModel ? `GGUF · on-device · ${llamaModel}` : 'llama.cpp ready — download a model in Settings'}
              </p>
            </button>
          )}
        </div>
      )}

      {queuedLabel && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-primary/30 bg-primary/10 text-primary text-xs">
          <Sparkles className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="wrap-break-word">
            <strong>{queuedLabel}</strong> will run once you start a chat.
          </span>
        </div>
      )}

      {credentials.length === 0 && detectedClis.length === 0 && !llamaReady ? (
        <Button onClick={() => openSettings('ai')} className="w-full">
          <SettingsIcon className="w-4 h-4 mr-2" /> Open Settings
        </Button>
      ) : credentials.length === 0 ? (
        // Only local runtimes detected — offer Settings as a secondary action.
        <button
          onClick={() => openSettings('ai')}
          className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-2 flex items-center justify-center gap-1.5"
        >
          <SettingsIcon className="w-3 h-3" /> Add an API provider in Settings
        </button>
      ) : (
        <div className="space-y-1.5">
          {credentials.length > 0 && (
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1">
              Saved credentials
            </div>
          )}
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
          <div className="pt-2 flex items-center justify-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
            <span>Don't see your provider?</span>
            <button
              onClick={() => void reloadAll()}
              disabled={reloading}
              className="text-primary hover:underline disabled:opacity-50 inline-flex items-center gap-1"
            >
              <RefreshCw className={`w-3 h-3 ${reloading ? 'animate-spin' : ''}`} />
              {reloading ? 'Reloading…' : 'Reload'}
            </button>
            <span>or</span>
            <button
              onClick={() => openSettings('ai')}
              className="text-primary hover:underline"
            >
              manage in Settings
            </button>
          </div>
        </div>
      )}

      {s.lastError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="wrap-break-word">{s.lastError}</span>
        </div>
      )}

      {starting && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Starting session…
        </div>
      )}

      {/* Auto-detect hint — only when nothing was detected yet, so the user
          knows installed CLI tools show up here on their own (no setup). */}
      {cliPaths !== null && detectedClis.length === 0 && !llamaReady && (
        <p className="mt-auto pt-3 text-[11px] text-muted-foreground/70 text-center leading-relaxed">
          <Terminal className="w-3 h-3 inline mr-1 -mt-0.5" />
          Install a coding CLI like <span className="font-medium">Claude Code</span>,{' '}
          <span className="font-medium">Codex</span>, <span className="font-medium">Gemini</span>, or{' '}
          <span className="font-medium">opencode</span> and it'll appear here automatically — no API key needed.
        </p>
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
