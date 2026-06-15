import { useSyncExternalStore } from 'react';
import { ai, isAiError, isCliProviderKind, type AiProviderKind, type ChatFocus, type ChatKind, type Conversation, type StartInput, type QueryTier } from '../lib/ai';
import { loadSettings, EFFORT_PRESETS } from '../lib/settings-store';
import { recentQueryLog } from './query-log-store';

/** Format the connection's recent query log into a compact text block for the
 *  AI, so it can see what ran (and what FAILED) and offer fixes / retries.
 *  Newest last; statements truncated; errors carry their message. Returns
 *  undefined when there's nothing worth sending. */
function recentQueryLogForAi(connectionId: string): string | undefined {
  const entries = recentQueryLog(connectionId, 8);
  if (entries.length === 0) return undefined;
  const lines = entries.map((e) => {
    const sql = e.statement.replace(/\s+/g, ' ').trim();
    const clipped = sql.length > 300 ? sql.slice(0, 300) + '…' : sql;
    if (e.status === 'error') {
      const msg = (e.message ?? 'unknown error').replace(/\s+/g, ' ').trim();
      return `- [ERROR] ${clipped}\n    → ${msg}`;
    }
    const ms = e.durationMs != null ? ` (${Math.round(e.durationMs)}ms)` : '';
    return `- [ok${ms}] ${clipped}`;
  });
  return lines.join('\n');
}
import { loadCredentials, setActiveCredentialId } from '../lib/ai-credentials';
import { flog } from '../lib/flog';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Epoch millis when the message was created. Shown under each bubble and
   *  preserved when a conversation is reloaded from history. */
  createdAt?: number;
  /** When true, tokens are still streaming into `content`. */
  streaming?: boolean;
  /** Populated on the final chunk. */
  finishReason?: 'stop' | 'length' | 'canceled' | 'error';
  /** For `role: 'tool'` messages — the name + arguments of the tool the model
   *  asked to run, plus its eventual result string (JSON). */
  tool?: {
    name: string;
    arguments: string;
    result?: string;
    /** Present while waiting on user decision. Shape differs per tool:
     *  call_query carries `sql` only; write_query_tab adds `mode` + `title`;
     *  read-only tools (list_schemas / describe_table) carry `summary`
     *  instead of `sql`. */
    pendingApproval?: {
      sql?: string;
      summary?: string;
      toolName?: string;
      mode?: 'new' | 'replace';
      title?: string;
      /** Operation tier for `call_query` approvals — drives the card's
       *  tier badge. Undefined for non-query tools. */
      tier?: QueryTier;
      /** For `open_object_tab` approvals: which editor + the target name. */
      object?: 'trigger' | 'table';
      objectName?: string | null;
    };
    approved?: boolean;
    denied?: boolean;
  };
}

export type SessionStatus = 'inactive' | 'starting' | 'active' | 'ending';

/** Per-connection chat state. Transcripts live here so switching rail
 *  tiles preserves each conversation independently. Provider / model
 *  are shared across connections (one API key, one model at a time). */
export interface ConnectionChat {
  messages: ChatMessage[];
  pendingRequestId?: string;
  lastError?: string;
  /** Persistent conversation id — set when the first message is saved. */
  conversationId?: string;
  /** Display title for the header. Auto-derived from the first message, or set
   *  by the user via inline rename. Mirrors the persisted conversation title. */
  conversationTitle?: string;
  /** True once the user has renamed the conversation by hand, so auto-titling
   *  never overwrites their choice. */
  titleManual?: boolean;
}

interface AiState {
  status: SessionStatus;
  /** True while a model/provider swap is mid-flight (end → start). The session
   *  briefly goes `inactive` during teardown; this flag lets the panel keep the
   *  active chat view rendered instead of flickering to the StartScreen. */
  swapping?: boolean;
  providerKind?: AiProviderKind;
  model?: string;
  /** Provider being started, set while `status === 'starting'` so the loading
   *  screen can tailor its message (e.g. local Llama spawns a server and is
   *  slow). Cleared once active/inactive. */
  startingKind?: AiProviderKind;
  /** Most recent top-level (non-chat) error string — e.g. start-up
   *  failure. Per-connection errors live on the entry in `byConnection`. */
  lastError?: string;
  /** Messages / pending request / errors bucketed by connection id. A
   *  sentinel key (`GLOBAL_KEY`) holds chats that happen before any
   *  connection is picked — usually empty in practice. */
  byConnection: Record<string, ConnectionChat>;
  /** Connection id the panel is currently looking at. Drives the view
   *  and also decides where tool approvals land when the panel shows
   *  no bubble for a given message (fallback). */
  focusedConnectionId?: string;
}

/** Fallback key for chats that happen without a focused connection —
 *  e.g. someone opens the panel before picking a DB. We still want a
 *  bucket so the messages don't vanish when they eventually pick one. */
const GLOBAL_KEY = '__global__';

function emptyChat(): ConnectionChat {
  return { messages: [], pendingRequestId: undefined, lastError: undefined };
}

let state: AiState = {
  status: 'inactive',
  byConnection: {},
};

type Listener = () => void;
const listeners = new Set<Listener>();
function emit() { for (const l of listeners) l(); }
function subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }
function getSnapshot() { return state; }

