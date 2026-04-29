import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type AiProviderKind =
  | 'echo'
  | 'llama_local'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openai_compatible';

export interface AiStatus {
  active: boolean;
  providerKind?: AiProviderKind;
  model?: string;
  messageCount?: number;
}

export interface StartInput {
  kind: AiProviderKind;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** JSON-serialized preferences blob, round-tripped via ai_settings. */
  optionsJson?: string;
}

/** Persistent per-provider settings saved in store.db. */
export interface AiSettings {
  kind: AiProviderKind;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  optionsJson?: string;
  updatedAt: string;
}

interface AiSettingsRaw {
  kind: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  optionsJson?: string | null;
  updatedAt: string;
}

function normaliseSettings(raw: AiSettingsRaw): AiSettings {
  return {
    kind: raw.kind as AiProviderKind,
    apiKey: raw.apiKey ?? undefined,
    baseUrl: raw.baseUrl ?? undefined,
    model: raw.model ?? undefined,
    optionsJson: raw.optionsJson ?? undefined,
    updatedAt: raw.updatedAt,
  };
}

export interface AiError {
  kind:
    | 'Unauthorized' | 'RateLimit' | 'NetworkTimeout'
    | 'ModelNotLoaded' | 'InvalidModel' | 'ContextTooLong'
    | 'Canceled' | 'NoActiveSession' | 'SessionAlreadyActive'
    | 'Upstream' | 'Other';
  message: string;
}

export function isAiError(x: unknown): x is AiError {
  return !!x
    && typeof x === 'object'
    && 'kind' in (x as object)
    && 'message' in (x as object);
}

export interface ChatChunkEvent {
  requestId: string;
  delta: string;
}

export interface ChatDoneEvent {
  requestId: string;
  content: string;
  finishReason?: 'stop' | 'length' | 'canceled' | 'error';
}

// --- Tool use (M8.4 Stage 2) ---
export interface ToolCallStartedEvent {
  requestId: string;
  toolCallId: string;
  name: string;
  arguments: string;
}

export interface ToolCallFinishedEvent {
  requestId: string;
  toolCallId: string;
  result: string;
}

/** Per-tool auto-approval flags. Matches `AutoApprovalFlags` on the Rust side.
 *  `call_query` is the new name for the legacy `call_sql` tool. */
export interface AutoApprovalFlags {
  /** Allow `list_schemas` + `list_tables` to run without prompting.
   *  Defaults to `true` — these expose shapes only, never rows. */
  read_schema: boolean;
  /** Allow `describe_table` to run without prompting. Defaults to `true`. */
  read_structure: boolean;
  call_query: boolean;
  write_query_tab: boolean;
  publish_notify: boolean;
  subscribe_channel: boolean;
}

export interface ApprovalRequestEvent {
  toolCallId: string;
  name: string;
  /** SQL / native command the tool wants to run. Undefined for read-only
   *  shape tools (`list_schemas` / `list_tables` / `describe_table`); those
   *  populate `summary` instead. */
  sql?: string;
  /** Human-readable one-liner for tools that don't have a SQL preview. */
  summary?: string;
  /** Populated when `name === 'write_query_tab'`: 'new' | 'replace'. */
  mode?: 'new' | 'replace';
  /** Populated when `name === 'write_query_tab'`: optional tab title. */
  title?: string;
}

/** Fires after the user approves a `write_query_tab` call. The frontend
 *  consumes this to mutate its tabs state — the backend can't reach React. */
export interface TabWriteEvent {
  toolCallId: string;
  connectionId?: string;
  schema?: string;
  sql: string;
  mode: 'new' | 'replace';
  title?: string;
}

export type ApprovalDecision = 'approve' | 'deny';

// --- Shortcut kinds (M8.5) ---
export type ChatKind = 'chat' | 'fix' | 'explain' | 'generate';

/** What the user has open in the active tab. Sent with every chat turn so
 *  the model can answer "what does this do?" without a paste. */
export type ChatFocus =
  | { type: 'query'; sql: string }
  | { type: 'routine'; schema: string; name: string; kind: 'function' | 'procedure' | 'view' }
  | { type: 'table'; schema: string; name: string }
  | { type: 'realtime'; pattern: string; isRunning: boolean; recentChannels: string[] };

// --- Local model catalog (M8.1) ---
export interface LocalModelInfo {
  id: string;
  display: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  minRamGb: number;
  downloaded: boolean;
  downloadedBytes: number;
  hasPartial: boolean;
  partialBytes: number;
  hashPinned: boolean;
}

// Rust serializes with `#[serde(flatten)]` for `ModelEntry`, so fields from
// the catalog entry sit at the top level alongside the status fields.
interface LocalModelRaw {
  id: string;
  display: string;
  size_bytes: number;
  sha256: string;
  url: string;
  min_ram_gb: number;
  downloaded: boolean;
  downloaded_bytes: number;
  has_partial: boolean;
  partial_bytes: number;
  hash_pinned: boolean;
}

