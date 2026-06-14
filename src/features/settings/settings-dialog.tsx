import { useEffect, useState } from 'react';
import { AlertCircle, ArrowDownUp, CheckCircle2, Eye, EyeOff, Loader2, Palette, Pencil, Plus, RefreshCw, RotateCcw, ScrollText, Settings2, ShieldCheck, Sparkles, SquarePen, Trash2, Zap } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import PasswordPromptDialog from './password-prompt-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { SearchableSelect } from '../../components/ui/searchable-select';
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
import ConnectionTransferDialog from '../connections/connection-transfer-dialog';
import { LocalModelPanel } from '../ai-chat/local-model-panel';
import { Row, Toggle, DataRow } from './settings-controls';
import { AppearanceSettings, EditorSettings, LogsSettings } from './settings-sections';
import {
  AI_LIMIT_UNLIMITED,
  PROVIDERS,
  PROVIDER_COLORS,
  type ProfileForm,
  blankForm,
  formFromProfile,
  type Section,
  type AiMode,
  ROW_LIMIT_OPTIONS,
  NULL_DISPLAY_OPTIONS,
  isObject,
} from './settings-utils';
import { toast } from 'sonner';

// ── Component ──────────────────────────────────────────────────────────────────

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Section to land on when opened (e.g. 'general' for the connections rows). */
  initialSection?: string;
}

