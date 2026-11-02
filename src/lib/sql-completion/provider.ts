import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditor, languages, IDisposable, IRange } from 'monaco-editor';
import { MYSQL_KEYWORDS, maybeQuoteIdent } from './keywords';
import { snippetsForDialect, type SnippetDialect } from './snippets';
import { analyzeContext, type SqlClause, type SqlReferencedTable } from './context';
import type { SchemaInfo, TableStructure } from '../db';

export interface SqlCompletionOptions {
  connectionId: string;
  /** Monaco language ids to register against (e.g. `sql`, `pgsql`). */
  languageIds?: string[];
  /** Returns the schemas list currently known for this connection. */
  getSchemas: () => SchemaInfo[];
  /** Returns the table's structure if already cached. */
  getCachedStructure: (schema: string, table: string) => TableStructure | undefined;
  /** Kicks off a describe_table fetch (fire-and-forget). Resolving it should
   *  re-trigger the suggest popup so late-arriving columns show up. */
  ensureStructure: (schema: string, table: string) => Promise<TableStructure>;
  /**
   * The default schema to scope completions to. Accepts a static string or a
   * getter so the provider can track the user's focused DB across tab
   * switches without re-registering.
   */
  defaultSchema?: string | (() => string | undefined);
  /** SQL dialect for dialect-specific snippets (e.g. the `ctbl` CREATE TABLE
   *  scaffold). Defaults to MySQL flavour when omitted. */
  dialect?: SnippetDialect;
}

/**
 * Register the Table Relay SQL completion provider on a Monaco instance. The
 * returned disposer unregisters it — call from the editor's unmount path.
 */