function mutate(fn: (s: AiState) => AiState) {
  state = fn(state);
  emit();
}

// --- Stuck-turn watchdog ---------------------------------------------------
// A turn that never receives its `done` event (a dropped Tauri event, a CLI
// subprocess that wedged, callbacks orphaned by a reload) leaves
// `pendingRequestId` set forever. Because the input treats a pending request as
// "streaming", EVERY later message silently queues and nothing sends — the chat
// looks dead until a full reload. This watchdog is the safety net: while a turn
// is pending we keep a timer that, if no chunk/done arrives for a long but
// bounded window, finalises the message as errored and clears the pending flag
// so the panel un-wedges on its own. Each chunk pushes the deadline out, so a
// legitimately slow stream never trips it.
// Idle window before a turn with ZERO activity (no chunk, no tool call, not
// waiting on approval) is assumed wedged. Bumped on every chunk AND every
// tool call now, so a long multi-step turn (create tables, seed data) keeps
// resetting it — only a genuinely dead turn (dropped event, wedged subprocess)
// trips it. 5 min gives slow providers + big tool batches ample headroom.
const WATCHDOG_IDLE_MS = 300_000;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogKey: string | null = null;
let watchdogRid: string | null = null;

function disarmWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  watchdogKey = null;
  watchdogRid = null;
}

/** (Re)arm the watchdog for a pending turn. Called when a send starts and
 *  bumped on every chunk so active streams stay alive. */
function armWatchdog(key: string, rid: string) {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogKey = key;
  watchdogRid = rid;
  watchdogTimer = setTimeout(() => onWatchdogFire(key, rid), WATCHDOG_IDLE_MS);
}

/** Bump the watchdog deadline for the active turn (on chunk / tool activity).
 *  Re-arms even from a disarmed state (e.g. after an approval pause) as long as
 *  `rid` is still the pending turn for some connection bucket — so resuming
 *  work after a long approval wait restores the safety net. */
function bumpWatchdog(rid: string) {
  if (watchdogRid === rid && watchdogKey) {
    armWatchdog(watchdogKey, rid);
    return;
  }
  // Disarmed (or tracking a different turn) — find the bucket whose pending
  // turn is `rid` and (re)arm for it.
  for (const [key, chat] of Object.entries(state.byConnection)) {
    if (chat.pendingRequestId === rid) {
      armWatchdog(key, rid);
      return;
    }
  }
}

function onWatchdogFire(key: string, rid: string) {
  watchdogTimer = null;
  const chat = state.byConnection[key];
  // Only act if this exact turn is still the pending one — otherwise it already
  // completed/cancelled and the timer is stale.
  if (!chat || chat.pendingRequestId !== rid) return;
  flog('watchdog', 'FIRED stuck turn rid=', rid, 'bucket=', key, '— clearing pending');
  mutate(s => {
    const c = chatOf(s, key);
    if (c.pendingRequestId !== rid) return s;
    const idx = c.messages.findIndex(m => m.id === rid);
    const next = idx >= 0 ? [...c.messages] : c.messages;
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        streaming: false,
        finishReason: 'error',
        content: next[idx].content
          || '(no response — the request stalled and was cleared. Try again.)',
      };
    }
    return setChat(s, key, { ...c, messages: next, pendingRequestId: undefined });
  });
  // Best-effort backend cancel so a wedged CLI subprocess gets killed.
  void ai.chatStop(rid).catch(() => {});
  disarmWatchdog();
}

/** Read helper so components don't have to duplicate the null coalesce. */
function chatOf(s: AiState, connId: string): ConnectionChat {
  return s.byConnection[connId] ?? emptyChat();
}

function setChat(s: AiState, connId: string, next: ConnectionChat): AiState {
  return { ...s, byConnection: { ...s.byConnection, [connId]: next } };
}

/** Find which connection bucket a given message id lives in. Used by
 *  streaming / tool event handlers that only know the request id. */
function findConnectionByMessageId(s: AiState, msgId: string): string | null {
  for (const [conn, chat] of Object.entries(s.byConnection)) {
    if (chat.messages.some(m => m.id === msgId)) return conn;
  }
  return null;
}

/** Returns the active connection's chat. Used by the panel — the
 *  selector is stable because we subscribe to the full state and
 *  React will re-render when the entry changes. */
export function useAi() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Convenience selector for the focused connection's chat. Falls back
 *  to the global bucket when no connection is focused. */
export function currentChat(s: AiState): ConnectionChat {
  const key = s.focusedConnectionId ?? GLOBAL_KEY;
  return s.byConnection[key] ?? emptyChat();
}

/** Tell the state which connection the UI is looking at. Drives the
 *  panel view and makes new chats land in that bucket. Call from
 *  ChatPanel on mount + whenever `focusedConnectionId` changes. */
export function setFocusedConnection(connId: string | undefined) {
  mutate(s => {
    if (s.focusedConnectionId === connId) return s;
    // Pre-allocate the bucket so the UI sees an empty array instead
    // of reaching through `currentChat`'s fallback (keeps the panel's
    // state selector referentially stable across renders).
    const key = connId ?? GLOBAL_KEY;
    const withBucket = s.byConnection[key]
      ? s
      : { ...s, byConnection: { ...s.byConnection, [key]: emptyChat() } };
    return { ...withBucket, focusedConnectionId: connId };
  });
}

