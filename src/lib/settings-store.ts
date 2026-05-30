export type AppTheme = 'one-dark' | 'latte' | 'monokai' | 'dracula' | 'nord' | 'tokyo-night' | 'github-dark';

export interface AppSettings {
  theme: AppTheme;
}

const KEY = 'dbtable:settings:v1';
const DEFAULTS: AppSettings = { theme: 'one-dark' };

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch { /* noop */ }
  return { ...DEFAULTS };
}

export function saveSettings(patch: Partial<AppSettings>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...loadSettings(), ...patch }));
}

export function applyTheme(theme: AppTheme): void {
  const el = document.documentElement;
  const isDark = theme !== 'latte';  // latte is the only light theme
  el.classList.toggle('dark', isDark);
  el.setAttribute('data-theme', theme);
}