export function registerSqlCompletion(
  monaco: Monaco,
  options: SqlCompletionOptions,
): IDisposable {
  const Kind = monaco.languages.CompletionItemKind;
  const SnippetRule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const snippets = snippetsForDialect(options.dialect);

  const provider: languages.CompletionItemProvider = {
    // '.'/'`' open the qualified-name flow; ' ' (space) opens the list right
    // after a clause keyword like `FROM `/`JOIN ` so the user sees table
    // suggestions without having to type a letter first.
    triggerCharacters: ['.', '`', ' '],

    provideCompletionItems(model, position, context) {
      try {
        const buffer = model.getValue();
        const cursorOffset = model.getOffsetAt(position);
        const ctx = analyzeContext(buffer, cursorOffset);

        // When the popup was triggered by a SPACE, only proceed if the word
        // right before the cursor is a clause keyword that introduces a name
        // (FROM/JOIN/INTO/UPDATE) or a comma — i.e. somewhere a suggestion is
        // genuinely wanted. Otherwise return nothing so we don't flash the
        // popup on every space inside an expression or string.
        if (context?.triggerCharacter === ' ') {
          const head = buffer.slice(0, cursorOffset);
          // Last non-space run before the cursor.
          const m = head.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
          const prevWord = m?.[1]?.toUpperCase();
          const wantsName = prevWord
            ? ['FROM', 'JOIN', 'INTO', 'UPDATE'].includes(prevWord)
            : /,\s*$/.test(head); // after a comma in a list
          if (!wantsName) return { suggestions: [] };
        }

        // Effective default schema — priority:
        //   1. A schema the current statement already targets (e.g. `FROM bee_book.books`
        //      means every other table suggestion should list unqualified as if
        //      `bee_book` were the current DB for this statement).
        //   2. Last `USE <db>;` seen before the cursor.
        //   3. The connection's configured default database.
        //   4. When the connection was opened without a default DB, fall back to
        //      the first non-system schema so tables list unqualified in the common
        //      "single-DB workspace" case instead of as `schema.table`.
        const statementSchema = ctx.referencedTables.find(t => t.schema)?.schema;
        const configuredDefault = typeof options.defaultSchema === 'function'
          ? options.defaultSchema()
          : options.defaultSchema;
        // When a default is configured, trust it exclusively — the user picked
        // a database and suggestions should stay inside it. Falling back to
        // `firstSchema` was the bug where "users" from an unrelated DB kept
        // showing up after switching databases.
        const effectiveDefaultSchema = configuredDefault
          ? (statementSchema ?? findLastUse(buffer, cursorOffset) ?? configuredDefault)
          : (statementSchema
              ?? findLastUse(buffer, cursorOffset)
              ?? options.getSchemas().find(s => s.tables.length > 0)?.name);

        const word = model.getWordUntilPosition(position);
        const range: IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const editor = monaco.editor
          .getEditors()
          .find((e: MonacoEditor.ICodeEditor) => e.getModel()?.id === model.id);

        // Resolve referenced-table structures we don't have yet. Fire-and-forget;
        // when they land, retrigger the popup so the late columns appear.
        //
        // CRITICAL: skip the identifier the user is *currently typing*. In a
        // `FROM a` context the parser reports `a` as a referenced table, but
        // it's just an in-progress prefix — fetching its (nonexistent) structure
        // resolves a moment later and fires the retrigger below, which rebuilds
        // the suggest list and snaps the highlighted row back to the top. That
        // was the "flicker → jumps to top, can't arrow-navigate" bug. We only
        // prefetch tables that are NOT the active prefix word.
        const typingWord = ctx.prefix?.trim().toLowerCase();
        const pending: Array<Promise<unknown>> = [];
        for (const t of ctx.referencedTables) {
          // The word being typed isn't a real reference yet — don't fetch it.
          if (typingWord && !t.schema && t.name.toLowerCase() === typingWord) continue;
          const schema = t.schema ?? effectiveDefaultSchema ?? '';
          if (!schema) continue;
          if (!options.getCachedStructure(schema, t.name)) {
            pending.push(
              options.ensureStructure(schema, t.name).catch(() => { /* silent */ }),
            );
          }
        }
        // Only the retrigger when freshly-fetched columns would actually change
        // the list — i.e. a column context (SELECT/WHERE/…) or a qualified
        // `alias.`/`table.` lookup. In a FROM/table-name context the structures
        // don't add suggestions, so retriggering there just rebuilds the popup
        // and resets the user's arrow selection to the top for no benefit.
        const retriggerHelps = !!ctx.qualifier || isColumnClause(ctx.clause);
        if (pending.length > 0 && editor && retriggerHelps) {
          // When every fetch has settled, retrigger the popup so the late
          // columns appear. Hide-then-trigger forces Monaco to re-ask us
          // instead of serving its cached list.
          void Promise.allSettled(pending).then(() => {
            if (!editor.hasTextFocus()) return;
            editor.trigger('sqlCompletion', 'hideSuggestWidget', {});
            editor.trigger('sqlCompletion', 'editor.action.triggerSuggest', {});
          });
        }

        const suggestions: languages.CompletionItem[] = [];

        // Qualified path: `alias.` or `table.` or `schema.` — show columns or tables.
        if (ctx.qualifier) {
          const q = ctx.qualifier;

          // 1) alias match → columns of that aliased table.
          const aliased = ctx.referencedTables.find(
            t => t.alias && t.alias.toLowerCase() === q.toLowerCase(),
          );
          if (aliased) {
            const schema = aliased.schema ?? effectiveDefaultSchema ?? '';
            const struct = schema ? options.getCachedStructure(schema, aliased.name) : undefined;
            if (struct) pushColumns(struct);
            return finalize();
          }

          // 2) table match (without alias) → its columns.
          const tableMatch = ctx.referencedTables.find(
            t => t.name.toLowerCase() === q.toLowerCase(),
          );
          if (tableMatch) {
            const schema = tableMatch.schema ?? effectiveDefaultSchema ?? '';
            const struct = schema ? options.getCachedStructure(schema, tableMatch.name) : undefined;
            if (struct) pushColumns(struct);
            return finalize();
          }

          // 3) schema match → tables in that schema.
          const schema = options.getSchemas().find(s => s.name.toLowerCase() === q.toLowerCase());
          if (schema) {
            for (const t of schema.tables) {
              suggestions.push({
                label: t.name,
                kind: t.kind === 'view' ? Kind.Interface : Kind.Class,
                insertText: ctx.quoted ? t.name : maybeQuoteIdent(t.name),
                detail: t.kind === 'view' ? 'view' : 'table',
                sortText: `0_${t.name}`,
                range,
              });
            }
            return finalize();
          }

          // Unknown qualifier — fall through to general completions.
        }

        // Table-name clauses: FROM / JOIN / UPDATE / INTO.
        if (ctx.clause === 'from' || ctx.clause === 'join' || ctx.clause === 'update' || ctx.clause === 'into') {
          pushTables();
          // Snippets still show up so `sel` etc. remain reachable even here.
          pushSnippets();
          return finalize();
        }

        // Column clauses: SELECT / WHERE / ON / SET / GROUP / ORDER / HAVING.
        if (isColumnClause(ctx.clause)) {
          pushColumnsFromScope();
          pushAliasesAndTables(); // `u.` completions work after typing an alias
          pushKeywords();
          return finalize();
        }

        // Unknown / statement-start → snippets + keywords. Tables don't belong
        // here: a bare identifier at statement start is almost certainly a
        // keyword (SELECT, INSERT, UPDATE, …) or a snippet prefix (`sel`,
        // `ins`, …). Table names only make sense after FROM/JOIN/UPDATE/INTO.
        pushSnippets();
        pushKeywords();
        return finalize();

        // --- helpers ---

        function finalize() {
          return { suggestions };
        }

        function pushSnippets() {
          for (const snip of snippets) {
            suggestions.push({
              label: snip.label,
              kind: Kind.Snippet,
              insertText: snip.body,
              insertTextRules: SnippetRule,
              detail: snip.description,
              sortText: `0_${snip.label}`,
              range,
            });
          }
        }

        function pushKeywords() {
          for (const kw of MYSQL_KEYWORDS) {
            // Keywords are always inserted UPPERCASE (canonical SQL style),
            // regardless of how the user typed the prefix. Label === insertText
            // so the list shows exactly what gets written. `filterText` lets a
            // lowercase prefix (`fr`) still match the uppercase item (`FROM`).
            suggestions.push({
              label: kw,
              kind: Kind.Keyword,
              insertText: kw,
              filterText: kw,
              sortText: `5_${kw}`,
              range,
            });
          }
        }

        function pushTables() {
          // When a default schema is known, list ONLY its tables — that's the
          // user's current database. Showing tables from other schemas here
          // produces noisy duplicates (every DB with a `users` table shows a
          // `users` row). If the user wants another schema, they type
          // `other_schema.` and the qualifier branch handles it.
          //
          // Without a default, fall back to every schema so the user isn't
          // left with empty suggestions.
          const def = effectiveDefaultSchema?.toLowerCase();
          const schemas = options.getSchemas();
          const defaultSchema = def
            ? schemas.find(s => s.name.toLowerCase() === def)
            : undefined;

          const target = defaultSchema ? [defaultSchema] : schemas;
          for (const schema of target) {
            const isDefault = defaultSchema === schema;
            for (const t of schema.tables) {
              const insertBare = ctx.quoted ? t.name : maybeQuoteIdent(t.name);
              const insertFull = ctx.quoted
                ? `${schema.name}\`.\`${t.name}`
                : `${maybeQuoteIdent(schema.name)}.${maybeQuoteIdent(t.name)}`;
              suggestions.push({
                label: t.name,
                kind: t.kind === 'view' ? Kind.Interface : Kind.Class,
                insertText: isDefault ? insertBare : insertFull,
                detail: `${schema.name} · ${t.kind}`,
                sortText: `0_${t.name}`,
                range,
              });
            }
          }
        }

        function pushColumnsFromScope() {
          const scope: Array<{ table: SqlReferencedTable; struct: TableStructure }> = [];
          for (const t of ctx.referencedTables) {
            const schema = t.schema ?? effectiveDefaultSchema ?? '';
            if (!schema) continue;
            const struct = options.getCachedStructure(schema, t.name);
            if (struct) scope.push({ table: t, struct });
          }

          // Count column-name occurrences for ambiguity detection.
          const counts = new Map<string, number>();
          for (const { struct } of scope) {
            for (const c of struct.columns) {
              const k = c.name.toLowerCase();
              counts.set(k, (counts.get(k) ?? 0) + 1);
            }
          }

          for (const { table, struct } of scope) {
            const tablePrefix = table.alias ?? table.name;
            for (const col of struct.columns) {
              const ambiguous = (counts.get(col.name.toLowerCase()) ?? 0) > 1;
              const insertName = ctx.quoted ? col.name : maybeQuoteIdent(col.name);
              const insert = ambiguous
                ? `${maybeQuoteIdent(tablePrefix)}.${insertName}`
                : insertName;
              suggestions.push({
                label: col.name,
                kind: col.isPrimary ? Kind.Property : Kind.Field,
                insertText: insert,
                detail: `${tablePrefix}.${col.name}: ${col.dataType}${col.length ? `(${col.length})` : ''}`,
                documentation: buildColumnDoc(col),
                sortText: `1_${col.name}`,
                range,
              });
            }
          }
        }

        function pushColumns(struct: TableStructure) {
          for (const col of struct.columns) {
            const insert = ctx.quoted ? col.name : maybeQuoteIdent(col.name);
            suggestions.push({
              label: col.name,
              kind: col.isPrimary ? Kind.Property : Kind.Field,
              insertText: insert,
              detail: `${struct.name}.${col.name}: ${col.dataType}${col.length ? `(${col.length})` : ''}`,
              documentation: buildColumnDoc(col),
              sortText: `0_${col.name}`,
              range,
            });
          }
        }

        function pushAliasesAndTables() {
          for (const t of ctx.referencedTables) {
            const labelRaw = t.alias ?? t.name;
            suggestions.push({
              label: labelRaw,
              kind: Kind.Variable,
              insertText: ctx.quoted ? labelRaw : maybeQuoteIdent(labelRaw),
              detail: t.alias ? `alias of ${t.name}` : 'table',
              sortText: `2_${labelRaw}`,
              range,
            });
          }
        }
      } catch (err) {
        console.warn('SQL completion provider failed', err);
        return { suggestions: [] };
      }
    },
  };

  const languageIds = options.languageIds && options.languageIds.length > 0
    ? options.languageIds
    : ['sql'];
  const disposers = languageIds.map(id => monaco.languages.registerCompletionItemProvider(id, provider));
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}