// Lazy-init the event listeners the first time any action runs. We can't do
// this at module load because `@tauri-apps/api/event` expects the Tauri
// runtime to be ready, and the module is imported during SSR-less dev boot
// but that's still before the setup step.
// Cache the registration PROMISE, not a boolean. Concurrent callers (e.g.
// ChatPanel's mount `syncStatus()` racing the user's first `sendMessage()`)
// must all await the SAME completion — a boolean flag flipped before the async
// `ai.onChunk(...)` listeners finish registering let the second caller run
// `chatSend` before the listeners existed, so its chunk/done events were
// dropped and the chat stayed blank. Awaiting one shared promise fixes that.
let wiredPromise: Promise<void> | null = null;
// Unlisten handles for every Tauri event listener we register, so a Vite HMR
// dispose can tear them down. Without this, each hot-reload of this module left
// the previous listeners alive — bound to STALE `mutate`/`state` closures — so
// chunk/done events updated an orphaned store and the visible chat never moved
// (exactly the "replies don't append" symptom during dev iteration).
let unlisteners: import('@tauri-apps/api/event').UnlistenFn[] = [];

// Survive HMR: if a previous module instance already wired listeners, tear them
// down before this instance wires its own. Without this, hot-reload leaves TWO
// listener sets registered — the log showed each chunk/done firing twice, with
// the stale set mutating an orphaned `state` ("DROPPED no-bucket" despite the
// bucket existing). A no-op in production (the window key is unset on cold load).
interface WiredGlobal { __aiUnlisten?: Array<() => void> }
function disposePriorWiring() {
  const g = window as unknown as WiredGlobal;
  if (g.__aiUnlisten) {
    for (const off of g.__aiUnlisten) { try { off(); } catch { /* ignore */ } }
  }
  g.__aiUnlisten = unlisteners;
}

function ensureWired(): Promise<void> {
  if (!wiredPromise) {
    wiredPromise = wireListeners().catch(e => {
      // Reset on failure so a later call can retry rather than be stuck on a
      // rejected promise forever.
      wiredPromise = null;
      throw e;
    });
  }
  return wiredPromise;
}

