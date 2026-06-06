import { useSyncExternalStore } from 'react';
import { ai, isAiError, type AiProviderKind, type ChatFocus, type ChatKind, type Conversation, type StartInput, type QueryTier } from '../lib/ai';
import { loadSettings } from '../lib/settings-store';
import { loadCredentials, setActiveCredentialId } from '../lib/ai-credentials';

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
}

interface AiState {
  status: SessionStatus;
  providerKind?: AiProviderKind;
  model?: string;
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
let wired = false;
async function ensureWired() {
  if (wired) return;
  wired = true;
  await ai.onChunk(ev => {
    mutate(s => {
      const conn = findConnectionByMessageId(s, ev.requestId);
      if (!conn) return s;
      const chat = chatOf(s, conn);
      const idx = chat.messages.findIndex(m => m.id === ev.requestId);
      if (idx < 0) return s;
      const next = [...chat.messages];
      next[idx] = { ...next[idx], content: next[idx].content + ev.delta };
      return setChat(s, conn, { ...chat, messages: next });
    });
  });
  await ai.onDone(ev => {
    mutate(s => {
      const conn = findConnectionByMessageId(s, ev.requestId);
      if (!conn) return s;
      const chat = chatOf(s, conn);
      const idx = chat.messages.findIndex(m => m.id === ev.requestId);
      if (idx < 0) return setChat(s, conn, { ...chat, pendingRequestId: undefined });
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
  });
  // --- Tool-use events (M8.4 Stage 2) ---
  // When a tool call starts, insert a placeholder "tool" bubble right
  // before the streaming assistant reply so the user sees the tool call
  // in context.
  await ai.onToolCallStarted(ev => {
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
  });
  await ai.onToolCallFinished(ev => {
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
  });
  await ai.onApprovalRequest(ev => {
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
  });
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

export async function start(input: StartInput) {
  await ensureWired();
  mutate(s => ({ ...s, status: 'starting', lastError: undefined }));
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
      providerKind: status.providerKind,
      model: status.model,
    }));
  } catch (e) {
    mutate(s => ({ ...s, status: 'inactive', lastError: errMsg(e) }));
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
    messages,
  }));
}

/** List saved conversations. */
export async function listConversations(limit?: number) {
  return ai.conversationList(limit);
}

/** Delete a saved conversation. */
export async function deleteConversation(id: string) {
  return ai.conversationDelete(id);
}

export async function end(opts?: { awaitBackend?: boolean }) {
  // Reset UI state immediately so the StartScreen appears without waiting
  // on backend teardown. The backend unload is fire-and-forget: local llama
  // can take a few seconds to kill the subprocess, and hosted-provider
  // cleanup is near-instant but still async. Either way the user has
  // already said "end this" — they shouldn't have to stare at a spinner.
  mutate(() => ({ status: 'inactive', byConnection: {} }));
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
      if (status.active) {
        mutate(s => ({ ...s, status: 'active', providerKind: status.providerKind, model: status.model }));
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }
  const trimmed = content.trim();
  if (!trimmed) return false;
  // Route the turn into the connection bucket the user is interacting
  // with. Fall back to GLOBAL when none is set yet.
  const connKey = context?.connectionId ?? state.focusedConnectionId ?? GLOBAL_KEY;
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
  if (!convId) {
    convId = crypto.randomUUID();
    try {
      await ai.conversationCreate(convId, {
        connectionId: context?.connectionId,
        providerKind: state.providerKind,
        model: state.model,
      });
      // Auto-name from first user message
      const title = trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
      void ai.conversationUpdateTitle(convId, title);
    } catch { /* non-fatal */ }
  }

  mutate(s => {
    const chat = chatOf(s, connKey);
    return setChat(s, connKey, {
      ...chat,
      conversationId: convId,
      pendingRequestId: requestId,
      messages: [
        ...chat.messages,
        { id: userId, role: 'user', content: displayed, createdAt: Date.now() },
        { id: requestId, role: 'assistant', content: '', streaming: true, createdAt: Date.now() },
      ],
    });
  });

  // Save user message to persistent storage
  if (convId) {
    void ai.conversationSaveMessage(convId, userId, 'user', trimmed, {
      kind: context?.kind,
    }).catch(() => {});
  }

  try {
    // Pass the user's per-turn tool-iteration cap + repeat-call guard through
    // to the backend loop.
    await ai.chatSend(requestId, trimmed, {
      ...context,
      maxIterations: loadSettings().aiMaxToolIterations,
      maxRepeatCalls: loadSettings().aiMaxRepeatCalls,
    });
  } catch (e) {
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
