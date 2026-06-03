import { useSyncExternalStore } from 'react';

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
}

const KEY = 'tablerelay:settings:v1';

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
  aiMaxToolIterations: 12,
};

// ── Module-level state + subscription ──────────────────────────────────────────
// Read once from localStorage, then kept in memory. Consumers subscribe via
// useSettings() so a change in the dialog applies live without a reload — the
// store was previously read-once, which is why earlier settings only took
// effect on remount.

function read(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch { /* noop */ }
  return { ...DEFAULTS };
}

let current: AppSettings = read();
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

export function saveSettings(patch: Partial<AppSettings>): void {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  emit();
}

export function resetSettings(): void {
  current = { ...DEFAULTS };
  localStorage.setItem(KEY, JSON.stringify(current));
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
