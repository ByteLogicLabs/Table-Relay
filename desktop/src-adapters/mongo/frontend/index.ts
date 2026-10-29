import type { IDisposable } from 'monaco-editor';
import type { AdapterFrontend } from '../../../src/lib/adapter-frontend/types';
import type { QueryCompletionHookContext } from '../../../src/lib/query-completion/hooks';
import { registerMongoCompletion } from './completion-provider';

function register(ctx: QueryCompletionHookContext): IDisposable {
  return registerMongoCompletion(ctx.monaco, {
    connectionId: ctx.connectionId,
    defaultSchema: ctx.defaultSchema,
    getSchemas: ctx.getSchemas,
  });
}

const frontend: AdapterFrontend = {
  key: 'mongo',
  registerQueryCompletion: register,
  // Also handle the bare `mongo` editor language (e.g. when the user
  // opens a scratch tab with no active connection).
  completionLanguages: ['mongo'],
};

export default frontend;
