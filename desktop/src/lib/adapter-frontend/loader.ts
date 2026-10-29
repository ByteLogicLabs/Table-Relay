// Omni loader for per-adapter frontend contributions.
//
// Each `src-adapters/<key>/frontend/index.ts` `export default`s an
// `AdapterFrontend`. We pick them all up via Vite's `import.meta.glob`
// at build time — adding a new adapter is a matter of dropping a
// folder into `src-adapters/`, no central registry edit. The glob is
// `eager: true` so the modules are statically imported (tree-shakable
// and synchronous) rather than resolved as async chunks.
//
// `__tests__` folders inside an adapter are intentionally excluded so
// adapter authors can colocate tests without polluting the runtime
// registry.

import type { AdapterFrontend } from './types';

type AdapterModule = { default: AdapterFrontend };

const modules = import.meta.glob<AdapterModule>(
  '../../../src-adapters/*/frontend/index.ts',
  { eager: true },
);

const byKey = new Map<string, AdapterFrontend>();
const byCompletionLanguage = new Map<string, AdapterFrontend>();

for (const [path, mod] of Object.entries(modules)) {
  const frontend = mod.default;
  if (!frontend || typeof frontend !== 'object' || !frontend.key) {
    // eslint-disable-next-line no-console
    console.warn(`[adapter-frontend] ${path} has no valid default export — skipping`);
    continue;
  }
  if (byKey.has(frontend.key)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[adapter-frontend] duplicate adapter key "${frontend.key}" — ${path} ignored`,
    );
    continue;
  }
  byKey.set(frontend.key, frontend);
  for (const lang of frontend.completionLanguages ?? []) {
    if (!byCompletionLanguage.has(lang)) byCompletionLanguage.set(lang, frontend);
  }
}

/** All adapters discovered at build time, keyed by manifest key. */
export const adapterFrontends: ReadonlyMap<string, AdapterFrontend> = byKey;

/** Look up a frontend by adapter key (`"mysql"`, `"postgres"`, …). */
export function getAdapterFrontend(key: string | null | undefined): AdapterFrontend | undefined {
  if (!key) return undefined;
  return byKey.get(key.trim().toLowerCase());
}

/**
 * Look up a frontend that registered the given Monaco language id as a
 * fallback (e.g. `mongo` editor mode without an active connection,
 * Redis's `shell` mode).
 */
export function getAdapterFrontendByLanguage(language: string | null | undefined): AdapterFrontend | undefined {
  if (!language) return undefined;
  return byCompletionLanguage.get(language.trim().toLowerCase());
}
