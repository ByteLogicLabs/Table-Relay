import type { Monaco } from '@monaco-editor/react';
import type { editor, IDisposable, languages } from 'monaco-editor';
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
  /** SQL dialect of the active connection, for dialect-aware completions
   *  (snippets, etc.). Falls back to the adapter key when omitted. */
  dialect?: 'mysql' | 'postgres' | 'sqlite' | 'generic' | 'none' | string;
  getSchemas: () => SchemaInfo[];
  defaultSchema?: string | (() => string | undefined);
  getCachedStructure: (schema: string, table: string) => TableStructure | undefined;
  ensureStructure: (schema: string, table: string) => Promise<TableStructure>;
  /** The editor model this registration serves. Monaco providers are global
   *  per language, so with one registration per open query tab every
   *  keystroke ran every tab's provider — N full analyses, structure fetches
   *  for other connections, and their tables mixed into this tab's list. */
  ownsModel?: (model: editor.ITextModel) => boolean;
}

/** `monaco` whose completion providers answer only for models `owns` accepts.
 *  Everything else passes through to the real namespace. */
function scopedMonaco(monaco: Monaco, owns: (model: editor.ITextModel) => boolean): Monaco {
  const registerCompletionItemProvider = (
    languageSelector: Parameters<Monaco['languages']['registerCompletionItemProvider']>[0],
    provider: languages.CompletionItemProvider,
  ) => {
    const scoped: languages.CompletionItemProvider = Object.create(provider, {
      provideCompletionItems: {
        value: (model: editor.ITextModel, ...rest: unknown[]) =>
          owns(model)
            ? (provider.provideCompletionItems as (...a: unknown[]) => unknown).call(provider, model, ...rest)
            : { suggestions: [] },
      },
    });
    return monaco.languages.registerCompletionItemProvider(languageSelector, scoped);
  };
  const scopedLanguages = Object.create(monaco.languages, {
    registerCompletionItemProvider: { value: registerCompletionItemProvider },
  });
  return Object.create(monaco, { languages: { value: scopedLanguages } });
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
  if (ctx.ownsModel) ctx = { ...ctx, monaco: scopedMonaco(ctx.monaco, ctx.ownsModel) };
  const direct = getAdapterFrontend(ctx.adapterKey);
  if (direct?.registerQueryCompletion) return direct.registerQueryCompletion(ctx);
  const byLang = getAdapterFrontendByLanguage(ctx.language);
  if (byLang?.registerQueryCompletion) return byLang.registerQueryCompletion(ctx);
  return null;
}
