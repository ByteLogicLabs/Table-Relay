import type { IDisposable } from 'monaco-editor';
import { registerSqlCompletion } from '../sql-completion/provider';
import type { QueryCompletionHookContext } from './hooks';

export function registerSharedSqlCompletion(ctx: QueryCompletionHookContext): IDisposable {
  // Prefer the explicit dialect; fall back to the adapter key, which for the
  // SQL adapters is already `mysql` / `postgres` / `sqlite`.
  const dialect = ctx.dialect ?? ctx.adapterKey;
  return registerSqlCompletion(ctx.monaco, {
    connectionId: ctx.connectionId,
    languageIds: [ctx.language],
    defaultSchema: ctx.defaultSchema,
    dialect,
    getSchemas: ctx.getSchemas,
    getCachedStructure: ctx.getCachedStructure,
    ensureStructure: ctx.ensureStructure,
  });
}

