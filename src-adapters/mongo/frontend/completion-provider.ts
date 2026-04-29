import type { Monaco } from '@monaco-editor/react';
import type { IDisposable, IRange, languages } from 'monaco-editor';
import type { SchemaInfo } from '../../../src/lib/db';

export interface MongoCompletionOptions {
  connectionId: string;
  getSchemas: () => SchemaInfo[];
  defaultSchema?: string | (() => string | undefined);
}

const MONGO_KEYWORDS = [
  'db',
  'db.getCollection',
  'db.getSiblingDB',
  'find',
  'findOne',
  'countDocuments',
  'aggregate',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'createIndex',
  'sort',
  'limit',
  'skip',
  'project',
];

function ensureMongoLanguage(monaco: Monaco): void {
  const exists = monaco.languages.getLanguages().some(l => l.id === 'mongo');
  if (exists) return;
  monaco.languages.register({ id: 'mongo' });
  monaco.languages.setLanguageConfiguration('mongo', {
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}

export function registerMongoCompletion(
  monaco: Monaco,
  options: MongoCompletionOptions,
): IDisposable {
  ensureMongoLanguage(monaco);
  const Kind = monaco.languages.CompletionItemKind;
  const SnippetRule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

  const provider: languages.CompletionItemProvider = {
    triggerCharacters: ['.', '"', "'", '('],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const defaultSchema = typeof options.defaultSchema === 'function'
        ? options.defaultSchema()
        : options.defaultSchema;
      const schemas = options.getSchemas();
      const preferred = defaultSchema
        ? schemas.find(s => s.name.toLowerCase() === defaultSchema.toLowerCase())
        : undefined;
      const activeSchemas = preferred ? [preferred] : schemas;
      const collections = activeSchemas.flatMap(s =>
        s.tables.map(t => ({ schema: s.name, name: t.name })),
      );
      const buildCollectionExpr = (schemaName: string, collectionName: string) => {
        const escapedSchema = schemaName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const escapedCollection = collectionName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        if (defaultSchema) return `db.getCollection("${escapedCollection}")`;
        return `db.getSiblingDB("${escapedSchema}").getCollection("${escapedCollection}")`;
      };

      const suggestions: languages.CompletionItem[] = [];

      for (const kw of MONGO_KEYWORDS) {
        suggestions.push({
          label: kw,
          kind: Kind.Keyword,
          insertText: kw,
          sortText: `2_${kw}`,
          range,
        });
      }

      suggestions.push(
        {
          label: 'find',
          kind: Kind.Snippet,
          insertText: defaultSchema
            ? 'db.getCollection("${1:collection}").find(${2:{}})'
            : 'db.getSiblingDB("${1:database}").getCollection("${2:collection}").find(${3:{}})',
          insertTextRules: SnippetRule,
          detail: 'Mongo find',
          sortText: '0_find',
          range,
        },
        {
          label: 'aggregate',
          kind: Kind.Snippet,
          insertText: defaultSchema
            ? 'db.getCollection("${1:collection}").aggregate([\\n  ${2:// stage}\\n])'
            : 'db.getSiblingDB("${1:database}").getCollection("${2:collection}").aggregate([\\n  ${3:// stage}\\n])',
          insertTextRules: SnippetRule,
          detail: 'Mongo aggregate',
          sortText: '0_aggregate',
          range,
        },
        {
          label: 'updateOne',
          kind: Kind.Snippet,
          insertText: defaultSchema
            ? 'db.getCollection("${1:collection}").updateOne(${2:{}}, ${3:{$set: {}}})'
            : 'db.getSiblingDB("${1:database}").getCollection("${2:collection}").updateOne(${3:{}}, ${4:{$set: {}}})',
          insertTextRules: SnippetRule,
          detail: 'Mongo updateOne',
          sortText: '0_updateOne',
          range,
        },
      );

      const expectsCollectionName =
        /db\.(getCollection|getSiblingDB)\(\s*["']?[^"']*$/i.test(before)
        || /db\.\s*$/i.test(before);

      if (expectsCollectionName || /db\.getCollection\(\s*["'][^"']*$/i.test(before)) {
        for (const c of collections) {
          suggestions.push({
            label: c.name,
            kind: Kind.Class,
            insertText: c.name,
            detail: c.schema,
            sortText: `1_${c.schema}.${c.name}`,
            range,
          });
        }
      } else {
        for (const c of collections) {
          suggestions.push({
            label: defaultSchema ? `db.${c.name}` : `db.${c.schema}.${c.name}`,
            kind: Kind.Class,
            insertText: buildCollectionExpr(c.schema, c.name),
            detail: 'collection',
            sortText: `1_${c.schema}.${c.name}`,
            range,
          });
        }
      }

      return { suggestions };
    },
  };

  return monaco.languages.registerCompletionItemProvider('mongo', provider);
}