async function wireListeners() {
  // Kill any listeners a prior module instance (HMR) left registered, then
  // publish this instance's unlisten array globally so the NEXT instance can do
  // the same. Guarantees exactly one live listener set bound to the current
  // module's `mutate`/`state`.
  disposePriorWiring();
  unlisteners.push(await ai.onChunk(ev => {
    bumpWatchdog(ev.requestId); // activity → push the stuck-turn deadline out
    mutate(s => {
      const conn = findConnectionByMessageId(s, ev.requestId);
      if (!conn) { flog('chunk', 'DROPPED no-bucket rid=', ev.requestId, 'buckets=', Object.keys(s.byConnection)); return s; }
      const chat = chatOf(s, conn);
      const idx = chat.messages.findIndex(m => m.id === ev.requestId);
      if (idx < 0) { flog('chunk', 'DROPPED no-msg rid=', ev.requestId, 'conn=', conn); return s; }
      const next = [...chat.messages];
      next[idx] = { ...next[idx], content: next[idx].content + ev.delta };
      return setChat(s, conn, { ...chat, messages: next });
    });
  }));
  unlisteners.push(await ai.onDone(ev => {
    flog('done', 'rid=', ev.requestId, 'finish=', ev.finishReason, 'len=', (ev.content ?? '').length);
    if (watchdogRid === ev.requestId) disarmWatchdog(); // turn completed cleanly
    mutate(s => {
      const conn = findConnectionByMessageId(s, ev.requestId);
      if (!conn) { flog('done', 'DROPPED no-bucket rid=', ev.requestId, 'buckets=', Object.keys(s.byConnection)); return s; }
      const chat = chatOf(s, conn);
      const idx = chat.messages.findIndex(m => m.id === ev.requestId);
      if (idx < 0) { flog('done', 'no-msg rid=', ev.requestId, 'conn=', conn); return setChat(s, conn, { ...chat, pendingRequestId: undefined }); }
      const next = [...chat.messages];
      next[idx] = {
        ...next[idx],
        streaming: false,
        finishReason: ev.finishReason,
        // Backend sends the canonical full text in `content`; use it to
        // reconcile if any chunk events got dropped.
        content: ev.content || next[idx].content,
      };
      // Save assistant message to persistent storage
      if (chat.conversationId && ev.content) {
        void ai.conversationSaveMessage(
          chat.conversationId, ev.requestId, 'assistant', ev.content,
        ).catch(() => {});
      }
      return setChat(s, conn, { ...chat, messages: next, pendingRequestId: undefined });
    });
  }));
  // --- Tool-use events (M8.4 Stage 2) ---
  // When a tool call starts, insert a placeholder "tool" bubble right
  // before the streaming assistant reply so the user sees the tool call
  // in context.
  unlisteners.push(await ai.onToolCallStarted(ev => {
    // Tool activity = the turn is alive. A tool-heavy turn (create tables,
    // insert rows, describe) streams NO text chunks for minutes, so without
    // this the stuck-turn watchdog would fire mid-work and "clear" a healthy
    // turn ("no response — stalled"). Push the deadline out on every tool.
    bumpWatchdog(ev.requestId);
    mutate(s => {
      // The tool call fires during the assistant reply — look up the
      // owning connection via the reply's id.
      const conn = findConnectionByMessageId(s, ev.requestId);
      if (!conn) return s;
      const chat = chatOf(s, conn);
      // Skip if we already rendered this call — tool_call_started fires
      // once per tool, but React strict mode could double-subscribe.
      if (chat.messages.some(m => m.id === ev.toolCallId)) return s;
      const replyIdx = chat.messages.findIndex(m => m.id === ev.requestId);
      const insertBefore = replyIdx < 0 ? chat.messages.length : replyIdx;
      const toolBubble: ChatMessage = {
        id: ev.toolCallId,
        role: 'tool',
        content: '',
        createdAt: Date.now(),
        tool: { name: ev.name, arguments: ev.arguments },
      };
      const next = [...chat.messages];
      next.splice(insertBefore, 0, toolBubble);
      return setChat(s, conn, { ...chat, messages: next });
    });
  }));
  unlisteners.push(await ai.onToolCallFinished(ev => {
    bumpWatchdog(ev.requestId); // tool result arrived → turn is still alive
    // Capture across the mutate boundary so we can persist after state updates.
    let convId: string | undefined;
    let toolSnapshot: { name: string; arguments: string; result?: string; denied?: boolean } | undefined;
    mutate(s => {
      const conn = findConnectionByMessageId(s, ev.toolCallId);
      if (!conn) return s;
      const chat = chatOf(s, conn);
      const idx = chat.messages.findIndex(m => m.id === ev.toolCallId);
      if (idx < 0) return s;
      const next = [...chat.messages];
      const prev = next[idx];
      next[idx] = {
        ...prev,
        tool: {
          ...(prev.tool ?? { name: '?', arguments: '' }),
          result: ev.result,
          pendingApproval: undefined,
        },
      };
      convId = chat.conversationId;
      toolSnapshot = {
        name:      prev.tool?.name ?? '?',
        arguments: prev.tool?.arguments ?? '',
        result:    ev.result,
        denied:    prev.tool?.denied,
      };
      return setChat(s, conn, { ...chat, messages: next });
    });
    // Persist the tool bubble so it survives reloads / conversation switches.
    if (convId && toolSnapshot) {
      void ai.conversationSaveMessage(
        convId,
        ev.toolCallId,
        'tool',
        '',
        {
          toolCallsJson: JSON.stringify(toolSnapshot),
          toolCallId:    ev.toolCallId,
        },
      ).catch(() => {});
    }
  }));
  unlisteners.push(await ai.onApprovalRequest(ev => {
    // A pending approval blocks on the USER, who may take far longer than the
    // idle window. Disarm the watchdog so it doesn't "clear" a turn that's
    // simply waiting for a click. It re-arms when the tool resolves
    // (onToolCallFinished bumps) or the next chunk arrives.
    disarmWatchdog();
    mutate(s => {
      const conn = findConnectionByMessageId(s, ev.toolCallId);
      if (!conn) return s;
      const chat = chatOf(s, conn);
      const idx = chat.messages.findIndex(m => m.id === ev.toolCallId);
      if (idx < 0) return s;
      const next = [...chat.messages];
      const prev = next[idx];
      next[idx] = {
        ...prev,
        tool: {
          ...(prev.tool ?? { name: ev.name, arguments: '' }),
          pendingApproval: {
            sql: ev.sql,
            summary: ev.summary,
            toolName: ev.name,
            mode: ev.mode,
            title: ev.title,
            tier: ev.tier,
            object: ev.object,
            objectName: ev.objectName,
          },
        },
      };
      return setChat(s, conn, { ...chat, messages: next });
    });
  }));
  // Reconcile with backend state on first wire. If the Rust side has a live
  // session from a previous hot-reload (dev iteration) we show "active" so
  // the user doesn't hit SessionAlreadyActive on their next Start.
  try {
    const status = await ai.status();
    if (status.active) {
      mutate(s => ({
        ...s,
        status: 'active',
        providerKind: status.providerKind,
        model: status.model,
      }));
    }
  } catch { /* no-op */ }
}

// Vite HMR: when this module is hot-replaced, tear down the listeners the old
// instance registered. Otherwise stale listeners (bound to the previous
// module's `mutate`/`state`) keep firing into an orphaned store and the visible
// chat stops updating — which reads as "replies don't append" during dev. No
// effect in production (import.meta.hot is undefined there).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const off of unlisteners) {
      try { off(); } catch { /* ignore */ }
    }
    unlisteners = [];
    wiredPromise = null;
    disarmWatchdog();
  });
}

