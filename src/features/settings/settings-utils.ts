import { type AiProviderKind } from '../../lib/ai';
import { type CredentialProfile } from '../../lib/ai-credentials';
import { type AppTheme, type NullDisplay } from '../../lib/settings-store';
import { type ConnectionProfileRecord } from '../../lib/connections-store';

// Sentinel for "no practical limit" on the AI tool-step / repeat-call caps.
// The backend clamps to [1, 1000] and still uses this as a hard runaway
// backstop, so it's effectively unlimited for any real conversation.
export const AI_LIMIT_UNLIMITED = 1000;

// ── Provider meta ──────────────────────────────────────────────────────────────

export interface ProviderMeta {
  kind: AiProviderKind;
  label: string;
  sublabel: string;
  needsKey: boolean;
  optionalKey?: boolean;
  needsBaseUrl?: boolean;
  defaultModel: string;
}

export const PROVIDERS: ProviderMeta[] = [
  { kind: 'openai',            label: 'OpenAI',            sublabel: 'GPT-4o, GPT-4o-mini…',        needsKey: true,                             defaultModel: 'gpt-4o-mini' },
  { kind: 'anthropic',         label: 'Anthropic',         sublabel: 'Claude 3.5 Haiku / Sonnet…',  needsKey: true,                             defaultModel: 'claude-3-5-haiku-latest' },
  { kind: 'gemini',            label: 'Google Gemini',     sublabel: 'Gemini 2.5 Pro / Flash…',     needsKey: true,                             defaultModel: 'gemini-2.5-pro' },
  { kind: 'openai_compatible', label: 'OpenAI-compatible', sublabel: 'Ollama · Groq · LM Studio',   needsKey: false, optionalKey: true, needsBaseUrl: true, defaultModel: 'llama3.1' },
];

export const PROVIDER_COLORS: Partial<Record<AiProviderKind, string>> = {
  openai:            'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  anthropic:         'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  gemini:            'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  openai_compatible: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
};

// ── Theme data ─────────────────────────────────────────────────────────────────

export const THEMES: { id: AppTheme; label: string; desc: string; bg: string; fg: string; accent: string }[] = [
  { id: 'one-dark',    label: 'One Dark',         desc: 'Atom One Dark Pro',    bg: '#282c34', fg: '#abb2bf', accent: '#61afef' },
  { id: 'latte',       label: 'Catppuccin Latte', desc: 'Warm, clean light',    bg: '#eff1f5', fg: '#4c4f69', accent: '#1e66f5' },
  { id: 'monokai',     label: 'Monokai',          desc: 'Classic dark palette', bg: '#272822', fg: '#f8f8f2', accent: '#fd971f' },
  { id: 'dracula',     label: 'Dracula',          desc: 'Dark purple theme',    bg: '#282a36', fg: '#f8f8f2', accent: '#bd93f9' },
  { id: 'nord',        label: 'Nord',             desc: 'Arctic, cool blue',    bg: '#2e3440', fg: '#eceff4', accent: '#88c0d0' },
  { id: 'tokyo-night', label: 'Tokyo Night',      desc: 'Neon city vibes',      bg: '#1a1b26', fg: '#a9b1d6', accent: '#7aa2f7' },
  { id: 'github-dark', label: 'GitHub Dark',      desc: 'GitHub\'s dark mode',  bg: '#0d1117', fg: '#c9d1d9', accent: '#58a6ff' },
];

// ── Form state ─────────────────────────────────────────────────────────────────

export interface ProfileForm {
  name: string;
  kind: AiProviderKind;
  apiKey: string;
  model: string;
  baseUrl: string;
  showKey: boolean;
}

export function blankForm(kind: AiProviderKind = 'openai'): ProfileForm {
  const meta = PROVIDERS.find(p => p.kind === kind)!;
  return { name: '', kind, apiKey: '', model: meta.defaultModel, baseUrl: '', showKey: false };
}

export function formFromProfile(p: CredentialProfile): ProfileForm {
  return { name: p.name, kind: p.kind, apiKey: p.apiKey ?? '', model: p.model, baseUrl: p.baseUrl ?? '', showKey: false };
}

export type Section = 'appearance' | 'general' | 'editor' | 'ai' | 'data';
export type AiMode  = 'list' | 'form';

export const ROW_LIMIT_OPTIONS = [50, 100, 250, 500, 1000];
export const NULL_DISPLAY_OPTIONS: { value: NullDisplay; label: string }[] = [
  { value: 'blank',     label: 'Blank' },
  { value: 'null-text', label: 'NULL' },
  { value: 'symbol',    label: '∅' },
];

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function connectionInputFromUnknown(value: unknown) {
  if (!isObject(value)) return null;
  const name = asString(value.name);
  const driver = asString(value.driver) as ConnectionProfileRecord['driver'] | undefined;
  const host = asString(value.host);
  const port = asNumber(value.port);
  if (!name || !driver || !host || port === undefined) return null;
  return {
    id: asString(value.id),
    name,
    driver,
    host,
    port,
    user: asString(value.user),
    password: asString(value.password),
    database: asString(value.database),
    sslMode: asString(value.sslMode),
    sshEnabled: Boolean(value.sshEnabled),
    sshHost: asString(value.sshHost),
    sshPort: asNumber(value.sshPort),
    sshUser: asString(value.sshUser),
    sshAuthKind: asString(value.sshAuthKind) as 'password' | 'key' | undefined,
    sshKeyPath: asString(value.sshKeyPath),
    sshPassword: asString(value.sshPassword),
    sshKeyPassphrase: asString(value.sshKeyPassphrase),
    color: asString(value.color),
    isFavorite: Boolean(value.isFavorite),
  };
}
