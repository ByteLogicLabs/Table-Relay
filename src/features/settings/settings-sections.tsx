import { Check } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { type AppSettings, type AppTheme, saveSettings } from '../../lib/settings-store';
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