function errMsg(e: unknown): string {
  if (isAiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function kindLabel(kind: ChatKind, sql: string | undefined, fallback: string): string {
  const snippet = (sql ?? fallback).replace(/\s+/g, ' ').trim();
  const short = snippet.length > 200 ? snippet.slice(0, 200) + '…' : snippet;
  switch (kind) {
    case 'fix':      return `Fix this Query:\n${short}`;
    case 'explain':  return `Explain this Query:\n${short}`;
    case 'generate': return fallback;
    default:         return fallback;
  }
}

export async function syncStatus() {
  await ensureWired();
}

/** Mark a swap (model/provider) in progress so the panel keeps the active view
 *  rendered across the brief `inactive` window between `end()` and `start()`. */
export function setSwapping(v: boolean) {
  mutate(s => ({ ...s, swapping: v }));
}

export async function start(input: StartInput) {
  await ensureWired();
  mutate(s => ({ ...s, status: 'starting', startingKind: input.kind, lastError: undefined }));
  try {
    let status;
    try {
      status = await ai.start(input);
    } catch (e) {
      // Single-slot session race: a prior session is still installed (e.g. an
      // end() teardown that hadn't finished, or a stale session that survived
      // a reload). Tear it down — awaited this time — and retry once so a
      // credential/model swap can't get wedged into an unstartable state.
      if (isAiError(e) && e.kind === 'SessionAlreadyActive') {
        await ai.end().catch(() => {});
        status = await ai.start(input);
      } else {
        throw e;
      }
    }
    mutate(s => ({
      ...s,
      status: 'active',
      startingKind: undefined,
      providerKind: status.providerKind,
      model: status.model,
    }));
    // If the focused connection already has an open conversation, re-bind it to
    // the (possibly new) provider/model so resuming it later continues with what
    // the user is actually using now — not the model it was created with. No-op
    // for a fresh session (no conversation yet) or a resume (same value).
    const convId =
      state.byConnection[state.focusedConnectionId ?? GLOBAL_KEY]?.conversationId;
    if (convId) {
      void ai
        .conversationSetModel(convId, status.providerKind, status.model)
        .catch(() => {});
    }
  } catch (e) {
    mutate(s => ({ ...s, status: 'inactive', startingKind: undefined, lastError: errMsg(e) }));
    throw e;
  }
}

/**
 * Reset the chat transcript for the focused connection without ending the
 * session. The frontend flips its bucket to an empty state immediately;
 * the backend's `ai_new_chat` clears its `session.messages` + context
 * fingerprint so the next turn starts fresh. API key, model, and
 * llama-server process all survive.
 *
 * Note: the backend session is currently single-slot, so resetting one
 * connection's chat here *also* resets the backend transcript. Other
 * connections' frontend buckets keep their messages — they'll resync a
 * fresh context on the next `sendMessage` (the backend fingerprints on
 * connection+schema+focus, so switching tabs re-injects context anyway).
 */
export function newChat() {
  mutate(s => {
    const key = s.focusedConnectionId ?? GLOBAL_KEY;
    return setChat(s, key, emptyChat());
  });
  ai.newChat().catch(e => {
    if (isAiError(e) && e.kind === 'NoActiveSession') return;
    mutate(s => ({ ...s, lastError: errMsg(e) }));
  });
}

/**
 * Rename the current conversation. Stamps the title in the bucket immediately
 * (so the header updates without a round-trip) and marks it `titleManual` so
 * auto-titling never clobbers it. Persists to the backend when a conversation
 * row exists; an empty title clears the manual flag and falls back to auto.
 */
export function renameConversation(title: string) {
  const trimmed = title.trim();
  mutate(s => {
    const key = s.focusedConnectionId ?? GLOBAL_KEY;
    const chat = chatOf(s, key);
    return setChat(s, key, {
      ...chat,
      conversationTitle: trimmed || undefined,
      titleManual: trimmed.length > 0,
    });
  });
  const key = state.focusedConnectionId ?? GLOBAL_KEY;
  const convId = state.byConnection[key]?.conversationId;
  // No conversation row yet (rename before the first message). The title is held
  // in the bucket and will be applied on create via the titleManual guard.
  if (convId && trimmed) {
    void ai.conversationUpdateTitle(convId, trimmed).catch(() => {});
  }
}

/** Load a saved conversation into the current chat view. */
export async function loadConversation(conversationId: string) {
  const conv = await ai.conversationGet(conversationId);
  if (!conv || !conv.messages) return;

  // If there's no active session (e.g. the user opened history straight from
  // the credential picker), start one before loading — otherwise the messages
  // load into state but `showActive` stays false and the UI is stuck on the
  // picker. Pick the credential that best matches the conversation's saved
  // provider + model, falling back to the first available credential.
  if (state.status !== 'active') {
    // CLI providers (claude/codex/gemini/opencode) have NO saved credential —
    // they authenticate through the installed binary. Start them directly from
    // the conversation's saved provider/model. Without this, opening a saved
    // CLI chat fell through to `creds[0]` and silently started an unrelated API
    // provider (e.g. an opencode chat reopening as OpenAI).
    if (isCliProviderKind(conv.providerKind)) {
      await start({ kind: conv.providerKind, model: conv.model ?? '' });
      setActiveCredentialId(null);
    } else {
      const creds = loadCredentials();
      if (creds.length === 0) {
        throw new Error('Add a provider credential in Settings to open saved chats.');
      }
      const match =
        creds.find(c => c.kind === conv.providerKind && c.model === conv.model) ??
        creds.find(c => c.kind === conv.providerKind) ??
        creds[0];
      await start({
        kind: match.kind,
        model: match.model,
        apiKey: match.apiKey,
        baseUrl: match.baseUrl,
      });
      setActiveCredentialId(match.id);
    }
  }

  // Load into the bucket the user is CURRENTLY viewing, not the one the
  // conversation was originally saved under. `currentChat` renders from
  // `focusedConnectionId ?? GLOBAL_KEY`; if we wrote to the conversation's own
  // connectionId and that differs from the current view, the messages would
  // land in an off-screen bucket and the conversation would appear not to load.
  const connKey = state.focusedConnectionId ?? GLOBAL_KEY;
  const messages: ChatMessage[] = conv.messages
    .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
    .map(m => {
      if (m.role === 'tool') {
        // Rehydrate the tool bubble from the persisted JSON blob. If parsing
        // fails (legacy row, corruption) we still surface the message with
        // an "unknown tool" placeholder rather than dropping it silently.
        let tool: ChatMessage['tool'] | undefined;
        if (m.toolCallsJson) {
          try {
            const parsed = JSON.parse(m.toolCallsJson) as {
              name?: string; arguments?: string; result?: string; denied?: boolean;
            };
            tool = {
              name:      parsed.name      ?? '?',
              arguments: parsed.arguments ?? '',
              result:    parsed.result,
              denied:    parsed.denied,
            };
          } catch { /* fall through to placeholder */ }
        }
        return {
          id:        m.id,
          role:      'tool' as const,
          content:   m.content,
          createdAt: m.createdAt ? Date.parse(m.createdAt) || undefined : undefined,
          streaming: false,
          tool:      tool ?? { name: '?', arguments: '' },
        };
      }
      return {
        id:        m.id,
        role:      m.role as 'user' | 'assistant',
        content:   m.content,
        createdAt: m.createdAt ? Date.parse(m.createdAt) || undefined : undefined,
        streaming: false,
      };
    });
  mutate(s => setChat(s, connKey, {
    ...chatOf(s, connKey),
    conversationId: conv.id,
    conversationTitle: conv.title || undefined,
    // A loaded conversation keeps whatever title it was saved with; treat it as
    // user-owned so a stray empty send can't auto-rename it.
    titleManual: !!conv.title,
    messages,
  }));
  // Pin the view to the bucket we just loaded into, so a follow-up send routes
  // to the SAME bucket. Without this, `sendMessage` later realigned focus to
  // the message's `connectionId` bucket — a DIFFERENT, empty one — and the
  // freshly-loaded transcript vanished from view ("old chats gone"). Loading a
  // conversation IS focusing it.
  if ((state.focusedConnectionId ?? GLOBAL_KEY) !== connKey) {
    setFocusedConnection(connKey === GLOBAL_KEY ? undefined : connKey);
  }

  // Restore the BACKEND session transcript too. Loading only rebuilt the
  // frontend bubbles; without this the backend session.messages stayed empty,
  // so continuing a reopened chat sent the new turn with no prior context —
  // every provider, but most visibly the stateless CLIs ("I don't see a prior
  // attempt in this conversation"). Send the user/assistant text turns; the
  // backend drops tool/system turns itself.
  const restorable = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));
  try {
    await ai.restoreMessages(restorable);
  } catch (e) {
    flog('restore', 'failed', errMsg(e));
  }
}

