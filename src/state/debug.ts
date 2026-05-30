import { useSyncExternalStore } from 'react';

export interface LastClick {
  tag: string;
  id: string;
  classes: string;
  text: string;
  role: string;
  dataAttrs: Record<string, string>;
  path: string;
  timestamp: number;
}

export interface DebugPageState {
  view: 'welcome' | 'workspace';
  activeTabId: string | null;
  activeTabType: string | null;
  activeTabTitle: string | null;
  focusedConnection: string | null;
  focusedDatabase: string | null;
  lastClick: LastClick | null;
}

const INITIAL: DebugPageState = {
  view: 'welcome',
  activeTabId: null,
  activeTabType: null,
  activeTabTitle: null,
  focusedConnection: null,
  focusedDatabase: null,
  lastClick: null,
};

let state: DebugPageState = { ...INITIAL };
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(l => l());

export function setDebugPage(patch: Partial<DebugPageState>) {
  if (!import.meta.env.DEV) return;
  state = { ...state, ...patch };
  notify();
}

export function useDebugPage(): DebugPageState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}

if (import.meta.env.DEV) {
  window.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('[data-dev-debug]')) return;

    const dataAttrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-')) dataAttrs[attr.name] = attr.value;
    }

    const path = e.composedPath()
      .filter((n): n is HTMLElement => n instanceof HTMLElement && !!n.tagName)
      .slice(0, 4)
      .map(n => {
        const id = n.id ? `#${n.id}` : '';
        const cls = n.className && typeof n.className === 'string'
          ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        return `${n.tagName.toLowerCase()}${id}${cls}`;
      })
      .join(' > ');

    setDebugPage({
      lastClick: {
        tag: el.tagName.toLowerCase(),
        id: el.id,
        classes: el.className && typeof el.className === 'string' ? el.className.trim() : '',
        text: (el.textContent ?? '').trim().slice(0, 60),
        role: el.getAttribute('role') ?? '',
        dataAttrs,
        path,
        timestamp: Date.now(),
      },
    });
  }, { capture: true });
}
