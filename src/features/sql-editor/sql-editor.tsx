import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, AlignLeft, AlertCircle, Sparkles, Table2, Braces, Copy, Check, Loader2, Lock, Undo2, X } from 'lucide-react';
import Editor, { type OnMount, type Monaco } from '@monaco-editor/react';
import type { IDisposable, editor as MonacoEditorNs } from 'monaco-editor';
import { Button } from '../../components/ui/button';
import { ConnectionProfile } from '../../types';
import { db, isDbError, type StatementResult, type TableStructure } from '../../lib/db';
import { analyzeSelect } from './analyze-select';
import { analyzeMongoFind } from './analyze-mongo';
import { classifyColumn, coerceForColumn, validateEditorValue, dialectFromManifest, type EditorKind } from '../data-grid/editor-kinds';
import { registerQueryCompletion } from '../../lib/query-completion/hooks';
import {
  ensureTableStructure,
  getCachedTableStructure,
  refreshSchemas,
  useConnections,
} from '../../state/connections';
import { formatSql } from '../../lib/format-sql';
import { prefillChat } from '../../state/ai';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { readQueryResultSnapshot, writeQueryResultSnapshot } from '../../state/query-result-cache';
import { toast } from 'sonner';

interface LogQueryOptions {
  source?: 'editor' | 'grid' | 'system';
  durationMs?: number;
  status?: 'ok' | 'error';
  message?: string;
}

interface SqlEditorProps {
  tabId?: string;
  initialQuery?: string;
  connection: ConnectionProfile;
  /**
   * Database to target for this editor — takes priority over
   * `connection.database`. Used for autocomplete default-schema detection.
   */
  defaultSchema?: string;
  onLogQuery?: (statement: string, opts?: LogQueryOptions) => void;
  /**
   * If provided, persists edits back to the owning tab so they survive tab
   * switches and reloads. Without it the editor behaves as a scratchpad.
   */
  onQueryChange?: (query: string) => void;
}

function pickMonacoTheme(): 'app-dark' | 'app-light' {
  // The app itself uses a dark surface as its primary theme, so the editor always
  // ships with the One Dark Pro palette. Light mode remains registered as a
  // fallback for future theming work.
  return 'app-dark';
}

function statementAtCursor(source: string, cursorOffset: number): string {
  const chars = Array.from(source);
  let start = 0;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  let activeStart = 0;
  let activeEnd = chars.length;

  const markSegment = (endExclusive: number) => {
    if (cursorOffset >= start && cursorOffset <= endExclusive) {
      activeStart = start;
      activeEnd = endExclusive;
    }
    start = endExclusive + 1;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;

    if (ch === ';' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      markSegment(i);
    }
  }
  if (start <= chars.length) {
    if (cursorOffset >= start && cursorOffset <= chars.length) {
      activeStart = start;
      activeEnd = chars.length;
    }
  }
  return chars.slice(activeStart, activeEnd).join('').trim();
}

