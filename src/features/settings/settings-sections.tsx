import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, RefreshCw, Copy, Download, Trash2, FolderOpen, ScrollText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { type AppSettings, type AppTheme, saveSettings } from '../../lib/settings-store';
import { copyText } from '../../lib/clipboard';
import { Row, Toggle } from './settings-controls';
import { THEMES } from './settings-utils';

// ── Appearance ──────────────────────────────────────────────────────────────────

export function AppearanceSettings({ theme, onSelectTheme }: {
  theme: AppTheme;
  onSelectTheme: (t: AppTheme) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium mb-0.5">Theme</h3>
        <p className="text-xs text-muted-foreground mb-4">Choose the color palette for the app and editor.</p>
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => onSelectTheme(t.id)}
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
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────────

export function EditorSettings({ settings }: { settings: AppSettings }) {
  return (
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
  );
}

// ── Logs ──────────────────────────────────────────────────────────────────────

interface LogContents {
  name: string; // 'app' | 'chat'
  path: string;
  bytes: number;
  text: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Logs panel: opt-in file logging for diagnostics (off by default). Lets the
 * user enable/disable, view the app + chat logs, copy/export, clear, and reveal
 * the logs folder. Each log file is ring-capped at 5 MB by the backend.
 */
export function LogsSettings() {
  const [enabled, setEnabled] = useState(false);
  const [logs, setLogs] = useState<LogContents[]>([]);
  const [active, setActive] = useState<'app' | 'chat'>('app');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [on, contents] = await Promise.all([
        invoke<boolean>('logging_get_enabled'),
        invoke<LogContents[]>('logging_read', { maxChars: 200_000 }),
      ]);
      setEnabled(on);
      setLogs(contents);
    } catch (e) {
      toast.error(`Failed to read logs: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = async (on: boolean) => {
    try {
      await invoke('logging_set_enabled', { enabled: on });
      setEnabled(on);
      if (on) toast.success('Logging enabled'); else toast('Logging disabled');
    } catch (e) {
      toast.error(`Failed to update logging: ${String(e)}`);
    }
  };

  const current = logs.find((l) => l.name === active);

  const handleCopy = async () => {
    if (!current?.text) { toast('Log is empty'); return; }
    await copyText(current.text);
    toast.success('Log copied to clipboard');
  };

  const handleExport = async () => {
    if (!current?.text) { toast('Log is empty'); return; }
    try {
      const path = await saveDialog({
        defaultPath: `table-relay-${active}.log`,
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (!path) return;
      await writeTextFile(path, current.text);
      toast.success('Log saved');
    } catch (e) {
      toast.error(`Save failed: ${String(e)}`);
    }
  };

  const handleClear = async () => {
    try {
      await invoke('logging_clear', { which: active });
      await refresh();
      toast.success(`Cleared ${active} log`);
    } catch (e) {
      toast.error(`Clear failed: ${String(e)}`);
    }
  };

  const handleOpenDir = async () => {
    try {
      await invoke('logging_open_dir');
    } catch (e) {
      toast.error(`Could not open logs folder: ${String(e)}`);
    }
  };

  const lineCount = current?.text ? current.text.replace(/\n+$/, '').split('\n').filter(Boolean).length : 0;

  return (
    <div className="space-y-4">
      <Row
        title="Enable file logging"
        desc="Write diagnostic logs to disk to help debug issues. Off by default. Each log is capped at 5 MB (oldest lines are dropped)."
      >
        <Toggle checked={enabled} onChange={(v) => void toggle(v)} />
      </Row>

      {/* Viewer card: header (tabs + actions) above a framed log surface. */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 flex-wrap px-2.5 py-2 border-b border-border bg-muted/30">
          {/* App / Chat segmented control */}
          <div className="inline-flex rounded-md bg-muted/60 p-0.5 text-xs">
            {(['app', 'chat'] as const).map((name) => {
              const f = logs.find((l) => l.name === name);
              const isActive = active === name;
              return (
                <button
                  key={name}
                  onClick={() => setActive(name)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] transition-colors ${
                    isActive
                      ? 'bg-background text-foreground shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {name === 'app' ? 'App' : 'Chat'}
                  {f && f.bytes > 0 ? (
                    <span className="text-[10px] tabular-nums opacity-60">{fmtBytes(f.bytes)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Actions */}
          <div className="ml-auto flex items-center gap-0.5">
            <IconAction title="Refresh" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </IconAction>
            <IconAction title="Copy to clipboard" onClick={() => void handleCopy()}>
              <Copy className="w-3.5 h-3.5" />
            </IconAction>
            <IconAction title="Export to file" onClick={() => void handleExport()}>
              <Download className="w-3.5 h-3.5" />
            </IconAction>
            <IconAction title="Open logs folder" onClick={() => void handleOpenDir()}>
              <FolderOpen className="w-3.5 h-3.5" />
            </IconAction>
            <div className="w-px h-4 bg-border mx-0.5" />
            <IconAction title="Clear this log" onClick={() => void handleClear()} destructive>
              <Trash2 className="w-3.5 h-3.5" />
            </IconAction>
          </div>
        </div>

        {/* Viewer — select-text overrides the app-wide user-select:none so the
            user can highlight/copy individual lines; cursor-text signals it. */}
        {current?.text?.trim() ? (
          <pre className="h-80 overflow-auto p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap wrap-break-word select-text cursor-text bg-background">
            {current.text}
          </pre>
        ) : (
          <div className="h-80 flex flex-col items-center justify-center gap-2 text-center px-6 bg-background">
            <ScrollText className="w-7 h-7 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground max-w-xs">
              {enabled
                ? 'This log is empty. Interact with the app to generate entries, then Refresh.'
                : 'Logging is disabled. Enable it above to start recording diagnostics.'}
            </p>
          </div>
        )}

        {/* Footer: path + line count */}
        {current ? (
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-border bg-muted/30 text-[10px] text-muted-foreground">
            <span className="truncate font-mono" title={current.path}>{current.path}</span>
            <span className="ml-auto shrink-0 tabular-nums">
              {fmtBytes(current.bytes)}{lineCount > 0 ? ` · ${lineCount} lines` : ''}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Compact square icon button for the log toolbar. */
function IconAction({
  title, onClick, disabled, destructive, children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors disabled:opacity-40 ${
        destructive
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