/** List saved conversations. */
export async function listConversations(limit?: number) {
  return ai.conversationList(limit);
}

/** Delete a saved conversation. */
export async function deleteConversation(id: string) {
  return ai.conversationDelete(id);
}

/** Delete every saved conversation (and its messages). Does not touch the live
 *  in-memory session; the next message just starts a fresh conversation. */
export async function deleteAllConversations() {
  return ai.conversationDeleteAll();
}

export async function end(opts?: { awaitBackend?: boolean; keepTranscript?: boolean }) {
  // Reset UI state immediately so the StartScreen appears without waiting
  // on backend teardown. The backend unload is fire-and-forget: local llama
  // can take a few seconds to kill the subprocess, and hosted-provider
  // cleanup is near-instant but still async. Either way the user has
  // already said "end this" — they shouldn't have to stare at a spinner.
  //
  // `keepTranscript`: used by credential/model SWAP, which calls end()+start()
  // under the hood. A swap must NOT wipe the visible chat — clearing
  // `byConnection` made the transcript vanish and the panel go blank after a
  // model switch. So for swaps we drop to `inactive` but preserve the buckets;
  // start() flips back to `active` and the same transcript is still there. Plain
  // "End" (no opts) still clears everything.
  if (opts?.keepTranscript) {
    mutate(s => ({ ...s, status: 'inactive' }));
  } else {
    mutate(() => ({ status: 'inactive', byConnection: {} }));
  }
  // When swapping credential/model we MUST await the backend teardown before
  // the follow-up start(): the backend session slot is single-slot, so a
  // start() that races ahead of end()'s `guard.take()` hits SessionAlreadyActive
  // and the swap silently fails — leaving the frontend `inactive` while the old
  // backend session lingers, so the next sendMessage no-ops ("can't send,
  // nothing happens"). Plain "End" stays fire-and-forget for snappy UX.
  const teardown = ai.end().catch(e => {
    if (isAiError(e) && e.kind === 'NoActiveSession') return; // expected
    mutate(s => ({ ...s, lastError: errMsg(e) }));
  });
  if (opts?.awaitBackend) await teardown;
}

/**
 * Re-seed the backend session transcript from the currently-visible chat
 * bucket. Used after a credential/model SWAP (end+start leaves the backend
 * session empty) so the model keeps full conversational context even though the
 * UI transcript was preserved on the frontend. No-op if there's nothing to send.
 */
