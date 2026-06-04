import { useEffect, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Download, Eye, EyeOff, Loader2, Palette, Pencil, Plus, RefreshCw, RotateCcw, Settings2, ShieldCheck, Sparkles, SquarePen, Trash2, Upload, Zap } from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { ai, isAiError, type AiProviderKind } from '../../lib/ai';
import {
  type CredentialProfile,
  deleteCredential,
  getActiveCredentialId,
  hydrateCredentials,
  loadCredentials,
  saveCredential,
  setActiveCredentialId,
} from '../../lib/ai-credentials';
import {
  type AppSettings, type AppTheme, type NullDisplay,
  applyTheme, loadSettings, resetSettings, saveSettings, useSettings,
} from '../../lib/settings-store';
import { connectionsStore, type ConnectionProfileRecord } from '../../lib/connections-store';
import TablePlusImportDialog from './tableplus-import-dialog';
import { toast } from 'sonner';

// Sentinel for "no practical limit" on the AI tool-step / repeat-call caps.
// The backend clamps to [1, 1000] and still uses this as a hard runaway
// backstop, so it's effectively unlimited for any real conversation.
const AI_LIMIT_UNLIMITED = 1000;

// ── Small reusable controls ─────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        {desc && <div className="text-[11px] text-muted-foreground mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A backup/transfer list row: label + description on the left, Export / Import on the right. */
function DataRow({ label, desc, onExport, onImport }: {
  label: string;
  desc: string;
  onExport: () => void;
  onImport: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{desc}</div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={onExport}>
          <Download className="w-3.5 h-3.5" /> Export
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={onImport}>
          <Upload className="w-3.5 h-3.5" /> Import
        </Button>
      </div>
    </div>
  );
}

// ── Provider meta ──────────────────────────────────────────────────────────────

interface ProviderMeta {
  kind: AiProviderKind;
  label: string;
  sublabel: string;
  needsKey: boolean;
  optionalKey?: boolean;
  needsBaseUrl?: boolean;
  defaultModel: string;
}

const PROVIDERS: ProviderMeta[] = [
  { kind: 'openai',            label: 'OpenAI',            sublabel: 'GPT-4o, GPT-4o-mini…',        needsKey: true,                             defaultModel: 'gpt-4o-mini' },
  { kind: 'anthropic',         label: 'Anthropic',         sublabel: 'Claude 3.5 Haiku / Sonnet…',  needsKey: true,                             defaultModel: 'claude-3-5-haiku-latest' },
  { kind: 'gemini',            label: 'Google Gemini',     sublabel: 'Gemini 2.5 Pro / Flash…',     needsKey: true,                             defaultModel: 'gemini-2.5-pro' },
  { kind: 'openai_compatible', label: 'OpenAI-compatible', sublabel: 'Ollama · Groq · LM Studio',   needsKey: false, optionalKey: true, needsBaseUrl: true, defaultModel: 'llama3.1' },
];

const PROVIDER_COLORS: Partial<Record<AiProviderKind, string>> = {
  openai:            'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  anthropic:         'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  gemini:            'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  openai_compatible: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
};

// ── Theme data ─────────────────────────────────────────────────────────────────

const THEMES: { id: AppTheme; label: string; desc: string; bg: string; fg: string; accent: string }[] = [
  { id: 'one-dark',    label: 'One Dark',         desc: 'Atom One Dark Pro',    bg: '#282c34', fg: '#abb2bf', accent: '#61afef' },
  { id: 'latte',       label: 'Catppuccin Latte', desc: 'Warm, clean light',    bg: '#eff1f5', fg: '#4c4f69', accent: '#1e66f5' },
  { id: 'monokai',     label: 'Monokai',          desc: 'Classic dark palette', bg: '#272822', fg: '#f8f8f2', accent: '#fd971f' },
  { id: 'dracula',     label: 'Dracula',          desc: 'Dark purple theme',    bg: '#282a36', fg: '#f8f8f2', accent: '#bd93f9' },
  { id: 'nord',        label: 'Nord',             desc: 'Arctic, cool blue',    bg: '#2e3440', fg: '#eceff4', accent: '#88c0d0' },
  { id: 'tokyo-night', label: 'Tokyo Night',      desc: 'Neon city vibes',      bg: '#1a1b26', fg: '#a9b1d6', accent: '#7aa2f7' },
  { id: 'github-dark', label: 'GitHub Dark',      desc: 'GitHub\'s dark mode',  bg: '#0d1117', fg: '#c9d1d9', accent: '#58a6ff' },
];

// ── Form state ─────────────────────────────────────────────────────────────────