function normaliseLocal(raw: LocalModelRaw): LocalModelInfo {
  return {
    id: raw.id,
    display: raw.display,
    sizeBytes: raw.size_bytes,
    sha256: raw.sha256,
    url: raw.url,
    minRamGb: raw.min_ram_gb,
    downloaded: raw.downloaded,
    downloadedBytes: raw.downloaded_bytes,
    hasPartial: raw.has_partial,
    partialBytes: raw.partial_bytes,
    hashPinned: raw.hash_pinned,
  };
}

export interface DownloadProgressEvent {
  modelId: string;
  downloaded: number;
  total: number;
  speedBps: number;
}

export interface DownloadDoneEvent {
  modelId: string;
  status: 'ok' | 'canceled' | 'error' | 'already_installed';
  message?: string;
}

// --- Local runtime probe (llama-server) ---
export interface LlamaRuntimeStatus {
  installed: boolean;
  path?: string;
  platform: 'macos' | 'linux' | 'windows' | 'other';
  installCommand: string;
}

interface LlamaRuntimeRaw {
  installed: boolean;
  path?: string;
  platform: 'macos' | 'linux' | 'windows' | 'other';
  install_command: string;
}

// Rust returns snake_case; normalise at the boundary so the rest of the app
// stays in TS camelCase.
function toStatus(raw: { active: boolean; provider_kind?: string; model?: string; message_count?: number }): AiStatus {
  return {
    active: raw.active,
    providerKind: raw.provider_kind as AiProviderKind | undefined,
    model: raw.model,
    messageCount: raw.message_count,
  };
}

