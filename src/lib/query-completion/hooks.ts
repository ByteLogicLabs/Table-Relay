import type { Monaco } from '@monaco-editor/react';
import type { IDisposable } from 'monaco-editor';
import type { SchemaInfo, TableStructure } from '../db';
import {
  getAdapterFrontend,
  getAdapterFrontendByLanguage,
} from '../adapter-frontend/loader';

export interface QueryCompletionHookContext {
  monaco: Monaco;
  adapterKey?: string;
  language: string;
  connectionId: string;
  getSchemas: () => SchemaInfo[];
  defaultSchema?: string | (() => string | undefined);
  getCachedStructure: (schema: string, table: string) => TableStructure | undefined;
  ensureStructure: (schema: string, table: string) => Promise<TableStructure>;
}

/**
 * Autocomplete hook dispatcher.
 *
 * Resolution order:
 *   1. The active connection's adapter frontend (matched by `adapterKey`).
 *   2. An adapter that registered the editor's language as a fallback
 *      (e.g. `mongo` editor mode without an active connection,
 *      Redis's `shell` mode).
 *   3. No completion provider.
 *
 * Per-adapter completion logic now lives in
 * `src-adapters/<key>/frontend/index.ts`; the omni loader
 * (`src/lib/adapter-frontend/loader.ts`) discovers them via
 * `import.meta.glob`, so new adapters self-register without editing
 * this file.
 */
export function registerQueryCompletion(ctx: QueryCompletionHookContext): IDisposable | null {
  const direct = getAdapterFrontend(ctx.adapterKey);
  if (direct?.registerQueryCompletion) return direct.registerQueryCompletion(ctx);
  const byLang = getAdapterFrontendByLanguage(ctx.language);
  if (byLang?.registerQueryCompletion) return byLang.registerQueryCompletion(ctx);
  return null;
}