export default function SettingsDialog({ open, onOpenChange, initialSection }: SettingsDialogProps) {
  const [section, setSection] = useState<Section>('appearance');
  // Per-connection import/export dialog (replaces the old all-or-nothing flow).
  const [connTransfer, setConnTransfer] = useState<'export' | 'import' | null>(null);

  // App version for the nav footer — read from the bundled binary (the real
  // build the user is running), so it reflects the installed version, not just
  // the source package.json.
  const [appVersion, setAppVersion] = useState<string>('');
  useEffect(() => {
    void import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then(setAppVersion)
      .catch(() => setAppVersion(''));
  }, []);

  // Password prompt for encrypted export/import. We open it and await the
  // user's password via a stashed resolver, so the export/import helpers can
  // simply `const pw = await askPassword(...)`.
  const [pwPrompt, setPwPrompt] = useState<{
    mode: 'set' | 'enter';
    title: string;
    description?: string;
  } | null>(null);
  const [pwResolver, setPwResolver] = useState<((pw: string | null) => void) | null>(null);
  const askPassword = (opts: { mode: 'set' | 'enter'; title: string; description?: string }) =>
    new Promise<string | null>((resolve) => {
      setPwResolver(() => resolve);
      setPwPrompt(opts);
    });
  const resolvePassword = (pw: string | null) => {
    pwResolver?.(pw);
    setPwResolver(null);
    setPwPrompt(null);
  };

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
  // Selected on-device GGUF model id in the llama.cpp panel (highlight only).
  const [localModelId, setLocalModelId]  = useState<string>('');
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
  // CLI-provider availability: resolved binary path, or null when not found,
  // or undefined while checking. Keyed implicitly by the current form.kind.
  const [cliPath, setCliPath] = useState<string | null | undefined>(undefined);

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
    // Land on the requested section (e.g. 'general' for connection transfer).
    if (initialSection) setSection(initialSection as Section);
    return () => { cancelled = true; };
  }, [open, initialSection]);

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

  const exportJson = async (
    defaultPath: string,
    payload: unknown,
    label: string,
    encrypt = true,
  ) => {
    // Sensitive exports (settings, connections, credentials) are encrypted with
    // a user-chosen password (RNCryptor v3); `.dtab` = Table Relay encrypted
    // export. Non-sensitive ones (conversations) stay plain `.json`.
    if (!encrypt) {
      const path = await saveDialog({
        defaultPath,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await writeTextFile(path, JSON.stringify(payload, null, 2));
      toast.success(`${label} exported`);
      return;
    }
    const encName = defaultPath.replace(/\.json$/, '.dtab');
    const path = await saveDialog({
      defaultPath: encName,
      filters: [{ name: 'Table Relay export', extensions: ['dtab'] }],
    });
    if (!path) return;
    const password = await askPassword({
      mode: 'set',
      title: `Encrypt ${label.toLowerCase()} export`,
      description: 'Set a password to protect this file. You’ll need it to import the file later.',
    });
    if (!password) return; // cancelled
    await invoke('secure_export', { path, json: JSON.stringify(payload, null, 2), password });
    toast.success(`${label} exported (encrypted)`);
  };

  const importJson = async (): Promise<unknown | null> => {
    const path = await openDialog({
      multiple: false,
      filters: [
        { name: 'Table Relay export', extensions: ['dtab', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!path || Array.isArray(path)) return null;

    const encrypted = await invoke<boolean>('secure_is_encrypted', { path });
    if (!encrypted) {
      // Back-compat: older exports are plaintext JSON.
      return JSON.parse(await readTextFile(path));
    }
    // Encrypted: prompt for the password and retry until correct or cancelled.
    for (;;) {
      const password = await askPassword({
        mode: 'enter',
        title: 'Import encrypted file',
        description: 'Enter the password used when this file was exported.',
      });
      if (!password) return null; // cancelled
      try {
        const json = await invoke<string>('secure_import', { path, password });
        return JSON.parse(json);
      } catch (err) {
        const kind = (err as { kind?: string })?.kind;
        if (kind === 'BadPassword') {
          toast.error('Wrong password — try again.');
          continue;
        }
        throw err;
      }
    }
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

  // Connection import/export now lives in ConnectionTransferDialog (a
  // per-connection picker), opened via setConnTransfer below.

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
      }, 'Conversations', false); // chat history isn't sensitive — keep it plain
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

  // CLI providers: check the binary is installed when this provider is selected.
  useEffect(() => {
    if (aiMode !== 'form' || !formMeta.requiresLocalCli) {
      setCliPath(undefined);
      return;
    }
    let cancelled = false;
    setCliPath(undefined);
    void ai.cliAvailable(form.kind).then((path) => {
      if (!cancelled) setCliPath(path);
    }).catch(() => { if (!cancelled) setCliPath(null); });
    return () => { cancelled = true; };
  }, [aiMode, form.kind, formMeta.requiresLocalCli]);

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
        <div className="flex h-150 min-w-0 w-full">

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
              ['data', ArrowDownUp, 'Import / Export'],
              ['logs', ScrollText, 'Logs'],
            ] as const).map(
              ([id, Icon, label]) => (
                <button
                  key={id}
                  onClick={() => setSection(id)}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left transition-colors
                    ${section === id ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'}`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {label}
                </button>
              )
            )}

            {/* Version, pinned to the bottom of the nav. Clicking opens the
                GitHub releases page (changelog / check for updates). */}
            <button
              type="button"
              onClick={() => {
                const base = process.env.GIT_URL || 'https://github.com/ByteLogicLabs/Table-Relay';
                void openUrl(`${base}/releases`).catch(() => {});
              }}
              title="View releases on GitHub"
              className="mt-auto mx-1 px-1.5 py-1 rounded text-left text-[10px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              Table Relay{appVersion ? ` v${appVersion}` : ''}
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-8 py-6 min-w-0">

            {/* ── Appearance ── */}
            {section === 'appearance' && (
              <AppearanceSettings theme={theme} onSelectTheme={handleTheme} />
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

                <div className="flex justify-end pt-4 mt-2 border-t border-border">
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive" onClick={handleReset}>
                    <RotateCcw className="w-3.5 h-3.5" /> Reset all settings to defaults
                  </Button>
                </div>
              </div>
            )}

            {/* ── Import / Export ── */}
            {section === 'data' && (
              <div className="space-y-1">
                <div className="mb-3">
                  <h3 className="text-sm font-medium mb-0.5">Import / Export</h3>
                  <p className="text-xs text-muted-foreground">Back up your data or move it between machines.</p>
                </div>
                <div className="rounded-md border border-border divide-y divide-border">
                  <DataRow label="Settings" desc="Appearance, editor and behaviour preferences" onExport={handleExportSettings} onImport={handleImportSettings} />
                  <DataRow label="Connections" desc="Saved databases — pick which to export/import, or bring in from TablePlus, DBeaver, Navicat, HeidiSQL" onExport={() => setConnTransfer('export')} onImport={() => setConnTransfer('import')} />
                  <DataRow label="AI credentials" desc="Provider profiles — includes API keys" onExport={handleExportCredentials} onImport={handleImportCredentials} />
                  <DataRow label="Conversations" desc="Full AI chat history" onExport={handleExportConversations} onImport={handleImportConversations} />
                </div>
              </div>
            )}

            {/* ── Editor ── */}
            {section === 'editor' && (
              <EditorSettings settings={settings} />
            )}

            {/* ── Logs ── */}
            {section === 'logs' && (
              <LogsSettings />
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

                {/* ── Local models (llama.cpp) ── */}
                {aiMode === 'list' && (
                  <div className="mt-6 pt-5 border-t border-border">
                    <h3 className="text-sm font-medium mb-0.5">On-device models (llama.cpp)</h3>
                    <p className="text-xs text-muted-foreground mb-3">
                      Run a GGUF model locally — no API key, fully offline. Requires the
                      <code className="mx-1 px-1 rounded bg-muted text-[11px]">llama-server</code>
                      binary; download a model below, then pick <strong>Local Llama</strong> in the chat.
                    </p>
                    <LocalModelPanel selectedId={localModelId} onPick={setLocalModelId} />
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
                          {/* CLI tools (claude/codex/gemini/opencode) are NOT
                              listed here: they auth through their own installed
                              binary and are started directly from the chat panel,
                              so they don't belong in the saved-API-credential
                              form. Only key/URL-based providers appear. */}
                          {PROVIDERS.filter(p => !p.requiresLocalCli).map(p => (
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

                    {/* CLI provider availability check */}
                    {meta.requiresLocalCli && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Local CLI</Label>
                        {cliPath === undefined ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
                            <Loader2 className="w-3 h-3 animate-spin" /> Checking for <code className="font-mono">{meta.cliBinary}</code>…
                          </div>
                        ) : cliPath ? (
                          <div className="flex items-start gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                            <span className="min-w-0">Found <code className="font-mono break-all">{cliPath}</code></span>
                          </div>
                        ) : (
                          <div className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                            <span className="min-w-0">
                              <code className="font-mono">{meta.cliBinary}</code> not found on PATH. Install it and run it once to log in — billing/auth stays under your own CLI account.
                            </span>
                          </div>
                        )}
                      </div>
                    )}

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

                    {/* Model — searchable dropdown that shows the FULL list on
                        open (filters only as you type), unlike a <datalist> which
                        the browser pre-filters to the current value. `allowCustom`
                        keeps the ability to type a model id not in the catalog. */}
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
                      {(() => {
                        const list = modelCache[modelCacheKey(form.kind, form.baseUrl)] ?? [];
                        const options = list.map(m => ({ value: m, label: m }));
                        return (
                          <SearchableSelect
                            value={form.model}
                            options={options}
                            onChange={m => patchForm({ model: m })}
                            placeholder={meta.defaultModel || 'Select a model'}
                            searchPlaceholder={modelLoading ? 'Loading models…' : 'Search or type a model id…'}
                            className="h-8 text-xs font-mono"
                            allowCustom
                          />
                        );
                      })()}
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
    {connTransfer && (
      <ConnectionTransferDialog
        open={connTransfer !== null}
        mode={connTransfer}
        onOpenChange={(v) => { if (!v) setConnTransfer(null); }}
      />
    )}
    {pwPrompt && (
      <PasswordPromptDialog
        open={pwPrompt !== null}
        mode={pwPrompt.mode}
        title={pwPrompt.title}
        description={pwPrompt.description}
        onSubmit={(pw) => resolvePassword(pw)}
        onOpenChange={(v) => { if (!v) resolvePassword(null); }}
      />
    )}
    </>
  );
}