export async function restoreBackendTranscript() {
  const key = state.focusedConnectionId ?? GLOBAL_KEY;
  const msgs = state.byConnection[key]?.messages ?? [];
  const restorable = msgs
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));
  if (restorable.length === 0) return;
  try {
    await ai.restoreMessages(restorable);
  } catch (e) {
    flog('restore', 'swap re-seed failed', errMsg(e));
  }
}

export async function sendMessage(
  content: string,
  context?: {
    connectionId?: string;
    schema?: string;
    focus?: ChatFocus;
    kind?: ChatKind;
    sql?: string;
    errorMessage?: string;
  },
): Promise<boolean> {
  flog('send', 'enter status=', state.status, 'provider=', state.providerKind, 'focused=', state.focusedConnectionId, 'ctxConn=', context?.connectionId);
  // Wire first so status reconciles with a live backend session that
  // survived a page reload — otherwise the very first send after HMR
  // bails on the stale `inactive` default and the user sees nothing.
  await ensureWired();
  // If the local status says inactive, double-check the backend before giving
  // up — `ensureWired` only reconciles once, so a status that drifted out of
  // sync (e.g. after loading a conversation) would otherwise wedge sends. If
  // the backend session is live, adopt it and proceed.
  if (state.status !== 'active') {
    try {
      const status = await ai.status();
      flog('send', 'status-recheck active=', status.active, 'kind=', status.providerKind);
      if (status.active) {
        mutate(s => ({ ...s, status: 'active', providerKind: status.providerKind, model: status.model }));
      } else {
        flog('send', 'ABORT backend inactive — no session');
        return false;
      }
    } catch (e) {
      flog('send', 'ABORT status() threw', errMsg(e));
      return false;
    }
  }
  const trimmed = content.trim();
  if (!trimmed) { flog('send', 'ABORT empty content'); return false; }
  // Route the turn into the connection bucket the user is interacting with.
  // Prefer the FOCUSED bucket when it already holds an in-progress conversation
  // — otherwise a reopened chat (loaded into the focused/global bucket) would be
  // split off when `context.connectionId` pointed at a different, empty bucket,
  // making the visible transcript "disappear" on the next send. Only fall back
  // to the explicit context connection / global when the focus bucket is fresh.
  const focusKey = state.focusedConnectionId ?? GLOBAL_KEY;
  const focusHasActiveChat =
    (state.byConnection[focusKey]?.messages.length ?? 0) > 0 ||
    !!state.byConnection[focusKey]?.conversationId;
  const connKey = focusHasActiveChat
    ? focusKey
    : (context?.connectionId ?? state.focusedConnectionId ?? GLOBAL_KEY);
  // CRITICAL: the panel RENDERS from `state.focusedConnectionId` (via
  // currentChat), but the message is WRITTEN to `connKey`. If those diverge
  // — which happens when ChatPanel's `setFocusedConnection` effect hasn't
  // landed the explicit connectionId yet (race on mount / two instances) —
  // the reply lands in a bucket the panel isn't viewing and the chat looks
  // empty even though events arrived. Force them into agreement here: sending
  // into a connection focuses it. This is the real fix for "no error but
  // nothing appends" (logs showed write bucket=<conn> vs visible=__global__).
  if (state.focusedConnectionId !== connKey && connKey !== GLOBAL_KEY) {
    flog('send', 'aligning focus', state.focusedConnectionId, '→', connKey);
    setFocusedConnection(connKey);
  }
  const userId = crypto.randomUUID();
  // Use one shared id for the user turn + its assistant reply, so chunks
  // route back to the right bubble. The backend receives this as request_id
  // and uses it to emit chunk/done events.
  const requestId = crypto.randomUUID();
  // For shortcut kinds show a short label instead of the raw SQL payload —
  // the preamble built on the backend is verbose and not what the user typed.
  const displayed = context?.kind && context.kind !== 'chat'
    ? kindLabel(context.kind, context.sql, trimmed)
    : trimmed;

  // Auto-create conversation on first message
  let convId = state.byConnection[connKey]?.conversationId;
  let autoTitle: string | undefined;
  if (!convId) {
    convId = crypto.randomUUID();
    try {
      await ai.conversationCreate(convId, {
        connectionId: context?.connectionId,
        providerKind: state.providerKind,
        model: state.model,
      });
      // Title precedence: a manual title typed before the first send wins;
      // otherwise auto-name from the first user message.
      const manualTitle = state.byConnection[connKey]?.titleManual
        ? state.byConnection[connKey]?.conversationTitle?.trim()
        : undefined;
      if (manualTitle) {
        void ai.conversationUpdateTitle(convId, manualTitle);
      } else {
        autoTitle = trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
        void ai.conversationUpdateTitle(convId, autoTitle);
      }
    } catch { /* non-fatal */ }
  }

  flog('send', 'placeholder rid=', requestId, 'bucket=', connKey, 'conv=', convId);
  mutate(s => {
    const chat = chatOf(s, connKey);
    return setChat(s, connKey, {
      ...chat,
      conversationId: convId,
      conversationTitle: chat.conversationTitle ?? autoTitle,
      pendingRequestId: requestId,
      messages: [
        ...chat.messages,
        { id: userId, role: 'user', content: displayed, createdAt: Date.now() },
        { id: requestId, role: 'assistant', content: '', streaming: true, createdAt: Date.now() },
      ],
    });
  });
  flog('send', 'after-mutate visibleBucket=', (state.focusedConnectionId ?? GLOBAL_KEY), 'msgCount=', (state.byConnection[connKey]?.messages.length ?? -1));
  armWatchdog(connKey, requestId); // self-heal if no chunk/done ever arrives

  // Save user message to persistent storage
  if (convId) {
    void ai.conversationSaveMessage(convId, userId, 'user', trimmed, {
      kind: context?.kind,
    }).catch(() => {});
  }

  try {
    // Pass the user's per-turn tool-iteration cap + repeat-call guard through
    // to the backend loop.
    flog('send', 'chatSend → backend rid=', requestId);
    const preset = EFFORT_PRESETS[loadSettings().aiEffort] ?? EFFORT_PRESETS.medium;
    await ai.chatSend(requestId, trimmed, {
      ...context,
      recentQueryLog: context?.connectionId
        ? recentQueryLogForAi(context.connectionId)
        : undefined,
      maxIterations: preset.maxIterations,
      maxRepeatCalls: preset.maxRepeatCalls,
      maxTokens: preset.maxTokens,
      reasoningEffort: preset.reasoningEffort,
    });
    flog('send', 'chatSend resolved rid=', requestId);
  } catch (e) {
    flog('send', 'chatSend THREW rid=', requestId, errMsg(e));
    if (watchdogRid === requestId) disarmWatchdog();
    mutate(s => {
      const chat = chatOf(s, connKey);
      const idx = chat.messages.findIndex(m => m.id === requestId);
      if (idx < 0) {
        return setChat(s, connKey, {
          ...chat,
          pendingRequestId: undefined,
          lastError: errMsg(e),
        });
      }
      const next = [...chat.messages];
      next[idx] = {
        ...next[idx],
        streaming: false,
        finishReason: 'error',
        content: next[idx].content || `(failed: ${errMsg(e)})`,
      };
      return setChat(s, connKey, {
        ...chat,
        messages: next,
        pendingRequestId: undefined,
        lastError: errMsg(e),
      });
    });
  }
  return true;
}

