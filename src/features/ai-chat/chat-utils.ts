import { type AiProviderKind, type ChatFocus } from '../../lib/ai';

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
  /** Subprocess CLI provider: needs the binary installed + logged in locally,
   *  not an API key. The start screen runs an availability check for these. */
  requiresLocalCli?: boolean;
  /** Binary name to detect (for requiresLocalCli providers). */
  cliBinary?: string;
}

export function parseKeyFromUrlLike(value: string): string | null {
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
export const PROVIDERS: ProviderOption[] = [
  { kind: 'openai', label: 'OpenAI', sublabel: 'chat/completions', available: true, needsKey: true, defaultModel: 'gpt-4o-mini' },
  { kind: 'anthropic', label: 'Anthropic', sublabel: 'messages API', available: true, needsKey: true, defaultModel: 'claude-3-5-haiku-latest' },
  { kind: 'gemini', label: 'Google', sublabel: 'generativelanguage', available: true, needsKey: true, defaultModel: 'gemini-2.5-pro' },
  { kind: 'openai_compatible', label: 'OpenAI-compatible', sublabel: 'Ollama / Groq / LM Studio', available: true, needsKey: false, optionalKey: true, needsBaseUrl: true, defaultModel: 'llama3.1' },
  { kind: 'llama_local', label: 'Local Llama', sublabel: 'GGUF · on-device', available: true, needsKey: false },
  { kind: 'claude_cli', label: 'Claude Code CLI', sublabel: 'your installed `claude`', available: true, needsKey: false, requiresLocalCli: true, cliBinary: 'claude', defaultModel: 'sonnet' },
  { kind: 'codex_cli', label: 'Codex CLI', sublabel: 'your installed `codex`', available: true, needsKey: false, requiresLocalCli: true, cliBinary: 'codex', defaultModel: 'gpt-5-codex' },
  { kind: 'gemini_cli', label: 'Gemini CLI', sublabel: 'your installed `gemini`', available: true, needsKey: false, requiresLocalCli: true, cliBinary: 'gemini', defaultModel: 'gemini-2.5-pro' },
  { kind: 'opencode', label: 'opencode', sublabel: 'your installed `opencode`', available: true, needsKey: false, requiresLocalCli: true, cliBinary: 'opencode' },
];

export function openSettings() {
  window.dispatchEvent(new CustomEvent('tablerelay:open-settings'));
}

// Per-message timestamp shown under each chat bubble. Shows just the time for
// messages sent today, and date + time for older ones (so a reloaded history
// conversation reads correctly).
export function formatMessageTime(ms: number): string {
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
  open_object_tab:   'Open Editor Tab',
  call_query:        'Run Query',
  list_schemas:      'List Schemas',
  list_tables:       'List Tables',
  describe_table:    'Describe Table',
  publish_notify:    'Publish Notification',
  subscribe_channel: 'Subscribe Channel',
};
export function prettyToolName(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  return name
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function focusLabel(focus: ChatFocus): string {
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

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtRate(bps: number): string {
  if (bps <= 0) return '—';
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function extractErrorString(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const err = r.error;
  if (typeof err === 'string' && err.length > 0) return err;
  return null;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `… (${s.length - n} more chars)`;
}