export const ai = {
  status: async (): Promise<AiStatus> =>
    toStatus(await invoke<{ active: boolean; provider_kind?: string; model?: string; message_count?: number }>('ai_status')),

  start: async (input: StartInput): Promise<AiStatus> =>
    toStatus(await invoke<{ active: boolean; provider_kind?: string; model?: string; message_count?: number }>('ai_start', {
      input: {
        kind: input.kind,
        model: input.model,
        api_key: input.apiKey,
        base_url: input.baseUrl,
        options_json: input.optionsJson,
      },
    })),

  // --- Persistent AI settings (prefill + remember-last) ---
  settingsList: async (): Promise<AiSettings[]> => {
    const raw = await invoke<AiSettingsRaw[]>('ai_settings_list');
    return raw.map(normaliseSettings);
  },

  settingsGet: async (kind: AiProviderKind): Promise<AiSettings | null> => {
    const raw = await invoke<AiSettingsRaw | null>('ai_settings_get', { kind });
    return raw ? normaliseSettings(raw) : null;
  },

  settingsForget: (kind: AiProviderKind): Promise<void> =>
    invoke<void>('ai_settings_forget', { kind }),

  end: () => invoke<void>('ai_end'),

  /** Per-tool auto-approval flags. When true, the given tool runs without
   *  prompting the user. In-memory only — resets on app restart so a
   *  long-lived "always allow" doesn't outlive the session the user
   *  granted it for. */
  getAutoApprovals: (): Promise<AutoApprovalFlags> =>
    invoke<AutoApprovalFlags>('ai_get_auto_approvals'),
  setAutoApprovals: (flags: AutoApprovalFlags): Promise<void> =>
    invoke<void>('ai_set_auto_approvals', { flags }),

  newChat: () => invoke<void>('ai_new_chat'),

  listModels: (kind: AiProviderKind, opts?: { apiKey?: string; baseUrl?: string }): Promise<string[]> =>
    invoke<string[]>('ai_list_models', {
      input: {
        kind,
        api_key: opts?.apiKey,
        base_url: opts?.baseUrl,
      },
    }),

  // --- Local models (M8.1) ---
  listLocalModels: (): Promise<LocalModelInfo[]> =>
    invoke<LocalModelRaw[]>('ai_list_local_models').then(arr => arr.map(normaliseLocal)),

  downloadModel: (id: string): Promise<void> =>
    invoke<void>('ai_download_model', { id }),

  cancelDownload: (id: string): Promise<void> =>
    invoke<void>('ai_cancel_download', { id }),

  deleteModel: (id: string): Promise<void> =>
    invoke<void>('ai_delete_model', { id }),

  approveToolCall: (toolCallId: string, decision: ApprovalDecision): Promise<void> =>
    invoke<void>('ai_approve_tool_call', {
      input: { tool_call_id: toolCallId, decision },
    }),

  onToolCallStarted: (cb: (e: ToolCallStartedEvent) => void): Promise<UnlistenFn> =>
    listen<{ request_id: string; tool_call_id: string; name: string; arguments: string }>(
      'ai://tool/call_started',
      (ev) => {
        cb({
          requestId: ev.payload.request_id,
          toolCallId: ev.payload.tool_call_id,
          name: ev.payload.name,
          arguments: ev.payload.arguments,
        });
      },
    ),

  onToolCallFinished: (cb: (e: ToolCallFinishedEvent) => void): Promise<UnlistenFn> =>
    listen<{ request_id: string; tool_call_id: string; result: string }>(
      'ai://tool/call_finished',
      (ev) => {
        cb({
          requestId: ev.payload.request_id,
          toolCallId: ev.payload.tool_call_id,
          result: ev.payload.result,
        });
      },
    ),

  onApprovalRequest: (cb: (e: ApprovalRequestEvent) => void): Promise<UnlistenFn> =>
    listen<{ tool_call_id: string; name: string; sql?: string; summary?: string; mode?: 'new' | 'replace'; title?: string }>(
      'ai://tool/approval_request',
      (ev) => {
        cb({
          toolCallId: ev.payload.tool_call_id,
          name: ev.payload.name,
          sql: ev.payload.sql,
          summary: ev.payload.summary,
          mode: ev.payload.mode,
          title: ev.payload.title,
        });
      },
    ),

  onTabWrite: (cb: (e: TabWriteEvent) => void): Promise<UnlistenFn> =>
    listen<{
      tool_call_id: string;
      connection_id?: string;
      schema?: string;
      sql: string;
      mode: 'new' | 'replace';
      title?: string;
    }>(
      'ai://tab/write',
      (ev) => {
        cb({
          toolCallId: ev.payload.tool_call_id,
          connectionId: ev.payload.connection_id,
          schema: ev.payload.schema,
          sql: ev.payload.sql,
          mode: ev.payload.mode,
          title: ev.payload.title,
        });
      },
    ),

  onRealtimeSubscribe: (
    cb: (e: { toolCallId: string; connectionId: string; channel: string }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ tool_call_id: string; connection_id: string; channel: string }>(
      'ai://realtime/subscribe',
      (ev) => {
        cb({
          toolCallId: ev.payload.tool_call_id,
          connectionId: ev.payload.connection_id,
          channel: ev.payload.channel,
        });
      },
    ),

  checkLlamaServer: async (): Promise<LlamaRuntimeStatus> => {
    const raw = await invoke<LlamaRuntimeRaw>('ai_check_llama_server');
    return {
      installed: raw.installed,
      path: raw.path,
      platform: raw.platform,
      installCommand: raw.install_command,
    };
  },

  onDownloadProgress: (cb: (e: DownloadProgressEvent) => void): Promise<UnlistenFn> =>
    listen<{ model_id: string; downloaded: number; total: number; speed_bps: number }>(
      'ai://download/progress',
      (ev) => {
        cb({
          modelId: ev.payload.model_id,
          downloaded: ev.payload.downloaded,
          total: ev.payload.total,
          speedBps: ev.payload.speed_bps,
        });
      },
    ),

  onDownloadDone: (cb: (e: DownloadDoneEvent) => void): Promise<UnlistenFn> =>
    listen<{ model_id: string; status: string; message?: string }>(
      'ai://download/done',
      (ev) => {
        cb({
          modelId: ev.payload.model_id,
          status: ev.payload.status as DownloadDoneEvent['status'],
          message: ev.payload.message,
        });
      },
    ),

  chatSend: (
    requestId: string,
    content: string,
    opts?: {
      connectionId?: string;
      schema?: string;
      focus?: ChatFocus;
      kind?: ChatKind;
      sql?: string;
      errorMessage?: string;
    },
  ) =>
    invoke<void>('ai_chat_send', {
      input: {
        request_id: requestId,
        content,
        connection_id: opts?.connectionId,
        schema: opts?.schema,
        focus: opts?.focus,
        kind: opts?.kind,
        sql: opts?.sql,
        error_message: opts?.errorMessage,
      },
    }),

  chatStop: (requestId: string) =>
    invoke<void>('ai_chat_stop', { requestId }),

  onChunk: (cb: (e: ChatChunkEvent) => void): Promise<UnlistenFn> =>
    listen<{ request_id: string; delta: string }>('ai://chat/chunk', (ev) => {
      cb({ requestId: ev.payload.request_id, delta: ev.payload.delta });
    }),

  onDone: (cb: (e: ChatDoneEvent) => void): Promise<UnlistenFn> =>
    listen<{ request_id: string; content: string; finish_reason?: ChatDoneEvent['finishReason'] }>(
      'ai://chat/done',
      (ev) => {
        cb({
          requestId: ev.payload.request_id,
          content: ev.payload.content,
          finishReason: ev.payload.finish_reason,
        });
      },
    ),
};