export async function approveToolCall(toolCallId: string, approve: boolean) {
  // Optimistic UI update — mark approved/denied right away so the button
  // group disappears even before the backend round-trips.
  mutate(s => {
    const conn = findConnectionByMessageId(s, toolCallId);
    if (!conn) return s;
    const chat = chatOf(s, conn);
    const idx = chat.messages.findIndex(m => m.id === toolCallId);
    if (idx < 0) return s;
    const next = [...chat.messages];
    const prev = next[idx];
    next[idx] = {
      ...prev,
      tool: {
        ...(prev.tool ?? { name: '?', arguments: '' }),
        pendingApproval: undefined,
        approved: approve ? true : undefined,
        denied: approve ? undefined : true,
      },
    };
    return setChat(s, conn, { ...chat, messages: next });
  });
  try {
    await ai.approveToolCall(toolCallId, approve ? 'approve' : 'deny');
  } catch (e) {
    if (isAiError(e)) {
      mutate(s => ({ ...s, lastError: e.message }));
    }
  }
}

export async function stopStreaming() {
  const key = state.focusedConnectionId ?? GLOBAL_KEY;
  const rid = state.byConnection[key]?.pendingRequestId;
  if (!rid) return;
  if (watchdogRid === rid) disarmWatchdog();
  // Finalise locally first. Otherwise, if the in-flight request was
  // started in a previous page lifecycle (HMR / reload) its callbacks
  // are dead and `done` will never arrive — the UI stays stuck on Stop
  // forever. Clearing here unsticks the panel even when the backend
  // can't deliver the cancel ack.
  mutate(s => {
    const chat = chatOf(s, key);
    if (chat.pendingRequestId !== rid) return s;
    const idx = chat.messages.findIndex(m => m.id === rid);
    const next = idx >= 0 ? [...chat.messages] : chat.messages;
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        streaming: false,
        finishReason: 'canceled',
      };
    }
    return setChat(s, key, { ...chat, messages: next, pendingRequestId: undefined });
  });
  try { await ai.chatStop(rid); } catch { /* best-effort */ }
}

// --- Shortcut entry points (M8.5) ---

/**
 * Shared payload for Fix / Explain / Generate shortcuts fired from the app.
 * `text` is what the user wants generated (for `generate`) or the already-
 * constructed draft (for free-form chat). `sql` carries the existing query
 * for Fix / Explain. `errorMessage` is the failure text for Fix.
 */
export interface ChatPrefill {
  kind: ChatKind;
  text?: string;
  sql?: string;
  errorMessage?: string;
  /** When true, open the chat panel but don't auto-send — used for Generate
   *  so the user can type their request first. */
  focusOnly?: boolean;
}

/**
 * Route a shortcut into the chat panel. The panel opens the drawer (via
 * `tablerelay:toggle-chat` if currently closed), then either auto-sends the
 * prefill immediately (when the session is already active) or stashes it
 * and waits for the user to Start Chat — see the listener in ChatPanel.
 */
export function prefillChat(prefill: ChatPrefill) {
  window.dispatchEvent(new CustomEvent<ChatPrefill>('tablerelay:ai-prefill', { detail: prefill }));
}