interface ProfileForm {
  name: string;
  kind: AiProviderKind;
  apiKey: string;
  model: string;
  baseUrl: string;
  showKey: boolean;
}

function blankForm(kind: AiProviderKind = 'openai'): ProfileForm {
  const meta = PROVIDERS.find(p => p.kind === kind)!;
  return { name: '', kind, apiKey: '', model: meta.defaultModel, baseUrl: '', showKey: false };
}

function formFromProfile(p: CredentialProfile): ProfileForm {
  return { name: p.name, kind: p.kind, apiKey: p.apiKey ?? '', model: p.model, baseUrl: p.baseUrl ?? '', showKey: false };
}

type Section = 'appearance' | 'general' | 'editor' | 'ai';
type AiMode  = 'list' | 'form';

const ROW_LIMIT_OPTIONS = [50, 100, 250, 500, 1000];
const NULL_DISPLAY_OPTIONS: { value: NullDisplay; label: string }[] = [
  { value: 'blank',     label: 'Blank' },
  { value: 'null-text', label: 'NULL' },
  { value: 'symbol',    label: '∅' },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function connectionInputFromUnknown(value: unknown) {
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

// ── Component ──────────────────────────────────────────────────────────────────

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [section, setSection] = useState<Section>('appearance');
  const [tablePlusOpen, setTablePlusOpen] = useState(false);

  // ── Appearance
  const [theme, setTheme] = useState<AppTheme>(() => loadSettings().theme);

  // ── General / Editor / AI prefs (live via the settings store subscription)
  const settings = useSettings();

  // ── AI auto-approval persistence toggle (separate from the in-memory flags
  // the chat panel manages). When ON, granted permissions survive restart.
  const [aiPermsBusy, setAiPermsBusy] = useState(false);

  // ── AI credentials
  const [credentials, setCredentials]   = useState<CredentialProfile[]>([]);
  const [activeId,    setActiveId]       = useState<string | null>(null);
  const [aiMode,      setAiMode]         = useState<AiMode>('list');
  const [editingId,   setEditingId]      = useState<string | null>(null);
  const [form,        setForm]           = useState<ProfileForm>(blankForm());
  const [saving,      setSaving]         = useState(false);
  const [activating,  setActivating]     = useState<string | null>(null);
  const [deleting,    setDeleting]       = useState<string | null>(null);

  // Model dropdown — fetched models keyed by `${kind}:${baseUrl ?? ''}` so that
  // changing provider or base URL re-fetches independently.
  const [modelCache,  setModelCache]    = useState<Record<string, string[]>>({});
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError,  setModelError]    = useState<string | null>(null);

  // Load credentials when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void hydrateCredentials().then(() => {
      if (cancelled) return;
      setCredentials(loadCredentials());
      setActiveId(getActiveCredentialId());
    });
    setAiMode('list');
    setEditingId(null);
    return () => { cancelled = true; };
  }, [open]);

  // ── Appearance handlers
  const handleTheme = (t: AppTheme) => {
    setTheme(t);
    saveSettings({ theme: t });
    applyTheme(t);
  };

  const handleReset = () => {
    resetSettings();
    setTheme(loadSettings().theme);
    applyTheme(loadSettings().theme);
    toast.success('Settings reset to defaults');
  };

  const exportJson = async (defaultPath: string, payload: unknown, label: string) => {
    const path = await saveDialog({
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path) return;
    await writeTextFile(path, JSON.stringify(payload, null, 2));
    toast.success(`${label} exported`);
  };

  const importJson = async (): Promise<unknown | null> => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path || Array.isArray(path)) return null;
    return JSON.parse(await readTextFile(path));
  };

  const handleExportSettings = async () => {
    try {
      await exportJson('table-relay-settings.json', {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: loadSettings(),
      }, 'Settings');
    } catch (err) {
      toast.error(`Settings export failed: ${String(err)}`);
    }
  };

  const handleImportSettings = async () => {
    try {
      const payload = await importJson();
      if (!payload) return;
      const imported = isObject(payload) && isObject(payload.settings)
        ? payload.settings
        : isObject(payload) ? payload : null;
      if (!imported) {
        toast.error('Settings import failed: invalid JSON shape');
        return;
      }
      saveSettings(imported as Partial<AppSettings>);
      setTheme(loadSettings().theme);
      applyTheme(loadSettings().theme);
      toast.success('Settings imported');
    } catch (err) {
      toast.error(`Settings import failed: ${String(err)}`);
    }
  };

  const handleExportConnections = async () => {
    const ok = window.confirm('Export saved connections as plaintext JSON? This includes database passwords and SSH secrets.');
    if (!ok) return;
    try {
      const connections = await connectionsStore.list();
      await exportJson('table-relay-connections.json', {
        version: 1,
        exportedAt: new Date().toISOString(),
        connections,
      }, 'Connections');
    } catch (err) {
      toast.error(`Connections export failed: ${String(err)}`);
    }
  };

  const handleImportConnections = async () => {
    const ok = window.confirm('Import connections from JSON? Existing records with the same id will be updated.');
    if (!ok) return;
    try {
      const payload = await importJson();
      if (!payload) return;
      const rawConnections = isObject(payload) && Array.isArray(payload.connections)
        ? payload.connections
        : Array.isArray(payload) ? payload : null;
      if (!rawConnections) {
        toast.error('Connections import failed: invalid JSON shape');
        return;
      }
      let imported = 0;
      let skipped = 0;
      for (const item of rawConnections) {
        const input = connectionInputFromUnknown(item);
        if (!input) {
          skipped += 1;
          continue;
        }
        await connectionsStore.save(input);
        imported += 1;
      }
      window.dispatchEvent(new CustomEvent('tablerelay:connections-changed'));
      toast.success(`Imported ${imported} connection${imported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`);
    } catch (err) {
      toast.error(`Connections import failed: ${String(err)}`);
    }
  };

  const handleExportCredentials = async () => {
    const ok = window.confirm('Export AI credentials as plaintext JSON? This includes provider API keys.');
    if (!ok) return;
    try {
      await hydrateCredentials();
      await exportJson('table-relay-ai-credentials.json', {
        version: 1,
        exportedAt: new Date().toISOString(),
        credentials: loadCredentials(),
        activeCredentialId: getActiveCredentialId(),
      }, 'AI credentials');
    } catch (err) {
      toast.error(`AI credentials export failed: ${String(err)}`);
    }
  };

  const handleImportCredentials = async () => {
    const ok = window.confirm('Import AI credentials from JSON? Credentials with the same id will be overwritten.');
    if (!ok) return;
    try {
      const payload = await importJson();
      if (!payload) return;
      // Accept either { credentials: [...] } or a bare array.
      const rawCreds = isObject(payload) && Array.isArray(payload.credentials)
        ? payload.credentials
        : Array.isArray(payload) ? payload : null;
      if (!rawCreds) {
        toast.error('AI credentials import failed: invalid JSON shape');
        return;
      }
      await hydrateCredentials();
      let importedCreds = 0;
      for (const item of rawCreds) {
        if (!isObject(item) || typeof item.name !== 'string' || typeof item.kind !== 'string') continue;
        saveCredential({
          id: typeof item.id === 'string' ? item.id : undefined,
          name: item.name,
          kind: item.kind as AiProviderKind,
          apiKey: typeof item.apiKey === 'string' ? item.apiKey : undefined,
          model: typeof item.model === 'string' ? item.model : '',
          baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : undefined,
        });
        importedCreds += 1;
      }
      if (isObject(payload) && typeof payload.activeCredentialId === 'string') {
        setActiveCredentialId(payload.activeCredentialId);
      }
      window.dispatchEvent(new CustomEvent('tablerelay:credentials-changed'));
      toast.success(`Imported ${importedCreds} credential${importedCreds === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(`AI credentials import failed: ${String(err)}`);
    }
  };

  const handleExportConversations = async () => {
    try {
      const conversationSummaries = await ai.conversationList();
      // conversationList omits messages — fetch each full conversation so the
      // export round-trips the actual chat history, not just the headers.
      const conversations = await Promise.all(
        conversationSummaries.map(c => ai.conversationGet(c.id)),
      );
      await exportJson('table-relay-conversations.json', {
        version: 1,
        exportedAt: new Date().toISOString(),
        conversations: conversations.filter(Boolean),
      }, 'Conversations');
    } catch (err) {
      toast.error(`Conversations export failed: ${String(err)}`);
    }
  };

  const handleImportConversations = async () => {
    const ok = window.confirm('Import conversations from JSON? Conversations with the same id will be overwritten.');
    if (!ok) return;
    try {
      const payload = await importJson();
      if (!payload) return;
      // Accept either { conversations: [...] } or a bare array.
      const rawConvs = isObject(payload) && Array.isArray(payload.conversations)
        ? payload.conversations
        : Array.isArray(payload) ? payload : null;
      if (!rawConvs) {
        toast.error('Conversations import failed: invalid JSON shape');
        return;
      }
      let importedConvs = 0;
      for (const conv of rawConvs) {
        if (!isObject(conv) || typeof conv.id !== 'string') continue;
        await ai.conversationCreate(conv.id, {
          connectionId: typeof conv.connectionId === 'string' ? conv.connectionId : undefined,
          providerKind: typeof conv.providerKind === 'string' ? conv.providerKind : undefined,
          model: typeof conv.model === 'string' ? conv.model : undefined,
        });
        if (typeof conv.title === 'string' && conv.title) {
          await ai.conversationUpdateTitle(conv.id, conv.title);
        }
        await ai.conversationClearMessages(conv.id);
        if (Array.isArray(conv.messages)) {
          for (const m of conv.messages) {
            if (!isObject(m) || typeof m.role !== 'string') continue;
            await ai.conversationSaveMessage(
              conv.id,
              typeof m.id === 'string' ? m.id : crypto.randomUUID(),
              m.role,
              typeof m.content === 'string' ? m.content : '',
              {
                toolCallsJson: typeof m.toolCallsJson === 'string' ? m.toolCallsJson : undefined,
                toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
                kind: typeof m.kind === 'string' ? m.kind : undefined,
              },
            );
          }
        }
        importedConvs += 1;
      }
      toast.success(`Imported ${importedConvs} conversation${importedConvs === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(`Conversations import failed: ${String(err)}`);
    }
  };

  // Persist the toggle locally, and clear the backend in-memory flags when the
  // user turns persistence OFF so a stale "remembered" grant can't linger.
  const handlePersistApprovals = async (v: boolean) => {
    saveSettings({ persistAiApprovals: v });
    if (!v) {
      setAiPermsBusy(true);
      try {
        await ai.setAutoApprovals({
          read_schema: true, read_structure: true,
          call_query: false,
          call_query_read: false, call_query_write: false,
          call_query_create: false, call_query_delete: false,
          cross_database: false,
          write_query_tab: false, publish_notify: false, subscribe_channel: false,
        });
      } catch { /* backend may not be started; toggle still persisted */ }
      finally { setAiPermsBusy(false); }
    }
  };

  // ── AI handlers
  const openAdd = () => {
    setEditingId(null);
    setForm(blankForm());
    setAiMode('form');
  };

  const openEdit = (profile: CredentialProfile) => {
    setEditingId(profile.id);
    setForm(formFromProfile(profile));
    setAiMode('form');
  };

  const cancelForm = () => {
    setAiMode('list');
    setEditingId(null);
    setModelError(null);
  };

  const modelCacheKey = (kind: AiProviderKind, baseUrl: string) => `${kind}:${baseUrl}`;

  const fetchModels = async (force = false) => {
    const key = modelCacheKey(form.kind, form.baseUrl);
    if (!force && modelCache[key]?.length) return;
    setModelLoading(true);
    setModelError(null);
    try {
      const list = await ai.listModels(form.kind, {
        apiKey: form.apiKey || undefined,
        baseUrl: form.baseUrl || undefined,
      });
      setModelCache(prev => ({ ...prev, [key]: list }));
    } catch (err) {
      setModelError(isAiError(err) ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setModelLoading(false);
    }
  };

  // Auto-validate the key by fetching the model list when the user has supplied
  // the required credentials. Debounced so typing a key doesn't fire on every
  // keystroke. Only runs in form mode and only when the list isn't cached.
  const formMeta = PROVIDERS.find(p => p.kind === form.kind)!;
  const canValidate = aiMode === 'form'
    && (!formMeta.needsKey   || form.apiKey.trim().length  > 0)
    && (!formMeta.needsBaseUrl || form.baseUrl.trim().length > 0);
  useEffect(() => {
    if (!canValidate) return;
    const key = modelCacheKey(form.kind, form.baseUrl);
    if (modelCache[key]?.length) return;
    const handle = setTimeout(() => { void fetchModels(false); }, 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canValidate, form.kind, form.apiKey, form.baseUrl]);

  const validationStatus: 'idle' | 'validating' | 'valid' | 'invalid' = (() => {
    if (!canValidate) return 'idle';
    if (modelLoading) return 'validating';
    if (modelError)   return 'invalid';
    const key = modelCacheKey(form.kind, form.baseUrl);
    if ((modelCache[key]?.length ?? 0) > 0) return 'valid';
    return 'idle';
  })();

  const patchForm = (patch: Partial<ProfileForm>) => {
    setForm(prev => {
      const next = { ...prev, ...patch };
      if (patch.kind && patch.kind !== prev.kind) {
        const meta = PROVIDERS.find(p => p.kind === patch.kind)!;
        next.model   = meta.defaultModel;
        next.baseUrl = '';
        next.apiKey  = '';
      }
      return next;
    });
    if (patch.kind !== undefined || patch.apiKey !== undefined || patch.baseUrl !== undefined) {
      setModelError(null);
    }
  };

  const handleSaveProfile = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const profile = saveCredential({
        id:      editingId ?? undefined,
        name:    form.name.trim(),
        kind:    form.kind,
        apiKey:  form.apiKey || undefined,
        model:   form.model || PROVIDERS.find(p => p.kind === form.kind)!.defaultModel,
        baseUrl: form.baseUrl || undefined,
      });
      const updated = loadCredentials();
      setCredentials(updated);

      // If this is the first credential or no active one, auto-activate
      const currentActive = getActiveCredentialId();
      if (!currentActive || updated.length === 1) {
        await activateProfile(profile);
      }

      setAiMode('list');
      setEditingId(null);
      toast.success(editingId ? 'Credential updated' : 'Credential added');
    } catch (err) {
      toast.error(isAiError(err) ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const activateProfile = async (profile: CredentialProfile) => {
    setActivating(profile.id);
    try {
      await ai.start({
        kind:    profile.kind,
        model:   profile.model,
        apiKey:  profile.apiKey,
        baseUrl: profile.baseUrl,
      });
      setActiveCredentialId(profile.id);
      setActiveId(profile.id);
      toast.success(`${profile.name} activated`);
    } catch (err) {
      toast.error(isAiError(err) ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(null);
    }
  };

  const handleDelete = async (profile: CredentialProfile) => {
    setDeleting(profile.id);
    try {
      deleteCredential(profile.id);
      const updated = loadCredentials();
      setCredentials(updated);
      if (activeId === profile.id) {
        setActiveCredentialId(null);
        setActiveId(null);
        await ai.settingsForget(profile.kind).catch(() => {});
      }
      toast.success(`${profile.name} removed`);
    } finally {
      setDeleting(null);
    }
  };

  const meta = PROVIDERS.find(p => p.kind === form.kind)!;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="sm:max-w-225 p-0 gap-0 overflow-hidden">
        <div className="flex h-150">

          {/* Left nav */}
          <div className="w-48 shrink-0 border-r border-border bg-muted/30 flex flex-col pt-4 pb-3 gap-0.5 px-2">
            <DialogHeader className="px-2 pb-3">
              <DialogTitle className="text-sm">Settings</DialogTitle>
            </DialogHeader>
            {([
              ['appearance', Palette, 'Appearance'],
              ['general', Settings2, 'General'],
              ['editor', SquarePen, 'Editor'],
              ['ai', Sparkles, 'AI Providers'],
            ] as const).map(
              ([id, Icon, label]) => (
                <button
                  key={id}
                  onClick={() => setSection(id)}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left transition-colors
                    ${section === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'}`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {label}
                </button>
              )
            )}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-8 py-6 min-w-0">

            {/* ── Appearance ── */}
            {section === 'appearance' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium mb-0.5">Theme</h3>
                  <p className="text-xs text-muted-foreground mb-4">Choose the color palette for the app and editor.</p>
                  <div className="grid grid-cols-3 gap-3">
                    {THEMES.map(t => (
                      <button
                        key={t.id}
                        onClick={() => handleTheme(t.id)}
                        className={`group relative rounded-xl overflow-hidden border-2 transition-all text-left
                          ${theme === t.id ? 'border-primary shadow-md' : 'border-border hover:border-border/80'}`}
                      >
                        <div className="h-24 flex" style={{ background: t.bg }}>
                          <div className="w-8 h-full flex flex-col gap-1.5 p-1.5" style={{ background: `color-mix(in srgb, ${t.bg} 60%, black)` }}>
                            {[0,1,2].map(i => <div key={i} className="rounded-sm h-3" style={{ background: t.accent, opacity: i === 0 ? 1 : 0.4 }} />)}
                          </div>
                          <div className="flex-1 p-2 space-y-1">
                            {[0.7, 0.5, 0.6].map((op, i) => (
                              <div key={i} className="h-1.5 rounded-full" style={{ background: t.fg, opacity: op, width: `${60 + i * 15}%` }} />
                            ))}
                          </div>
                        </div>
                        <div className="px-2.5 py-2 bg-card border-t border-border">
                          <div className="text-xs font-medium truncate">{t.label}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{t.desc}</div>
                        </div>
                        {theme === t.id && (
                          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                            <Check className="w-3 h-3 text-primary-foreground" />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── General ── */}
            {section === 'general' && (
              <div className="space-y-1">
                <div className="mb-2">
                  <h3 className="text-sm font-medium mb-0.5">General</h3>
                  <p className="text-xs text-muted-foreground">Data grid and app behaviour.</p>
                </div>

                <Row title="Default row limit" desc="Page size used when opening a new table tab.">
                  <Select
                    value={String(settings.defaultRowLimit)}
                    onValueChange={(v) => saveSettings({ defaultRowLimit: Number(v) })}
                  >
                    <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ROW_LIMIT_OPTIONS.map(n => (
                        <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>

                <Row title="NULL display" desc="How NULL / empty cells render in the grid.">
                  <Select
                    value={settings.nullDisplay}
                    onValueChange={(v) => saveSettings({ nullDisplay: v as NullDisplay })}
                  >
                    <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {NULL_DISPLAY_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>

                <Row title="Confirm destructive queries" desc="Warn before running DELETE / UPDATE / DROP without a WHERE.">
                  <Toggle checked={settings.confirmDestructive} onChange={(v) => saveSettings({ confirmDestructive: v })} />
                </Row>

                <Row title="Restore session on startup" desc="Reconnect to pinned databases when the app launches.">
                  <Toggle checked={settings.restoreOnStartup} onChange={(v) => saveSettings({ restoreOnStartup: v })} />
                </Row>

                <div className="pt-4 mt-2 border-t border-border">
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Backup &amp; transfer</h4>
                  <div className="rounded-md border border-border divide-y divide-border">
                    <DataRow label="Settings" desc="Appearance, editor and behaviour preferences" onExport={handleExportSettings} onImport={handleImportSettings} />
                    <DataRow label="Connections" desc="Saved databases — includes passwords &amp; SSH secrets" onExport={handleExportConnections} onImport={handleImportConnections} />
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <div className="text-sm">TablePlus</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">Import connections from a .tableplusconnection export</div>
                      </div>
                      <div className="shrink-0">
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setTablePlusOpen(true)}>
                          <Upload className="w-3.5 h-3.5" /> Import
                        </Button>
                      </div>
                    </div>
                    <DataRow label="AI credentials" desc="Provider profiles — includes API keys" onExport={handleExportCredentials} onImport={handleImportCredentials} />
                    <DataRow label="Conversations" desc="Full AI chat history" onExport={handleExportConversations} onImport={handleImportConversations} />
                  </div>

                  <div className="flex justify-end mt-3">
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive" onClick={handleReset}>
                      <RotateCcw className="w-3.5 h-3.5" /> Reset all settings to defaults
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Editor ── */}
            {section === 'editor' && (
              <div className="space-y-1">
                <div className="mb-2">
                  <h3 className="text-sm font-medium mb-0.5">Editor</h3>
                  <p className="text-xs text-muted-foreground">Preferences for the SQL / query editor.</p>
                </div>

                <Row title="Font size" desc="Editor font size in pixels.">
                  <Select
                    value={String(settings.editorFontSize)}
                    onValueChange={(v) => saveSettings({ editorFontSize: Number(v) })}
                  >
                    <SelectTrigger className="h-8 text-xs w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[11, 12, 13, 14, 15, 16, 18].map(n => (
                        <SelectItem key={n} value={String(n)} className="text-xs">{n}px</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>

                <Row title="Tab size" desc="Spaces per indent level.">
                  <Select
                    value={String(settings.editorTabSize)}
                    onValueChange={(v) => saveSettings({ editorTabSize: Number(v) })}
                  >
                    <SelectTrigger className="h-8 text-xs w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[2, 4, 8].map(n => (
                        <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>

                <Row title="Word wrap" desc="Wrap long lines instead of scrolling horizontally.">
                  <Toggle checked={settings.editorWordWrap} onChange={(v) => saveSettings({ editorWordWrap: v })} />
                </Row>

                <Row title="Minimap" desc="Show the code minimap on the right edge.">
                  <Toggle checked={settings.editorMinimap} onChange={(v) => saveSettings({ editorMinimap: v })} />
                </Row>

                <Row title="Autocomplete" desc="Schema-aware suggestions while typing.">
                  <Toggle checked={settings.editorAutocomplete} onChange={(v) => saveSettings({ editorAutocomplete: v })} />
                </Row>
              </div>
            )}

            {/* ── AI Providers ── */}
            {section === 'ai' && (
              <div>
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-medium mb-0.5">AI Credentials</h3>
                    <p className="text-xs text-muted-foreground">
                      {aiMode === 'list' ? 'Add multiple credentials and switch between them.' : 'Fill in the details for this credential.'}
                    </p>
                  </div>
                  {aiMode === 'list' && (
                    <Button size="sm" className="h-7 text-xs gap-1.5 shrink-0" onClick={openAdd}>
                      <Plus className="w-3.5 h-3.5" /> Add credential
                    </Button>
                  )}
                </div>

                {/* ── List view ── */}
                {aiMode === 'list' && (
                  <div className="space-y-2">
                    {credentials.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border py-10 flex flex-col items-center gap-3 text-center">
                        <Sparkles className="w-8 h-8 text-muted-foreground/40" />
                        <div>
                          <p className="text-sm text-muted-foreground">No AI credentials yet</p>
                          <p className="text-xs text-muted-foreground/60 mt-0.5">Add a provider to start using AI features.</p>
                        </div>
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={openAdd}>
                          <Plus className="w-3.5 h-3.5" /> Add credential
                        </Button>
                      </div>
                    ) : (
                      credentials.map(cred => {
                        const provMeta  = PROVIDERS.find(p => p.kind === cred.kind)!;
                        const isActive  = cred.id === activeId;
                        const isDeleting = deleting === cred.id;
                        const isActivating = activating === cred.id;
                        return (
                          <div
                            key={cred.id}
                            className={`rounded-lg border transition-colors ${isActive ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-border/80'}`}
                          >
                            <div className="flex items-center gap-3 px-3 py-2.5">
                              {/* Active indicator */}
                              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-emerald-500' : 'bg-transparent'}`} />

                              {/* Info */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium truncate">{cred.name}</span>
                                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${PROVIDER_COLORS[cred.kind] ?? 'bg-muted text-muted-foreground'}`}>
                                    {provMeta.label}
                                  </span>
                                  {isActive && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
                                      active
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                                  {cred.model}
                                  {cred.baseUrl && ` · ${cred.baseUrl}`}
                                  {cred.apiKey && ` · ••••${cred.apiKey.slice(-4)}`}
                                </p>
                              </div>

                              {/* Actions */}
                              <div className="flex items-center gap-1 shrink-0">
                                {!isActive && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-xs gap-1 px-2"
                                    onClick={() => void activateProfile(cred)}
                                    disabled={!!activating}
                                    title="Activate this credential"
                                  >
                                    {isActivating
                                      ? <Loader2 className="w-3 h-3 animate-spin" />
                                      : <Zap className="w-3 h-3" />}
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0"
                                  onClick={() => openEdit(cred)}
                                  title="Edit"
                                >
                                  <Pencil className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                  onClick={() => void handleDelete(cred)}
                                  disabled={isDeleting}
                                  title="Remove"
                                >
                                  {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {/* ── Add / Edit form ── */}
                {aiMode === 'form' && (
                  <div className="space-y-3">
                    {/* Provider */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Provider</Label>
                      <Select value={form.kind} onValueChange={v => patchForm({ kind: v as AiProviderKind })}>
                        <SelectTrigger className="h-8 text-xs w-full">
                          <SelectValue>
                            {PROVIDERS.find(p => p.kind === form.kind)?.label}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {PROVIDERS.map(p => (
                            <SelectItem key={p.kind} value={p.kind} className="text-xs">
                              <span className="block">
                                <span className="font-medium">{p.label}</span>
                                <span className="ml-1.5 text-muted-foreground text-[10px]">{p.sublabel}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Name */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Name</Label>
                      <Input
                        placeholder={`e.g. ${meta.label} (work)`}
                        value={form.name}
                        onChange={e => patchForm({ name: e.target.value })}
                        className="h-8 text-xs"
                      />
                    </div>

                    {/* Base URL (openai_compatible only) */}
                    {meta.needsBaseUrl && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Base URL</Label>
                        <Input
                          placeholder="http://localhost:11434/v1"
                          value={form.baseUrl}
                          onChange={e => patchForm({ baseUrl: e.target.value })}
                          className="h-8 text-xs"
                        />
                      </div>
                    )}

                    {/* API Key */}
                    {(meta.needsKey || meta.optionalKey) && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">
                            API Key {meta.optionalKey && <span className="text-muted-foreground/70">(optional)</span>}
                          </Label>
                          {validationStatus === 'validating' && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" /> Validating…
                            </span>
                          )}
                          {validationStatus === 'valid' && (() => {
                            const count = modelCache[modelCacheKey(form.kind, form.baseUrl)]?.length ?? 0;
                            return (
                              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Valid · {count} models
                              </span>
                            );
                          })()}
                          {validationStatus === 'invalid' && (
                            <span className="text-[10px] text-destructive flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> Invalid key
                            </span>
                          )}
                        </div>
                        <div className="relative">
                          <Input
                            type={form.showKey ? 'text' : 'password'}
                            placeholder="sk-…"
                            value={form.apiKey}
                            onChange={e => patchForm({ apiKey: e.target.value })}
                            className={`h-8 text-xs pr-8 font-mono ${
                              validationStatus === 'valid'   ? 'border-emerald-500/40' :
                              validationStatus === 'invalid' ? 'border-destructive/60' : ''
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => patchForm({ showKey: !form.showKey })}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            {form.showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        {validationStatus === 'invalid' && modelError && (
                          <p className="text-[10px] text-destructive">{modelError}</p>
                        )}
                      </div>
                    )}

                    {/* Model — native autocomplete via <datalist> */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">Model</Label>
                        {(() => {
                          const cKey = modelCacheKey(form.kind, form.baseUrl);
                          const list = modelCache[cKey] ?? [];
                          if (list.length === 0 && !modelLoading) return null;
                          return (
                            <button
                              type="button"
                              onClick={() => void fetchModels(true)}
                              disabled={modelLoading}
                              className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
                              title="Re-fetch model list"
                            >
                              <RefreshCw className={`w-3 h-3 ${modelLoading ? 'animate-spin' : ''}`} />
                              {list.length > 0 && `${list.length} available`}
                            </button>
                          );
                        })()}
                      </div>
                      <Input
                        list={`models-${form.kind}-${form.baseUrl}`}
                        placeholder={meta.defaultModel}
                        value={form.model}
                        onChange={e => patchForm({ model: e.target.value })}
                        className="h-8 text-xs font-mono"
                      />
                      <datalist id={`models-${form.kind}-${form.baseUrl}`}>
                        {(modelCache[modelCacheKey(form.kind, form.baseUrl)] ?? []).map(m => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-1">
                      <Button size="sm" className="h-7 text-xs" onClick={() => void handleSaveProfile()} disabled={saving}>
                        {saving ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Saving…</> : (editingId ? 'Update' : 'Add')}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={cancelForm}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {/* ── Assistant behavior ── */}
                {aiMode === 'list' && (
                  <div className="mt-6 pt-4 border-t border-border space-y-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />
                      <h4 className="text-xs font-medium">Assistant behavior</h4>
                    </div>

                    <Row
                      title="Max tool steps per message"
                      desc="How many tool-calling rounds (schema reads, queries) the assistant may take before it must answer. Raise it for capable agentic models; lower it to fail fast on models that over-explore."
                    >
                      <Select
                        value={String(settings.aiMaxToolIterations)}
                        onValueChange={(v) => saveSettings({ aiMaxToolIterations: Number(v) })}
                      >
                        <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[3, 6, 9, 12, 16, 20, 30, 50, 100, AI_LIMIT_UNLIMITED].map(n => (
                            <SelectItem key={n} value={String(n)} className="text-xs">
                              {n === AI_LIMIT_UNLIMITED ? 'Unlimited' : `${n} steps`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>

                    <Row
                      title="Repeat-call limit"
                      desc="How many times the assistant may call the same tool with identical arguments before the loop-guard stops the turn. Raise it for agentic flows that legitimately repeat a tool (e.g. writing many query tabs); lower it to stop runaway loops sooner."
                    >
                      <Select
                        value={String(settings.aiMaxRepeatCalls)}
                        onValueChange={(v) => saveSettings({ aiMaxRepeatCalls: Number(v) })}
                      >
                        <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[3, 5, 10, 15, 20, 30, 50, 100, AI_LIMIT_UNLIMITED].map(n => (
                            <SelectItem key={n} value={String(n)} className="text-xs">
                              {n === AI_LIMIT_UNLIMITED ? 'Unlimited' : `${n} calls`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                  </div>
                )}

                {/* ── Security & permissions ── */}
                {aiMode === 'list' && (
                  <div className="mt-6 pt-4 border-t border-border space-y-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />
                      <h4 className="text-xs font-medium">Security &amp; permissions</h4>
                    </div>

                    <Row
                      title="Remember AI permissions across restarts"
                      desc="Off by default — auto-approval grants are cleared every launch so the assistant can't act unattended."
                    >
                      {aiPermsBusy
                        ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                        : <Toggle checked={settings.persistAiApprovals} onChange={(v) => void handlePersistApprovals(v)} />}
                    </Row>

                    <p className="text-[11px] text-muted-foreground/80 leading-relaxed pt-1">
                      API keys are stored unencrypted on this machine (dev mode). The AI assistant
                      reads schema freely, but every query it runs requires explicit approval unless
                      you grant auto-approval in the chat panel.
                    </p>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </DialogContent>
    </Dialog>
    <TablePlusImportDialog open={tablePlusOpen} onOpenChange={setTablePlusOpen} />
    </>
  );
}