function stripCodeComments(source: string, language: string, commentTags?: string[]): string {
  const fallbackLineTokens = (() => {
    const lang = language.toLowerCase();
    if (lang === 'mongo') return ['//'];
    if (lang === 'shell') return ['#'];
    // SQL-ish (sql/pgsql/...)
    return ['--', '#'];
  })();
  const fallbackBlockPairs: Array<[string, string]> = [['/*', '*/']];
  const configured = (commentTags ?? []).map(t => t.trim()).filter(Boolean);
  const lineTokens = configured
    .filter(t => !t.includes(' '))
    .filter((t, idx, arr) => arr.indexOf(t) === idx);
  const blockPairs = configured
    .filter(t => t.includes(' '))
    .map((t) => {
      const parts = t.split(/\s+/).filter(Boolean);
      return parts.length >= 2 ? [parts[0], parts[1]] as [string, string] : null;
    })
    .filter((v): v is [string, string] => !!v);
  const effectiveLineTokens = lineTokens.length > 0 ? lineTokens : fallbackLineTokens;
  const effectiveBlockPairs = blockPairs.length > 0 ? blockPairs : fallbackBlockPairs;

  const chars = Array.from(source);
  let i = 0;
  let out = '';
  let quote: '\'' | '"' | '`' | null = null;
  let inBlock: [string, string] | null = null;
  let escaped = false;

  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1] ?? '';

    if (inBlock) {
      const [, blockEnd] = inBlock;
      const endChars = Array.from(blockEnd);
      let blockClosed = true;
      for (let k = 0; k < endChars.length; k++) {
        if ((chars[i + k] ?? '') !== endChars[k]) {
          blockClosed = false;
          break;
        }
      }
      if (blockClosed) {
        inBlock = null;
        i += blockEnd.length;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }

    if (quote) {
      out += ch;
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i += 1;
        continue;
      }
      // SQL single-quote escape: '' inside single-quoted string.
      if (quote === '\'' && ch === '\'' && next === '\'') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    let blockCommentMatched = false;
    for (const pair of effectiveBlockPairs) {
      const [blockStart] = pair;
      const startChars = Array.from(blockStart);
      let matches = true;
      for (let k = 0; k < startChars.length; k++) {
        if ((chars[i + k] ?? '') !== startChars[k]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      inBlock = pair;
      i += blockStart.length;
      blockCommentMatched = true;
      break;
    }
    if (blockCommentMatched) continue;

    let lineCommentMatched = false;
    for (const tok of effectiveLineTokens) {
      const a = tok[0];
      const b = tok[1] ?? '';
      if (ch !== a) continue;
      if (b && next !== b) continue;
      // For `--`, mimic SQL behavior: treat as comment only when followed by
      // whitespace (or EOL), so arithmetic like `a--b` is left untouched.
      if (tok === '--') {
        const after = chars[i + 2] ?? '';
        if (after && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r') {
          continue;
        }
      }
      const skip = tok.length;
      i += skip;
      while (i < chars.length && chars[i] !== '\n') i += 1;
      if (i < chars.length && chars[i] === '\n') {
        out += '\n';
        i += 1;
      }
      lineCommentMatched = true;
      break;
    }
    if (lineCommentMatched) continue;

    out += ch;
    i += 1;
  }

  return out;
}

export default function SqlEditor({ tabId, initialQuery = '', connection, defaultSchema, onLogQuery, onQueryChange }: SqlEditorProps) {
  const effectiveSchema = defaultSchema ?? connection.database ?? undefined;
  const manifests = useAdapterManifests();
  const activeManifest = resolveManifest(manifests, connection.driver);
  // Document stores (Mongo) skip the editable-result code path; the SQL
  // dialect of `none` is the canonical signal.
  const isDocumentStore = activeManifest?.capabilities.sqlDialect === 'none';
  // Monaco language id comes straight from the manifest. Adapters that
  // forget to declare one fall back to `"sql"` so basic syntax highlight
  // still works; a real manifest should always set it explicitly.
  const language = activeManifest?.queryEditor?.language?.trim() || 'sql';
  const resultViewModes = activeManifest?.queryEditor?.resultViewModes ?? ['table'];
  const supportsJsonResultView = resultViewModes.includes('json');
  const placeholderHint = useMemo(() => {
    const manifestQueryEditor = activeManifest?.queryEditor;
    const commentPrefix = (language === 'mongo')
      ? '//'
      : (language === 'shell' ? '#' : '--');
    const label = manifestQueryEditor?.label?.trim() || 'Query editor';
    const placeholder = manifestQueryEditor?.placeholder?.trim()
      || (isDocumentStore
        ? (effectiveSchema
          ? 'db.getCollection("users").find({})'
          : 'db.getSiblingDB("your_db").getCollection("users").find({})')
        : 'SELECT * FROM users LIMIT 100;');
    const rawExamples = manifestQueryEditor?.examples ?? [];
    const examples = rawExamples
      .map(s => s.trim())
      .filter(Boolean)
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(s => s !== placeholder)
      .slice(0, 3);
    const fakerTemplate = manifestQueryEditor?.dataFakerTemplate?.trim() ?? '';
    const lines = [
      `${commentPrefix} ${label}`,
      `${commentPrefix} Example: ${placeholder}`,
      ...examples.map((example, i) => `${commentPrefix} Example ${i + 2}: ${example}`),
    ];
    if (fakerTemplate) {
      lines.push(`${commentPrefix} Faker template: ${fakerTemplate}`);
    }
    return lines.join('\n');
  }, [activeManifest, effectiveSchema, isDocumentStore, language]);
  // Start empty by default so the user doesn't have to delete a scaffold
  // before typing. A Monaco content-widget placeholder below renders the
  // scaffold text as a hint when the buffer is empty.
  const [query, setQuery] = useState(initialQuery ?? '');

  // Persist query edits to the owning tab on a short debounce so we don't
  // thrash localStorage on every keystroke. The ref pattern keeps the latest
  // onQueryChange without resetting the timer when the callback identity
  // changes between renders.
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  useEffect(() => {
    if (!onQueryChangeRef.current) return;
    const t = setTimeout(() => {
      onQueryChangeRef.current?.(query);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);
  // All statements returned by the latest run. Rendered as result tabs.
  const seededSnapshot = tabId ? readQueryResultSnapshot(tabId) : null;
  const [resultStatements, setResultStatements] = useState<StatementResult[]>(() => seededSnapshot?.statements ?? []);
  const [runError, setRunError] = useState<string | null>(() => seededSnapshot?.runError ?? null);
  const [activeResultIndex, setActiveResultIndex] = useState(() => seededSnapshot?.activeResultIndex ?? 0);
  const [resultViewMode, setResultViewMode] = useState<'table' | 'json'>(() => seededSnapshot?.resultViewMode ?? 'table');
  const [isExecuting, setIsExecuting] = useState(false);
  // Results pane height — user-resizable via the drag handle on its top edge.
  const [resultsHeight, setResultsHeight] = useState(() => seededSnapshot?.resultsHeight ?? 260);
  const [theme, setTheme] = useState<'app-dark' | 'app-light'>(pickMonacoTheme);
  const jsonResultEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const completionDisposerRef = useRef<IDisposable | null>(null);
  const [editorReadyTick, setEditorReadyTick] = useState(0);
  // Schemas come from the external connections store; we keep a ref that the
  // completion provider reads fresh on each call so late-arriving schemas
  // show up without re-registering the provider.
  const connState = useConnections();
  const schemasRef = useRef(connState.schemasById.get(connection.id) ?? []);
  schemasRef.current = connState.schemasById.get(connection.id) ?? [];
  const defaultSchemaRef = useRef<string | undefined>(effectiveSchema);
  defaultSchemaRef.current = effectiveSchema;

  // Track the app's dark-mode class so Monaco follows the theme switch.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(pickMonacoTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Ref pattern so the Cmd+Enter command (registered once at mount) always
  // invokes the current handleRun. Without this, the command closes over the
  // first render's handleRun and runs against stale state (e.g. the original
  // empty buffer instead of what the user has typed since).
  const handleRunRef = useRef<() => void>(() => {});
  // Direct handle to the Monaco editor instance. Needed so external writes
  // (`write_query_tab` from the AI) can update the buffer in place without
  // a full remount — remounting caused a visible flicker and dropped
  // autocomplete state.
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const handleEditorMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    editorRef.current = editor;
    setEditorReadyTick(t => t + 1);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void handleRunRef.current();
    });
  };

  // Ensure schema metadata is present for autocomplete in query tabs too, not
  // only in the sidebar path.
  useEffect(() => {
    void refreshSchemas(connection.id);
  }, [connection.id]);

  // Register completion provider after Monaco mounts, and re-register whenever
  // the connection/language context changes.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !editorRef.current) return;
    completionDisposerRef.current?.dispose();
    completionDisposerRef.current = registerQueryCompletion({
      monaco,
      adapterKey: activeManifest?.adapter.key,
      language,
      connectionId: connection.id,
      defaultSchema: () => defaultSchemaRef.current,
      getSchemas: () => schemasRef.current,
      getCachedStructure: (schema, table) =>
        getCachedTableStructure(connection.id, schema, table),
      ensureStructure: (schema, table) =>
        ensureTableStructure(connection.id, schema, table),
    });
    return () => {
      completionDisposerRef.current?.dispose();
      completionDisposerRef.current = null;
    };
  }, [editorReadyTick, connection.id, activeManifest?.adapter.key, language]);

  // Sync external `initialQuery` changes into the live Monaco model. Fires
  // when `write_query_tab` bumps `tab.query` on an already-mounted editor.
  // Guards:
  //   - Skip if the buffer already matches (avoids cursor jumps on our own
  //     debounced `onQueryChange` round-trips).
  //   - Use `executeEdits` instead of `setValue` so undo/redo still works
  //     (setValue blows away the undo stack).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const next = initialQuery ?? '';
    if (model.getValue() === next) return;
    const fullRange = model.getFullModelRange();
    editor.executeEdits('external-write', [
      { range: fullRange, text: next, forceMoveMarkers: true },
    ]);
    // Mirror into local React state so the toolbar (Run, Format) sees the
    // new buffer without waiting for Monaco's change event round-trip.
    setQuery(next);
  }, [initialQuery]);

  useEffect(() => {
    if (activeResultIndex >= resultStatements.length) {
      setActiveResultIndex(Math.max(0, resultStatements.length - 1));
    }
  }, [activeResultIndex, resultStatements.length]);

  useEffect(() => {
    if (!supportsJsonResultView && resultViewMode === 'json') {
      setResultViewMode('table');
    }
  }, [supportsJsonResultView, resultViewMode]);
  const activeResult = resultStatements[activeResultIndex] ?? null;

  // ---- Editable result state -------------------------------------------------
  // We support inline editing of a SELECT result when it maps unambiguously to
  // a single base table (see `analyzeSelect`). The user double-clicks a cell,
  // edits, Enter commits to a local pending-edits map keyed by `${rowIdx}|${col}`.
  // Save flushes via `db.updateRows` and re-runs the original SQL to refresh.
  // Mongo doesn't go through this path — its query editor returns documents,
  // not tabular rows tied to a SQL table.
  type ResultAnalysis =
    | { editable: true; schema: string | null; table: string; selectColumns: string[] | null }
    | { editable: false; reason: string };
  const queryAnalysis = useMemo<ResultAnalysis>(() => {
    if (!activeResult || activeResult.error || activeResult.columns.length === 0) {
      return { editable: false, reason: '' };
    }
    if (isDocumentStore) {
      // Mongo's editable shape is `db.<coll>.find(...)` with optional
      // .limit/.skip/.sort tails. We map `collection` → `table` so the
      // downstream pipeline (structure resolution, PK gating, save) is
      // shared with the SQL path. The structure call describes the
      // collection the same way as any table, returning `_id` as PK.
      const m = analyzeMongoFind(activeResult.sql);
      if (m.editable === true) {
        return { editable: true, schema: m.schema, table: m.collection, selectColumns: null };
      } else {
        return { editable: false, reason: m.reason };
      }
    }
    return analyzeSelect(activeResult.sql);
  }, [activeResult, isDocumentStore]);
  // Resolved table structure for the analyzed query, if any. Drives column
  // type classification + primary-key derivation. Cleared when activeResult
  // changes so we don't show stale "editable" state from a different query.
  const [editableStructure, setEditableStructure] = useState<TableStructure | null>(null);
  const [structureError, setStructureError] = useState<string | null>(null);
  // Map: `${rowIdx}|${columnName}` → edited string value. Reset on result change.
  const [pendingResultEdits, setPendingResultEdits] = useState<Record<string, string>>({});
  const [activeResultEdit, setActiveResultEdit] = useState<{ rowIdx: number; col: string; value: string } | null>(null);
  const [isSavingResult, setIsSavingResult] = useState(false);
  // Reset edit state when the result the user is looking at changes — avoid
  // applying edits intended for one query to a different one.
  useEffect(() => {
    setPendingResultEdits({});
    setActiveResultEdit(null);
    setEditableStructure(null);
    setStructureError(null);
  }, [activeResult?.sql, activeResultIndex]);
  useEffect(() => {
    if (!queryAnalysis.editable) return;
    let cancelled = false;
    const schema = queryAnalysis.schema ?? effectiveSchema ?? '';
    if (!schema) {
      setStructureError('No schema/database in scope — qualify the table or pick a database.');
      return;
    }
    setStructureError(null);
    void ensureTableStructure(connection.id, schema, queryAnalysis.table)
      .then(struct => { if (!cancelled) setEditableStructure(struct); })
      .catch(err => {
        if (cancelled) return;
        setStructureError(isDbError(err) ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [queryAnalysis, effectiveSchema, connection.id]);

  // Per-column metadata derived from the resolved table structure.
  // - `kindByColumn` drives the cell editor (text / number / boolean / enum / …).
  // - `pkColumns` is the set of PK columns (read-only in the UI; used to build
  //   the WHERE clause for UPDATE).
  // - `editableColumnSet` is which result columns map back to real base-table
  //   columns. A cell is editable iff its column is in this set AND not a PK.
  const { kindByColumn, pkColumns, editableColumnSet, missingPkColumns } = useMemo(() => {
    if (!activeResult || !editableStructure || !queryAnalysis.editable) {
      return { kindByColumn: {} as Record<string, EditorKind>, pkColumns: new Set<string>(), editableColumnSet: new Set<string>(), missingPkColumns: [] as string[] };
    }
    const kinds: Record<string, EditorKind> = {};
    const dlct = dialectFromManifest(activeManifest?.capabilities);
    for (const c of editableStructure.columns) {
      kinds[c.name] = classifyColumn(c.dataType, c.name, dlct);
    }
    const realCols = new Set(editableStructure.columns.map(c => c.name));
    const editable = new Set<string>();
    for (const col of activeResult.columns) {
      if (realCols.has(col.name)) editable.add(col.name);
    }
    const pks = new Set(editableStructure.primaryKey);
    const resultColNames = new Set(activeResult.columns.map(c => c.name));
    const missingPks = editableStructure.primaryKey.filter(pk => !resultColNames.has(pk));
    return { kindByColumn: kinds, pkColumns: pks, editableColumnSet: editable, missingPkColumns: missingPks };
  }, [activeResult, editableStructure, queryAnalysis.editable]);

  // Final "is the result editable right now" gate — combines static analysis
  // and the structure resolution outcome. The inline editor checks this on
  // every cell to decide whether to allow double-click editing.
  const editableReason: string | null = !queryAnalysis.editable
    ? (queryAnalysis as { reason: string }).reason
    : structureError
      ? `Couldn’t load table info: ${structureError}`
      : !editableStructure
        ? null // still loading — neither editable nor a hard "no"
        : editableStructure.primaryKey.length === 0
          ? 'Table has no primary key — can’t identify rows to update.'
          : missingPkColumns.length > 0
            ? `Result is missing primary-key column${missingPkColumns.length === 1 ? '' : 's'}: ${missingPkColumns.join(', ')}. Add ${missingPkColumns.length === 1 ? 'it' : 'them'} to the SELECT list (or use *) to enable editing.`
            : null;
  const resultIsEditable = queryAnalysis.editable && !!editableStructure && editableReason === null;
  const pendingEditCount = Object.keys(pendingResultEdits).length;

  const handleSaveResultEdits = async () => {
    if (!resultIsEditable || !activeResult || !editableStructure) return;
    if (pendingEditCount === 0) return;
    // Group edits by row.
    const byRow = new Map<number, Record<string, unknown>>();
    for (const [key, value] of Object.entries(pendingResultEdits)) {
      const sep = key.indexOf('|');
      const rowIdx = Number(key.slice(0, sep));
      const col = key.slice(sep + 1);
      if (!editableColumnSet.has(col) || pkColumns.has(col)) continue;
      const bucket = byRow.get(rowIdx) ?? {};
      bucket[col] = coerceForColumn(kindByColumn[col] ?? { kind: 'text' }, value, activeManifest?.capabilities.booleanLiteralFormat ?? 'oneZero');
      byRow.set(rowIdx, bucket);
    }
    if (byRow.size === 0) return;
    setIsSavingResult(true);
    const started = performance.now();
    try {
      let totalCells = 0;
      for (const [rowIdx, changes] of byRow) {
        const row = activeResult.rows[rowIdx];
        if (!row) continue;
        const primaryKey = editableStructure.primaryKey.map(col => {
          const idx = activeResult.columns.findIndex(c => c.name === col);
          return { column: col, value: idx >= 0 ? row[idx] : null };
        });
        await db.updateRows(connection.id, {
          schema: editableStructure.schema,
          table: editableStructure.name,
          primaryKey,
          changes,
        });
        totalCells += Object.keys(changes).length;
      }
      const elapsed = performance.now() - started;
      onLogQuery?.(`update ${byRow.size} row${byRow.size === 1 ? '' : 's'} in ${editableStructure.schema}.${editableStructure.name}`, {
        source: 'editor',
        status: 'ok',
        durationMs: elapsed,
        message: `${totalCells} cell${totalCells === 1 ? '' : 's'} across ${byRow.size} row${byRow.size === 1 ? '' : 's'}`,
      });
      toast.success(`Saved ${totalCells} cell${totalCells === 1 ? '' : 's'} across ${byRow.size} row${byRow.size === 1 ? '' : 's'}`);
      setPendingResultEdits({});
      setActiveResultEdit(null);
      // Re-run the same statement so the user sees server-side state.
      void handleRun(activeResult.sql);
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      onLogQuery?.(`update ${byRow.size} row${byRow.size === 1 ? '' : 's'} in ${editableStructure.schema}.${editableStructure.name}`, {
        source: 'editor',
        status: 'error',
        message: msg,
        durationMs: performance.now() - started,
      });
      toast.error(`Save failed: ${msg}`);
    } finally {
      setIsSavingResult(false);
    }
  };

  // ---- Editable JSON-tree result --------------------------------------------
  // Same model as the table editor above, but the UI surface is a Monaco JSON
  // editor instead of inline cells. The user types directly in the rendered
  // array; we deep-diff each parsed entry against the original row (matched
  // by primary key) and POST only the changed columns through `db.updateRows`.
  const [jsonResultDirty, setJsonResultDirty] = useState(false);
  const [jsonResultError, setJsonResultError] = useState<string | null>(null);
  const [jsonResultSaving, setJsonResultSaving] = useState(false);

  const handleSaveJsonResultEdits = async () => {
    const editor = jsonResultEditorRef.current;
    if (!editor || !resultIsEditable || !activeResult || !editableStructure) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.getValue());
    } catch (e) {
      setJsonResultError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!Array.isArray(parsed)) {
      setJsonResultError('Top-level value must be an array of row objects.');
      return;
    }
    if (parsed.length !== activeResult.rows.length) {
      setJsonResultError(
        `Row count changed (${activeResult.rows.length} → ${parsed.length}). ` +
        `Adding or removing rows isn't supported here — use the table view's insert/delete instead.`,
      );
      return;
    }
    const booleanFormat = activeManifest?.capabilities.booleanLiteralFormat ?? 'oneZero';
    // Build PK lookup: each PK column's index in the result columns. We
    // identify rows by their PK values rather than by position so the user
    // can reorder freely. If any PK column is missing from the result we
    // already block editing upstream via `missingPkColumns`.
    const pkColIndices = editableStructure.primaryKey.map(col => activeResult.columns.findIndex(c => c.name === col));
    const pkKey = (rec: Record<string, unknown>) => JSON.stringify(editableStructure.primaryKey.map(col => rec[col]));
    const originalsByPk = new Map<string, { row: unknown[]; rowIdx: number }>();
    activeResult.rows.forEach((row, rowIdx) => {
      const obj: Record<string, unknown> = {};
      activeResult.columns.forEach((col, idx) => { obj[col.name] = row[idx]; });
      originalsByPk.set(pkKey(obj), { row, rowIdx });
    });
    type Patch = { primaryKey: Array<{ column: string; value: unknown }>; changes: Record<string, unknown> };
    const patches: Patch[] = [];
    const skippedCols = new Set<string>();
    const seenPks = new Set<string>();
    for (let i = 0; i < parsed.length; i++) {
      const edited = parsed[i];
      if (!edited || typeof edited !== 'object' || Array.isArray(edited)) {
        setJsonResultError(`Row ${i} is not an object.`);
        return;
      }
      const editedRec = edited as Record<string, unknown>;
      // Reject rows missing PK columns — without them we can't WHERE.
      for (const pkCol of editableStructure.primaryKey) {
        if (!(pkCol in editedRec)) {
          setJsonResultError(`Row ${i}: missing primary-key column "${pkCol}".`);
          return;
        }
      }
      const lookup = pkKey(editedRec);
      if (seenPks.has(lookup)) {
        setJsonResultError(`Row ${i}: duplicate primary key.`);
        return;
      }
      seenPks.add(lookup);
      const original = originalsByPk.get(lookup);
      if (!original) {
        setJsonResultError(
          `Row ${i}: primary key changed or unknown. Editing the primary key in place isn't supported — delete the row and insert a new one in the table view.`,
        );
        return;
      }
      const changes: Record<string, unknown> = {};
      const keys = new Set<string>([...activeResult.columns.map(c => c.name), ...Object.keys(editedRec)]);
      for (const key of keys) {
        if (pkColumns.has(key)) continue; // PKs already verified equal via pkKey lookup
        if (!editableColumnSet.has(key)) {
          // Result-only column (alias / expression / not in base table). If
          // the user changed it, we can't write it back — silently dropped
          // and reported once.
          const colIdx = activeResult.columns.findIndex(c => c.name === key);
          const before = colIdx >= 0 ? original.row[colIdx] : undefined;
          if (JSON.stringify(editedRec[key]) !== JSON.stringify(before)) {
            skippedCols.add(key);
          }
          continue;
        }
        const colIdx = activeResult.columns.findIndex(c => c.name === key);
        const before = colIdx >= 0 ? original.row[colIdx] : undefined;
        if (JSON.stringify(editedRec[key]) !== JSON.stringify(before)) {
          changes[key] = coerceForColumn(kindByColumn[key] ?? { kind: 'text' }, editedRec[key], booleanFormat);
        }
      }
      if (Object.keys(changes).length === 0) continue;
      const primaryKey = editableStructure.primaryKey.map((col, i2) => ({ column: col, value: original.row[pkColIndices[i2]] }));
      patches.push({ primaryKey, changes });
    }
    if (skippedCols.size > 0) {
      toast.message(`Skipped column${skippedCols.size === 1 ? '' : 's'} not in ${editableStructure.name}: ${Array.from(skippedCols).join(', ')}`);
    }
    if (patches.length === 0) {
      toast.message('No changes to save');
      setJsonResultDirty(false);
      setJsonResultError(null);
      return;
    }
    setJsonResultSaving(true);
    const started = performance.now();
    try {
      let totalCells = 0;
      for (const patch of patches) {
        await db.updateRows(connection.id, {
          schema: editableStructure.schema,
          table: editableStructure.name,
          primaryKey: patch.primaryKey,
          changes: patch.changes,
        });
        totalCells += Object.keys(patch.changes).length;
      }
      const elapsed = performance.now() - started;
      onLogQuery?.(`update ${patches.length} row${patches.length === 1 ? '' : 's'} in ${editableStructure.schema}.${editableStructure.name}`, {
        source: 'editor',
        status: 'ok',
        durationMs: elapsed,
        message: `${totalCells} cell${totalCells === 1 ? '' : 's'} across ${patches.length} row${patches.length === 1 ? '' : 's'}`,
      });
      toast.success(`Saved ${totalCells} cell${totalCells === 1 ? '' : 's'} across ${patches.length} row${patches.length === 1 ? '' : 's'}`);
      setJsonResultDirty(false);
      setJsonResultError(null);
      void handleRun(activeResult.sql);
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      onLogQuery?.(`update ${patches.length} row${patches.length === 1 ? '' : 's'} in ${editableStructure.schema}.${editableStructure.name}`, {
        source: 'editor',
        status: 'error',
        message: msg,
        durationMs: performance.now() - started,
      });
      toast.error(`Save failed: ${msg}`);
    } finally {
      setJsonResultSaving(false);
    }
  };

  // Cmd/Ctrl+S binding — Monaco's `addCommand` captures the handler at bind
  // time, so we route through this ref which the render loop keeps fresh.
  const jsonResultSaveRef = useRef<() => void>(() => {});
  jsonResultSaveRef.current = () => {
    if (jsonResultSaving || jsonResultError || !jsonResultDirty) return;
    void handleSaveJsonResultEdits();
  };
  // ---- end editable result state --------------------------------------------

  const activeRowsAsObjects = useMemo(() => {
    if (!activeResult || activeResult.columns.length === 0) return [] as Record<string, unknown>[];
    return activeResult.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      activeResult.columns.forEach((col, idx) => {
        obj[col.name] = row[idx];
      });
      return obj;
    });
  }, [activeResult]);
  const activeRowsAsJsonText = useMemo(() => JSON.stringify(activeRowsAsObjects, null, 2), [activeRowsAsObjects]);

  // Reset JSON-edit dirty/error whenever the underlying result changes —
  // refresh, re-run, switch result tab, or switch back to JSON view from
  // table. Lives here (not next to the JSON edit state above) because it
  // needs `activeRowsAsJsonText` declared first.
  useEffect(() => {
    setJsonResultDirty(false);
    setJsonResultError(null);
  }, [activeRowsAsJsonText, resultViewMode]);
  const collapseJsonSubtrees = useCallback((editor: MonacoEditorNs.IStandaloneCodeEditor | null) => {
    if (!editor) return;
    requestAnimationFrame(() => {
      // Keep nesting depth <=2 expanded, collapse depth >=3.
      editor.trigger('json-default-fold', 'editor.unfoldAll', null);
      editor.trigger('json-default-fold', 'editor.foldLevel3', null);
      editor.setPosition({ lineNumber: 1, column: 1 });
    });
  }, []);

  useEffect(() => {
    if (resultViewMode !== 'json' || !supportsJsonResultView) return;
    collapseJsonSubtrees(jsonResultEditorRef.current);
  }, [resultViewMode, supportsJsonResultView, activeResultIndex, activeRowsAsJsonText, collapseJsonSubtrees]);

  const handleRun = async (statementOverride?: string) => {
    const payload = stripCodeComments(statementOverride ?? query, language, activeManifest?.queryEditor?.commentTags).trim();
    if (!payload) return;
    setIsExecuting(true);
    try {
      // Adapter/backend owns database scoping now. The editor sends the
      // command exactly as typed — no frontend-injected prefixes.
      const res = await db.runQuery(connection.id, payload);
      for (const stmt of res.statements) {
        onLogQuery?.(stmt.sql, {
          source: 'editor',
          durationMs: stmt.durationMs,
          status: stmt.error ? 'error' : 'ok',
          message: stmt.error ?? undefined,
        });
      }
      setRunError(null);
      setResultStatements(res.statements);
      setActiveResultIndex(Math.max(0, res.statements.length - 1));
    } catch (err) {
      const message = isDbError(err) ? err.message : String(err);
      onLogQuery?.(payload, {
        source: 'editor',
        status: 'error',
        message,
      });
      setResultStatements([]);
      setRunError(message);
      setActiveResultIndex(0);
    } finally {
      setIsExecuting(false);
    }
  };
  handleRunRef.current = () => { void handleRun(); };

  const handleRunCurrent = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      void handleRun();
      return;
    }
    const selection = editor.getSelection();
    const selected = selection ? model.getValueInRange(selection).trim() : '';
    if (selected) {
      void handleRun(selected);
      return;
    }
    const separator = activeManifest?.queryEditor?.statementSeparator;
    if (separator === '\n') {
      const pos = editor.getPosition();
      const line = pos ? model.getLineContent(pos.lineNumber).trim() : '';
      void handleRun(line || query);
      return;
    }
    if (separator === ';' || separator == null) {
      const pos = editor.getPosition();
      const offset = pos ? model.getOffsetAt(pos) : query.length;
      const current = statementAtCursor(query, offset);
      void handleRun(current || query);
      return;
    }
    void handleRun(query);
  };

  const handleFormat = () => {
    if (isDocumentStore) {
      // Mongo path still relies on Monaco's built-in JS formatter.
      monacoRef.current?.editor
        .getEditors()
        .find(() => true)
        ?.getAction('editor.action.formatDocument')
        ?.run();
      return;
    }
    const { formatted, error: err } = formatSql(query);
    if (err) {
      toast.error(`Format failed: ${err}`);
      return;
    }
    setQuery(formatted);
  };

  useEffect(() => {
    if (!tabId) return;
    writeQueryResultSnapshot(tabId, {
      statements: resultStatements,
      runError,
      activeResultIndex,
      resultViewMode,
      resultsHeight,
    });
  }, [tabId, resultStatements, runError, activeResultIndex, resultViewMode, resultsHeight]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="h-12 border-b border-border flex items-center px-4 bg-muted/10 gap-2">
        <Button size="sm" onClick={() => { void handleRun(); }} disabled={isExecuting} className="bg-green-600 hover:bg-green-700 text-white">
          <Play className="w-4 h-4 mr-2" />
          Run All
        </Button>
        <Button variant="outline" size="sm" onClick={handleRunCurrent} disabled={isExecuting}>
          Run Current
        </Button>
        <div className="w-px h-4 bg-border mx-1" />
        <Button variant="ghost" size="sm" onClick={handleFormat}>
          <AlignLeft className="w-4 h-4 mr-2" />
          {isDocumentStore ? 'Format JSON' : 'Format SQL'}
        </Button>
        <div className="ml-auto text-[11px] text-muted-foreground">
          ⌘↵ / Ctrl+↵ to run
        </div>
        <Button
          variant="ghost"
          size="sm"
          title="Ask AI"
          onClick={() => {
            const trimmed = query.trim();
            // If the editor has content, ask AI to explain it; otherwise
            // open Generate mode and focus the chat input.
            if (trimmed.length > 0) {
              prefillChat({ kind: 'explain', sql: trimmed });
            } else {
              prefillChat({ kind: 'generate', focusOnly: true });
            }
          }}
        >
          <Sparkles className="w-4 h-4 mr-2 text-primary" />
          AI
        </Button>
      </div>

      {/* Editor Pane */}
      <div className="flex-1 flex flex-col min-h-50 relative">
        {/* Monaco has no native placeholder; overlay one when the buffer is
            empty so the user sees a hint without needing to delete scaffold
            text first. pointer-events-none lets clicks fall through. */}
        {query === '' && (
          <div className="pointer-events-none absolute left-14 top-3 z-10 text-[13px] text-muted-foreground/50 font-mono whitespace-pre">
            {placeholderHint}
          </div>
        )}
        <Editor
          value={query}
          language={language}
          theme={theme}
          onChange={(v) => setQuery(v ?? '')}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            renderLineHighlight: 'line',
            tabSize: 2,
            automaticLayout: true,
            wordWrap: 'on',
            padding: { top: 12, bottom: 12 },
            fixedOverflowWidgets: true,
            scrollbar: {
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
            guides: { indentation: false },
            wordBasedSuggestions: 'off',
            quickSuggestions: { other: true, comments: false, strings: true },
            suggestOnTriggerCharacters: true,
          }}
        />
      </div>

      {/* Results pane — each executed statement gets its own tab so multi-
          statement runs (`a; b; c`) can be inspected independently. */}
      {(runError || resultStatements.length > 0) && (
        <div
          className="border-t border-border flex flex-col shrink-0 relative"
          style={{ height: resultsHeight }}
        >
          <VerticalResizeHandle
            onResize={(dy) => setResultsHeight(h => Math.max(120, Math.min(900, h - dy)))}
            orientation="top"
          />
          <div className="h-8 border-b border-border bg-muted/30 flex items-center justify-between px-3 text-xs font-medium text-muted-foreground shrink-0 gap-2">
            <div className="min-w-0 truncate">
              {runError
                ? (isDocumentStore ? 'MongoDB Error' : 'Query Error')
                : `Results${activeResult ? ` · ${activeResult.durationMs.toFixed(1)}ms` : ''}`}
            </div>
            {!runError && resultStatements.length > 0 && supportsJsonResultView && (
              <div className="inline-flex items-center gap-1 shrink-0">
                <Button
                  variant={resultViewMode === 'table' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setResultViewMode('table')}
                  title="Table view"
                >
                  <Table2 className="w-3.5 h-3.5 mr-1" />
                  Table
                </Button>
                <Button
                  variant={resultViewMode === 'json' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setResultViewMode('json')}
                  title="JSON view"
                >
                  <Braces className="w-3.5 h-3.5 mr-1" />
                  JSON
                </Button>
              </div>
            )}
          </div>
          {runError && (
            <div className="px-4 py-2 text-xs bg-destructive/10 text-destructive font-mono flex items-start gap-2 border-b border-destructive/30 shrink-0">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="min-w-0 wrap-break-word">{runError}</div>
            </div>
          )}
          {!runError && resultStatements.length > 0 && (
            <div className="h-10 border-b border-border bg-muted/30 shrink-0 flex items-center gap-2 px-2">
              <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
                <div className="h-full inline-flex items-center gap-1 w-max pr-2">
                  {resultStatements.map((stmt, idx) => {
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setActiveResultIndex(idx)}
                        className={`h-8 px-3 rounded-md border text-[11px] whitespace-nowrap transition-colors ${
                          activeResultIndex === idx
                            ? 'bg-background border-border/70 text-foreground shadow-sm'
                            : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60'
                        }`}
                        title={stmt.sql}
                      >
                        Execution {idx + 1}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {!runError && resultStatements[activeResultIndex] && (() => {
            const active = resultStatements[activeResultIndex];
            if (active.error) {
              return (
                <div className="px-4 py-2 text-xs bg-destructive/10 text-destructive font-mono flex items-start gap-2 border-b border-destructive/30 shrink-0">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0 wrap-break-word">{active.error}</div>
                </div>
              );
            }
            if (active.columns.length === 0) {
              return (
                <div className="p-4 text-xs text-muted-foreground">
                  Statement executed successfully.
                  {active.rowsAffected !== null && ` Rows affected: ${active.rowsAffected}.`}
                  {' '}
                  {active.durationMs.toFixed(1)}ms
                </div>
              );
            }
            if (resultViewMode === 'json' && supportsJsonResultView) {
              return (
                <div className="flex-1 min-h-0 flex flex-col relative">
                  {/* Action bar — hidden when clean and editable. Surfaces
                      only on parse error, unsaved changes, or to explain
                      why the result is read-only. */}
                  {(jsonResultError || jsonResultDirty || (!resultIsEditable && editableReason)) && (
                    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background/40 text-xs">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {jsonResultError ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30 font-medium">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            Invalid JSON
                          </span>
                        ) : jsonResultDirty ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                            Unsaved changes
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-muted text-muted-foreground border border-border" title={editableReason ?? ''}>
                            <Lock className="w-3 h-3" />
                            Read-only
                            <span className="text-muted-foreground/70 truncate max-w-[420px]">— {editableReason}</span>
                          </span>
                        )}
                      </div>
                      {jsonResultDirty && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            disabled={jsonResultSaving}
                            onClick={() => {
                              const editor = jsonResultEditorRef.current;
                              if (editor) editor.setValue(activeRowsAsJsonText);
                              setJsonResultDirty(false);
                              setJsonResultError(null);
                            }}
                            title="Discard edits and revert to server state"
                          >
                            <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Discard
                          </Button>
                          <Button
                            variant="default"
                            size="sm"
                            className="h-7"
                            onClick={() => { void handleSaveJsonResultEdits(); }}
                            disabled={jsonResultSaving || !!jsonResultError}
                            title={jsonResultError ? 'Fix JSON errors before saving' : 'Save edited fields to the database'}
                          >
                            {jsonResultSaving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                            {jsonResultSaving ? 'Saving…' : 'Save'}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {jsonResultError && (
                    <div className="shrink-0 px-3 py-2 border-b border-red-500/30 bg-red-500/5 text-xs text-red-600 dark:text-red-400 flex items-start gap-2">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <pre className="whitespace-pre-wrap break-words font-mono leading-snug flex-1 min-w-0">{jsonResultError}</pre>
                      <button
                        type="button"
                        className="shrink-0 text-red-600/70 dark:text-red-400/70 hover:text-red-600 dark:hover:text-red-400 -mr-1 p-0.5"
                        onClick={() => setJsonResultError(null)}
                        title="Dismiss"
                        aria-label="Dismiss error"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  <div className="flex-1 min-h-0">
                    <Editor
                      value={activeRowsAsJsonText}
                      language="json"
                      theme={theme}
                      onMount={(editor, monaco) => {
                        jsonResultEditorRef.current = editor;
                        collapseJsonSubtrees(editor);
                        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                          jsonResultSaveRef.current();
                        });
                      }}
                      onChange={(next) => {
                        if (!resultIsEditable) return;
                        const dirty = (next ?? '') !== activeRowsAsJsonText;
                        setJsonResultDirty(dirty);
                        if (!dirty) {
                          setJsonResultError(null);
                          return;
                        }
                        try {
                          JSON.parse(next ?? '');
                          setJsonResultError(null);
                        } catch (e) {
                          setJsonResultError(e instanceof Error ? e.message : String(e));
                        }
                      }}
                      options={{
                        // Editing is gated on the same logic as the table
                        // view. Non-editable results stay read-only with a
                        // tooltip explanation in the action bar.
                        readOnly: !resultIsEditable || jsonResultSaving,
                        minimap: { enabled: false },
                        fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        fontSize: 13,
                        lineHeight: 20,
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        automaticLayout: true,
                        wordWrap: 'on',
                        padding: { top: 10, bottom: 10 },
                        lineNumbers: 'on',
                        glyphMargin: false,
                        folding: true,
                        foldingStrategy: 'auto',
                        showFoldingControls: 'always',
                      }}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute bottom-3 right-3 z-10 h-8 w-8 rounded-full shadow-sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(jsonResultEditorRef.current?.getValue() ?? activeRowsAsJsonText);
                        toast.success('JSON copied');
                      } catch (e) {
                        toast.error(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
                      }
                    }}
                    title="Copy JSON"
                    aria-label="Copy JSON"
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              );
            }
            return (
              <div className="flex-1 min-h-0 flex flex-col">
                {/* Editable-result status bar — silent when the query is
                    editable and clean (cells stay quietly editable on
                    double-click). Surfaces only when there's something the
                    user needs to know: pending edits to flush, or a hard
                    reason editing is blocked. */}
                {(editableReason || pendingEditCount > 0) && (
                  <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background/40 text-xs">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {pendingEditCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                          {pendingEditCount} unsaved cell{pendingEditCount === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-muted text-muted-foreground border border-border" title={editableReason ?? ''}>
                          <Lock className="w-3 h-3" />
                          Read-only
                          <span className="text-muted-foreground/70 truncate max-w-[420px]">— {editableReason}</span>
                        </span>
                      )}
                    </div>
                    {pendingEditCount > 0 && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          disabled={isSavingResult}
                          onClick={() => {
                            setPendingResultEdits({});
                            setActiveResultEdit(null);
                          }}
                          title="Discard all unsaved cell edits"
                        >
                          <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Discard
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7"
                          onClick={() => { void handleSaveResultEdits(); }}
                          disabled={isSavingResult}
                          title="Save edited cells to the database and re-run the query"
                        >
                          {isSavingResult ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                          {isSavingResult ? 'Saving…' : 'Save'}
                        </Button>
                      </>
                    )}
                  </div>
                )}
                <div className="flex-1 min-h-0 overflow-auto" style={{ maxWidth: 'var(--content-max-w, 100%)' }}>
                  <table className="text-xs text-left border-collapse" style={{ width: 'max-content', minWidth: '100%' }}>
                    <thead className="text-[11px] text-muted-foreground bg-muted sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="w-10 px-2 py-1 border-b border-r border-border font-medium text-center whitespace-nowrap">#</th>
                        {active.columns.map((col, ci) => {
                          const isPk = pkColumns.has(col.name);
                          const isEditableCol = resultIsEditable && editableColumnSet.has(col.name) && !isPk;
                          return (
                            <th
                              key={ci}
                              className="px-2 py-1 border-b border-r border-border font-medium whitespace-nowrap min-w-24"
                              title={
                                isPk ? 'Primary key — read-only'
                                : !resultIsEditable ? undefined
                                : !isEditableCol ? 'Not a base-table column — read-only'
                                : 'Double-click a cell to edit'
                              }
                            >
                              <span className="inline-flex items-center gap-1">
                                {col.name}
                                {isPk && <Lock className="w-3 h-3 text-muted-foreground" />}
                              </span>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {active.rows.map((row, ri) => (
                        <tr key={ri} className="border-b border-border hover:bg-muted/20">
                          <td className="px-2 py-1 border-r border-border text-center text-muted-foreground bg-muted/10 whitespace-nowrap">
                            {ri + 1}
                          </td>
                          {active.columns.map((col, ci) => {
                            const v = row[ci];
                            const baseText = v === null || v === undefined
                              ? 'null'
                              : typeof v === 'object'
                                ? JSON.stringify(v)
                                : String(v);
                            const editKey = `${ri}|${col.name}`;
                            const pendingValue = pendingResultEdits[editKey];
                            const isEdited = pendingValue !== undefined;
                            const isPk = pkColumns.has(col.name);
                            const cellEditable = resultIsEditable && editableColumnSet.has(col.name) && !isPk && !isSavingResult;
                            const isCurrentlyEditing = activeResultEdit?.rowIdx === ri && activeResultEdit?.col === col.name;
                            const displayText = isEdited ? pendingValue : baseText;
                            const kind = kindByColumn[col.name] ?? { kind: 'text' as const };
                            const validationError = isCurrentlyEditing ? validateEditorValue(kind, activeResultEdit.value) : null;
                            const cellClass = isEdited
                              ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
                              : '';
                            return (
                              <td
                                key={ci}
                                className={`p-0 border-r border-border font-mono text-[11px] align-top min-w-24 max-w-80 ${cellClass} ${cellEditable ? 'cursor-text' : ''}`}
                                onDoubleClick={() => {
                                  if (!cellEditable) return;
                                  setActiveResultEdit({ rowIdx: ri, col: col.name, value: isEdited ? pendingValue : (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)) });
                                }}
                                title={
                                  isPk ? 'Primary key — read-only'
                                  : !resultIsEditable ? undefined
                                  : !cellEditable ? 'Not a base-table column — read-only'
                                  : isEdited ? `Was: ${baseText}` : displayText
                                }
                              >
                                {isCurrentlyEditing ? (
                                  <input
                                    autoFocus
                                    className={`w-full px-2 py-1.5 bg-background outline-none ring-1 ring-inset ${validationError ? 'ring-destructive' : 'ring-primary'} font-mono text-[11px]`}
                                    value={activeResultEdit.value}
                                    onChange={(e) => setActiveResultEdit({ ...activeResultEdit, value: e.target.value })}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        if (validationError) return;
                                        const original = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                                        setPendingResultEdits(prev => {
                                          const next = { ...prev };
                                          if (activeResultEdit.value === original) {
                                            delete next[editKey];
                                          } else {
                                            next[editKey] = activeResultEdit.value;
                                          }
                                          return next;
                                        });
                                        setActiveResultEdit(null);
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setActiveResultEdit(null);
                                      }
                                    }}
                                    onBlur={() => {
                                      if (validationError) {
                                        setActiveResultEdit(null);
                                        return;
                                      }
                                      const original = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                                      setPendingResultEdits(prev => {
                                        const next = { ...prev };
                                        if (activeResultEdit.value === original) {
                                          delete next[editKey];
                                        } else {
                                          next[editKey] = activeResultEdit.value;
                                        }
                                        return next;
                                      });
                                      setActiveResultEdit(null);
                                    }}
                                  />
                                ) : (
                                  <div className="px-2 py-1.5 truncate">
                                    {displayText}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {active.rows.length === 0 && (
                        <tr>
                          <td className="px-4 py-3 text-xs text-muted-foreground" colSpan={active.columns.length + 1}>
                            Query returned no rows.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * A 6px drag strip that reports delta-Y to its parent. Placed at the top or
 * bottom edge of a panel; the parent decides whether dragging down means
 * "grow" or "shrink" via the onResize callback (positive dy = cursor moved
 * down). Captures the pointer on mousedown so drags continue even when the
 * cursor briefly leaves the handle.
 */
function VerticalResizeHandle({
  onResize,
  orientation,
}: {
  onResize: (dy: number) => void;
  orientation: 'top' | 'bottom';
}) {
  const startYRef = useRef(0);
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startYRef.current = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startYRef.current;
      startYRef.current = ev.clientY;
      onResize(dy);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <div
      onMouseDown={onDown}
      role="separator"
      aria-orientation="horizontal"
      className={`absolute left-0 right-0 h-1.5 cursor-ns-resize hover:bg-primary/30 active:bg-primary/50 z-20 ${
        orientation === 'top' ? '-top-0.5' : '-bottom-0.5'
      }`}
    />
  );
}
