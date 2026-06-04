import { useSyncExternalStore } from 'react';
import { getAppState, setAppState } from './app-state-store';

export type AppTheme = 'one-dark' | 'latte' | 'monokai' | 'dracula' | 'nord' | 'tokyo-night' | 'github-dark';

/** How a NULL / undefined cell renders in the data grid. */
export type NullDisplay = 'blank' | 'null-text' | 'symbol';

export interface AppSettings {
  // Appearance
  theme: AppTheme;

  // General / data behaviour
  defaultRowLimit: number;        // grid page size for new tabs
  nullDisplay: NullDisplay;       // how NULL renders in the grid
  confirmDestructive: boolean;    // warn before DELETE/UPDATE/DROP
  restoreOnStartup: boolean;      // auto-reconnect pinned tiles on boot

  // Editor (Monaco)
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  editorAutocomplete: boolean;

  // AI
  persistAiApprovals: boolean;    // remember auto-approval flags across restarts
  aiMaxToolIterations: number;    // cap on tool-calling rounds per turn (1–50)
  aiMaxRepeatCalls: number;       // how many identical consecutive tool calls before the loop-guard stops (1–50)
}

const KEY = 'tablerelay:settings:v1';
const OLD_KEY = 'dbtable:settings:v1';

export const DEFAULTS: AppSettings = {
  theme: 'monokai',
  defaultRowLimit: 100,
  nullDisplay: 'blank',
  confirmDestructive: true,
  restoreOnStartup: true,
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: true,
  editorMinimap: false,
  editorAutocomplete: true,
  persistAiApprovals: false,
  aiMaxToolIterations: 50,
  aiMaxRepeatCalls: 50,
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
  } catch {
    const legacy = readLegacyLocalStorage();
    current = legacy ? { ...DEFAULTS, ...legacy } : { ...DEFAULTS };
  }
  hydrated = true;
  emit();
  return current;
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

export function applyTheme(theme: AppTheme): void {
  const el = document.documentElement;
  const isDark = theme !== 'latte';  // latte is the only light theme
  el.classList.toggle('dark', isDark);
  el.setAttribute('data-theme', theme);
}
