import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, RefreshCw, Copy, Download, Trash2, FolderOpen, ScrollText, Search, X } from 'lucide-react';
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

// ── Log line parsing ──────────────────────────────────────────────────────────
// The backend writes `[ts] [tag] msg`. We split that into parts so the viewer
// can show a short time, a muted tag, and the message — and color the row red /
// amber when the message reads like an error / warning. Anything that doesn't
// match the shape is shown verbatim, so nothing is ever hidden.

interface ParsedLine {
  raw: string;
  time: string;   // HH:MM:SS (clipped from the timestamp), '' if unparsed
  tag: string;    // '' if unparsed
  msg: string;
  tone: 'error' | 'warn' | 'normal';
}

// `[ts] [tag] msg`. Tolerates an optional legacy severity word (INFO/WARN/…)
// between the timestamp and the tag so old log files still render cleanly.
const LINE_RE = /^\[([^\]]+)\]\s+(?:(?:DEBUG|INFO|WARN|ERROR)\s+)?\[([^\]]+)\]\s?([\s\S]*)$/;

const ERROR_RE = /\b(error|fail(ed|ure)?|panic|threw|exception|cannot|could ?not|denied|aborted|fatal|unavailable)\b/i;
const WARN_RE  = /\b(warn(ing)?|retry|retrying|transient|fallback|falling back|deprecat|skip(ped|ping)?|stuck|recovered)\b/i;

function classify(text: string): ParsedLine['tone'] {
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  return 'normal';
}

// Clip `2026-06-15 10:32:01.204` (or ISO variants) down to `10:32:01`.
function shortTime(ts: string): string {
  const m = /(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}

function parseLine(raw: string): ParsedLine {
  const m = LINE_RE.exec(raw);
  if (m) {
    return { raw, time: shortTime(m[1]), tag: m[2], msg: m[3], tone: classify(m[3]) };
  }
  return { raw, time: '', tag: '', msg: raw, tone: classify(raw) };
}

const TONE_TEXT: Record<ParsedLine['tone'], string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  normal: 'text-foreground/80',
};

/**
 * Logs panel: opt-in file logging for diagnostics (off by default). Lets the
 * user enable/disable, view the app + chat logs, search, copy/export, clear,
 * and reveal the logs folder. Each log file is ring-capped at 5 MB by the
 * backend.
 */
export function LogsSettings() {
  const [enabled, setEnabled] = useState(false);
  const [logs, setLogs] = useState<LogContents[]>([]);
  const [active, setActive] = useState<'app' | 'chat'>('app');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

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

  // Parse the raw tail into structured lines (re-parsed only when the text
  // changes); the search filter runs in a second memo so typing is cheap.
  // Both logs share the `[ts] [tag] msg` shape (chat uses the role as the tag),
  // so the same parser + error/warn coloring applies to each.
  const parsed = useMemo<ParsedLine[]>(() => {
    const text = current?.text ?? '';
    if (!text.trim()) return [];
    return text.replace(/\n+$/, '').split('\n').map(parseLine);
  }, [current?.text]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? parsed.filter((p) => p.raw.toLowerCase().includes(q)) : parsed),
    [parsed, q],
  );

  const totalLines = parsed.length;
  const shownLines = filtered.length;
  const isFiltered = q !== '';

  // Copy/export honor the search so the user can grab just the matching lines.
  const exportText = () => filtered.map((p) => p.raw).join('\n');

  const handleCopy = async () => {
    const text = exportText();
    if (!text) { toast(isFiltered ? 'No lines match the search' : 'Log is empty'); return; }
    await copyText(text);
    toast.success(isFiltered ? `Copied ${filtered.length} matching lines` : 'Log copied to clipboard');
  };

  const handleExport = async () => {
    const text = exportText();
    if (!text) { toast(isFiltered ? 'No lines match the search' : 'Log is empty'); return; }
    try {
      const path = await saveDialog({
        defaultPath: `table-relay-${active}.log`,
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (!path) return;
      await writeTextFile(path, text);
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

  return (
    <div className="space-y-4">
      <Row
        title="Enable file logging"
        desc="Write diagnostic logs to disk to help debug issues. Off by default. Each log is capped at 5 MB (oldest lines are dropped)."
      >
        <Toggle checked={enabled} onChange={(v) => void toggle(v)} />
      </Row>

      {/* Viewer card: tabs + header (search + actions) above a framed surface. */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* App / Chat tab strip. App = operational log, Chat = AI transcript. */}
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border bg-muted/30">
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
        </div>

        {/* Header: search box on the left, actions on the right. */}
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border bg-muted/20">
          <div className="relative flex-1 min-w-32">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search log…"
              className="w-full h-7 pl-7 pr-7 rounded-md bg-background border border-border text-xs outline-none focus:border-primary/50 select-text"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
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
            <IconAction title="Clear log" onClick={() => void handleClear()} destructive>
              <Trash2 className="w-3.5 h-3.5" />
            </IconAction>
          </div>
        </div>

        {/* Viewer — select-text overrides the app-wide user-select:none so the
            user can highlight/copy individual lines; cursor-text signals it.
            Errors are red, warnings amber (inferred from the message). */}
        {filtered.length > 0 ? (
          <div className="h-80 overflow-auto p-3 text-[11px] leading-relaxed font-mono select-text cursor-text bg-background">
            {filtered.map((p, i) => (
              <div key={i} className="flex gap-2 whitespace-pre-wrap wrap-break-word">
                {p.time ? <span className="text-muted-foreground/40 shrink-0 tabular-nums">{p.time}</span> : null}
                {p.tag ? <span className="text-muted-foreground/70 shrink-0">{p.tag}</span> : null}
                <span className={`flex-1 ${TONE_TEXT[p.tone]}`}>{p.tag ? p.msg : p.raw}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-80 flex flex-col items-center justify-center gap-2 text-center px-6 bg-background">
            <ScrollText className="w-7 h-7 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground max-w-xs">
              {totalLines > 0
                ? 'No lines match your search.'
                : enabled
                  ? 'This log is empty. Interact with the app to generate entries, then Refresh.'
                  : 'Logging is disabled. Enable it above to start recording diagnostics.'}
            </p>
          </div>
        )}

        {/* Footer: path + line count (shown / total when searching). */}
        {current ? (
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-border bg-muted/30 text-[10px] text-muted-foreground">
            <span className="truncate font-mono" title={current.path}>{current.path}</span>
            <span className="ml-auto shrink-0 tabular-nums">
              {fmtBytes(current.bytes)}
              {totalLines > 0
                ? ` · ${shownLines < totalLines ? `${shownLines} / ${totalLines}` : totalLines} lines`
                : ''}
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
