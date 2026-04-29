import type { IDisposable } from 'monaco-editor';
import { registerSqlCompletion } from '../sql-completion/provider';
import type { QueryCompletionHookContext } from './hooks';

export function registerSharedSqlCompletion(ctx: QueryCompletionHookContext): IDisposable {
  return registerSqlCompletion(ctx.monaco, {
    connectionId: ctx.connectionId,
    languageIds: [ctx.language],
    defaultSchema: ctx.defaultSchema,
    getSchemas: ctx.getSchemas,
    getCachedStructure: ctx.getCachedStructure,
    ensureStructure: ctx.ensureStructure,
  });
}