function isColumnClause(clause: SqlClause): boolean {
  return (
    clause === 'select' ||
    clause === 'where' ||
    clause === 'on' ||
    clause === 'set' ||
    clause === 'group' ||
    clause === 'order' ||
    clause === 'having'
  );
}

/** Scan for the last `USE <db>;` before the cursor. */
function findLastUse(buffer: string, cursorOffset: number): string | undefined {
  const head = buffer.slice(0, cursorOffset);
  const re = /\bUSE\s+`?(\w+)`?\s*;?/gi;
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = re.exec(head)) !== null) last = m[1];
  return last;
}

function buildColumnDoc(col: { nullable: boolean; default: string | null; isPrimary: boolean; isUnique: boolean; isForeign: boolean; isIndexed: boolean }): string {
  const bits: string[] = [];
  if (col.isPrimary) bits.push('PK');
  if (col.isUnique) bits.push('UNIQUE');
  if (col.isForeign) bits.push('FK');
  if (col.isIndexed && !col.isPrimary && !col.isUnique) bits.push('INDEXED');
  bits.push(col.nullable ? 'NULL' : 'NOT NULL');
  if (col.default !== null) bits.push(`DEFAULT ${col.default}`);
  return bits.join(' · ');
}

// Re-export so callers can pass the Monaco editor type around without importing
// from 'monaco-editor' everywhere.
export type { MonacoEditor };
