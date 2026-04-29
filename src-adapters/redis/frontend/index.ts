import type { IDisposable, IRange, languages } from 'monaco-editor';
import type { AdapterFrontend } from '../../../src/lib/adapter-frontend/types';
import type { QueryCompletionHookContext } from '../../../src/lib/query-completion/hooks';

const REDIS_COMMANDS = [
  'GET',
  'SET',
  'DEL',
  'EXISTS',
  'TTL',
  'EXPIRE',
  'INCR',
  'HGET',
  'HSET',
  'HGETALL',
  'LPUSH',
  'RPUSH',
  'LRANGE',
  'SADD',
  'SMEMBERS',
  'ZADD',
  'ZRANGE',
  'XADD',
  'XRANGE',
  'SCAN',
  'PUBLISH',
  'SUBSCRIBE',
  'PSUBSCRIBE',
];

function register(ctx: QueryCompletionHookContext): IDisposable {
  const Kind = ctx.monaco.languages.CompletionItemKind;
  const provider: languages.CompletionItemProvider = {
    triggerCharacters: [' ', ':'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: languages.CompletionItem[] = [];
      for (const command of REDIS_COMMANDS) {
        suggestions.push({
          label: command,
          kind: Kind.Keyword,
          insertText: command,
          detail: 'Redis command',
          sortText: `0_${command}`,
          range,
        });
      }

      // Redis sidebar exposes virtual tables per type (`strings`, `hashes`,
      // `lists`, ...). Suggest those names as scoped hints too.
      for (const schema of ctx.getSchemas()) {
        for (const table of schema.tables) {
          suggestions.push({
            label: `${schema.name}.${table.name}`,
            kind: Kind.Class,
            insertText: table.name,
            detail: `Redis ${table.kind}`,
            sortText: `1_${schema.name}.${table.name}`,
            range,
          });
        }
      }

      return { suggestions };
    },
  };

  return ctx.monaco.languages.registerCompletionItemProvider(ctx.language, provider);
}

const frontend: AdapterFrontend = {
  key: 'redis',
  registerQueryCompletion: register,
  // Old `languageHooks.set('shell', ...)` — Redis editor mode is `shell`.
  completionLanguages: ['shell'],
};

export default frontend;
