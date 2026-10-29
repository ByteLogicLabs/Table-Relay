import { useSyncExternalStore } from 'react';
import { getAppState, setAppState } from './app-state-store';

export type AppTheme = 'one-dark' | 'latte' | 'monokai' | 'dracula' | 'nord' | 'tokyo-night' | 'github-dark';

/** How a NULL / undefined cell renders in the data grid. */
export type NullDisplay = 'blank' | 'null-text' | 'symbol';

/** Behaviour of the connection rail (sidebar 1):
 *  - `auto`: collapsed, expands on hover, collapses on leave (default).
 *  - `expanded`: always expanded.
 *  - `collapsed`: always collapsed (icons only). */
export type RailMode = 'auto' | 'expanded' | 'collapsed';

export const RAIL_MODE_OPTIONS: { value: RailMode; label: string; desc: string }[] = [
  { value: 'auto', label: 'Auto', desc: 'Expand on hover, collapse on leave' },
  { value: 'expanded', label: 'Expanded', desc: 'Always show labels' },
  { value: 'collapsed', label: 'Collapsed', desc: 'Icons only' },
];

/** How hard the AI works per turn. A preset that expands into concrete knobs
 *  (tool-call budget, response length, and — where the provider supports it —
 *  reasoning effort). See `EFFORT_PRESETS`. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'extra_high';

/** Ordered for the slider (index = stop position). */
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'extra_high'];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra_high: 'Extra High',
};

/** Concrete knobs each effort level expands into. `reasoningEffort` is sent
 *  only to providers/models that accept it (others ignore it). */
export interface EffortPreset {
  maxIterations: number;
  maxRepeatCalls: number;
  maxTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high';
}

export const EFFORT_PRESETS: Record<EffortLevel, EffortPreset> = {
  low:        { maxIterations: 6,   maxRepeatCalls: 10, maxTokens: 4096,  reasoningEffort: 'low' },
  medium:     { maxIterations: 25,  maxRepeatCalls: 25, maxTokens: 16384, reasoningEffort: 'medium' },
  high:       { maxIterations: 60,  maxRepeatCalls: 40, maxTokens: 32768, reasoningEffort: 'high' },
  extra_high: { maxIterations: 120, maxRepeatCalls: 60, maxTokens: 64000, reasoningEffort: 'high' },
};

export interface AppSettings {
  // Appearance
  theme: AppTheme;

  // General / data behaviour
  defaultRowLimit: number;        // grid page size for new tabs
  nullDisplay: NullDisplay;       // how NULL renders in the grid
  confirmDestructive: boolean;    // warn before DELETE/UPDATE/DROP
  restoreOnStartup: boolean;      // auto-reconnect pinned tiles on boot
  connectionRailMode: RailMode;   // sidebar 1 behaviour: auto / expanded / collapsed

  // Editor (Monaco)
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  editorAutocomplete: boolean;

  // AI
  aiStreamMode: boolean;          // stream the chat reply token-by-token (default off)
  persistAiApprovals: boolean;    // remember auto-approval flags across restarts
  aiMaxToolIterations: number;    // superseded by aiEffort/EFFORT_PRESETS; kept for back-compat
  aiMaxRepeatCalls: number;       // superseded by aiEffort/EFFORT_PRESETS; kept for back-compat
  aiEffort: EffortLevel;          // how hard the AI works per turn (drives iterations / tokens / reasoning)
}

const KEY = 'tablerelay:settings:v1';
const OLD_KEY = 'dbtable:settings:v1';
// One-time migration markers (kept out of AppSettings so they don't leak into
// settings export/import). See `runMigrations`.
const MIGRATION_KEY = 'tablerelay:settings-migrations:v1';

export const DEFAULTS: AppSettings = {
  theme: 'monokai',
  defaultRowLimit: 100,
  nullDisplay: 'null-text',
  confirmDestructive: true,
  restoreOnStartup: true,
  connectionRailMode: 'auto',
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: true,
  editorMinimap: false,
  editorAutocomplete: true,
  aiStreamMode: false,
  persistAiApprovals: false,
  aiMaxToolIterations: 50,
  aiMaxRepeatCalls: 50,
  aiEffort: 'medium',
};

// ── Module-level state + subscription ──────────────────────────────────────────
// Kept in memory after unlock. Persistence goes through encrypted app_state.

function readLegacyLocalStorage(): Partial<AppSettings> | null {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    if (raw) return JSON.parse(raw) as Partial<AppSettings>;
  } catch { /* noop */ }
  return null;
}

let current: AppSettings = { ...DEFAULTS };
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function loadSettings(): AppSettings {
  return current;
}

export async function hydrateSettings(): Promise<AppSettings> {
  if (hydrated) return current;
  try {
    const stored = await getAppState<Partial<AppSettings>>(KEY);
    if (stored) {
      current = { ...DEFAULTS, ...stored };
    } else {
      const legacy = readLegacyLocalStorage();
      if (legacy) {
        current = { ...DEFAULTS, ...legacy };
        await setAppState(KEY, current);
        try {
          localStorage.removeItem(KEY);
          localStorage.removeItem(OLD_KEY);
        } catch { /* noop */ }
      }
    }
    await runMigrations();
  } catch {
    const legacy = readLegacyLocalStorage();
    current = legacy ? { ...DEFAULTS, ...legacy } : { ...DEFAULTS };
  }
  hydrated = true;
  emit();
  return current;
}

/**
 * Apply one-time, idempotent setting upgrades. Each migration runs at most once
 * (tracked by id in `MIGRATION_KEY`), so a deliberate user choice made *after*
 * the migration is never overwritten.
 */
async function runMigrations(): Promise<void> {
  let done: Record<string, boolean> = {};
  try { done = (await getAppState<Record<string, boolean>>(MIGRATION_KEY)) ?? {}; } catch { /* noop */ }
  let changed = false;

  // Default NULL rendering moved from blank → dimmed "NULL" (TablePlus-style).
  // Flip anyone still on the old 'blank' default so they get it once.
  if (!done.nullTextDefault) {
    if (current.nullDisplay === 'blank') {
      current = { ...current, nullDisplay: 'null-text' };
      void setAppState(KEY, current);
    }
    done.nullTextDefault = true;
    changed = true;
  }

  if (changed) {
    try { await setAppState(MIGRATION_KEY, done); } catch { /* noop */ }
  }
}

export function saveSettings(patch: Partial<AppSettings>): void {
  current = { ...current, ...patch };
  void setAppState(KEY, current);
  emit();
}

export function resetSettings(): void {
  current = { ...DEFAULTS };
  void setAppState(KEY, current);
  emit();
}

/** Reactive accessor — re-renders the caller when any setting changes. */
export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribe, loadSettings);
}

/**
 * localStorage key holding just the theme id, kept as a fast, synchronously
 * readable mirror of the encrypted setting. The inline boot script in
 * `index.html` reads this before first paint to avoid a white flash while the
 * real (encrypted) settings hydrate asynchronously. See [[THEME_BOOT_KEY]].
 */
export const THEME_BOOT_KEY = 'tablerelay:theme';

export function applyTheme(theme: AppTheme): void {
  const el = document.documentElement;
  const isDark = theme !== 'latte';  // latte is the only light theme
  el.classList.toggle('dark', isDark);
  el.setAttribute('data-theme', theme);
  // Mirror to localStorage so the next cold boot can paint the right theme
  // synchronously (the encrypted settings load too late to prevent a flash).
  try { localStorage.setItem(THEME_BOOT_KEY, theme); } catch { /* noop */ }
}
