import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, FastForward, AlignLeft, AlertCircle, Sparkles, Table2, Braces, Copy, Check, Loader2, Lock, Undo2, X, Download, Square } from 'lucide-react';
import Editor, { type OnMount, type Monaco } from '@monaco-editor/react';
import type { IDisposable, editor as MonacoEditorNs } from 'monaco-editor';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { serializeResult, defaultFileName, type ResultExportFormat } from './export-result';
import { ConnectionProfile } from '../../types';
import { db, isDbError, type StatementResult, type TableStructure } from '../../lib/db';
import { analyzeSelect } from './analyze-select';
import { analyzeMongoFind } from './analyze-mongo';
import { analyzeDestructive, type DestructiveStatement } from './analyze-destructive';
import { DestructiveWarningDialog } from './destructive-warning-dialog';
import { classifyColumn, coerceForColumn, validateEditorValue, dialectFromManifest, type EditorKind } from '../data-grid/editor-kinds';
import { truncateForCell, CELL_MAX_RENDER_CHARS } from '../data-grid/data-grid-utils';
import { registerQueryCompletion } from '../../lib/query-completion/hooks';
import {
  ensureTableStructure,
  getCachedTableStructure,
  refreshSchemas,
  useConnections,
} from '../../state/connections';
import { formatSql, languageForDialect } from '../../lib/format-sql';
import { useSettings } from '../../lib/settings-store';
import { prefillChat } from '../../state/ai';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { readQueryResultSnapshot, writeQueryResultSnapshot } from '../../state/query-result-cache';
import { toast } from 'sonner';
import {
  pickMonacoTheme,
  formatElapsed,
  RUN_SHORTCUT,
  RUN_ALL_SHORTCUT,
  IS_MAC,
  statementAtCursor,
  stripCodeComments,
  EDITOR_FONT_FAMILY,
} from './sql-editor-utils';
import { VerticalResizeHandle } from './sql-editor-resize-handle';
import { lintSql } from './sql-lint';
import { pageableSelect, buildPagedSql } from './query-paging';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { copyText } from '../../lib/clipboard';
import { listen } from '@tauri-apps/api/event';

interface LogQueryOptions {
  source?: 'editor' | 'grid' | 'system';
  durationMs?: number;
  status?: 'ok' | 'error';
  message?: string;
}

interface SqlEditorProps {
  tabId?: string;
  /**
   * Whether this tab is the visible/active one. Query tabs stay mounted while
   * hidden, so window-level shortcuts (Save/Load) gate on this to avoid every
   * mounted editor reacting to the same keypress.
   */
  isActive?: boolean;
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

export default function SqlEditor({ tabId, isActive = true, initialQuery = '', connection, defaultSchema, onLogQuery, onQueryChange }: SqlEditorProps) {
  const settings = useSettings();
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
  // Path of the file this buffer is bound to (set on Save As or Load). Cmd+S
  // writes back here silently; with none set it falls back to a Save As dialog.
  const [savedFilePath, setSavedFilePath] = useState<string | null>(null);

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
  // While statements stream in we auto-advance to the newest result, but the
  // moment the user clicks a specific Execution tab we stop following so their
  // selection sticks. Reset on each new run.
  const userPickedResultRef = useRef(false);
  const [resultViewMode, setResultViewMode] = useState<'table' | 'json'>(() => seededSnapshot?.resultViewMode ?? 'table');
  const [isExecuting, setIsExecuting] = useState(false);
  // Live elapsed time (ms) while a query runs, so the results pane can show a
  // ticking timer instead of going blank. Driven by a rAF loop in the effect
  // below; reset to 0 between runs.
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const runStartRef = useRef(0);
  // Destructive warning dialog state
  const [destructiveWarning, setDestructiveWarning] = useState<DestructiveStatement[] | null>(null);
  const pendingRunRef = useRef<string | null>(null);
  // Results pane height — user-resizable via the drag handle on its top edge.
  const [resultsHeight, setResultsHeight] = useState(() => seededSnapshot?.resultsHeight ?? 260);
  const [theme, setTheme] = useState<string>(pickMonacoTheme);
  const [filterSearchText, setFilterSearchText] = useState('');

  // ── Auto-paging state ──────────────────────────────────────────────────────
  // When the user runs a plain SELECT (no LIMIT of its own), we transparently
  // wrap it with LIMIT/OFFSET and expose pager controls. `pagedStmt` holds the
  // bare SELECT we're paging (null when the last run wasn't pageable, e.g. a
  // non-SELECT, multi-statement run, or a query with its own LIMIT).
  const [pagedStmt, setPagedStmt] = useState<string | null>(null);
  const [page, setPage] = useState(0); // 0-based
  // Page size seeds from the app's default row limit; the user can change it in
  // the pager and it sticks for this editor session.
  const [pageSize, setPageSize] = useState<number>(() => settings.defaultRowLimit || 100);
  // Whether a next page likely exists — derived from the +1 sentinel row trick
  // (we fetch pageSize+1 and trim the extra). Reset each run.
  const [hasNextPage, setHasNextPage] = useState(false);
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

  // Tick the live "Running…" timer while a query executes. We use rAF rather
  // than setInterval so the displayed elapsed time stays smooth and stops
  // immediately on completion; the final authoritative duration comes from the
  // result's `durationMs` once the run resolves.
  useEffect(() => {
    if (!isExecuting) return;
    let raf = 0;
    const tick = () => {
      setRunElapsedMs(performance.now() - runStartRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isExecuting]);

  // Track the app's dark-mode class so Monaco follows the theme switch.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(pickMonacoTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Ref pattern so the Cmd+Enter command (registered once at mount) always
  // invokes the current handleRun. Without this, the command closes over the
  // first render's handleRun and runs against stale state (e.g. the original
  // empty buffer instead of what the user has typed since).
  const handleRunRef = useRef<() => void>(() => {});
  // Same ref pattern for the run-all command (Cmd/Ctrl+Shift+Enter).
  const handleRunAllRef = useRef<() => void>(() => {});
  // Same ref pattern for Save (Cmd/Ctrl+S) and Load (Cmd/Ctrl+I) the query
  // buffer to/from a file. Kept fresh below so the mount-time commands always
  // see the current handlers and editor state.
  const handleSaveQueryRef = useRef<() => void>(() => {});
  const handleSaveAsQueryRef = useRef<() => void>(() => {});
  const handleLoadQueryRef = useRef<() => void>(() => {});
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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      void handleRunAllRef.current();
    });
    // Save (Cmd/Ctrl+S) and Load (Cmd/Ctrl+I) are handled by a window-level
    // capture listener below so they also work when focus is outside Monaco.
  };

  // Ensure schema metadata is present for autocomplete in query tabs too, not
  // only in the sidebar path. If the sidebar already loaded the tree, reuse it
  // — refetching on every query-tab open made the visible table list flash a
  // reload. Only fetch when nothing is cached yet.
  useEffect(() => {
    const hasCache = (connState.schemasById.get(connection.id)?.length ?? 0) > 0;
    if (hasCache) return;
    void refreshSchemas(connection.id);
    // Intentionally keyed only on connection.id: we want this to run once per
    // connection switch, not on every schema-store mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      dialect: dialectFromManifest(activeManifest?.capabilities),
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

  // Live offline syntax lint — squiggle obvious mistakes (misspelled keywords,
  // unclosed quotes/parens) as the user types, without a DB round-trip. Runs on
  // a short debounce so it doesn't fire on every keystroke, and writes Monaco
  // markers onto the model (the source 'sql-lint' lets us own/replace them).
  // Document stores are skipped inside lintSql (mongo grammar differs).
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const t = setTimeout(() => {
      const found = lintSql(query, language);
      monaco.editor.setModelMarkers(
        model,
        'sql-lint',
        found.map(mk => ({
          startLineNumber: mk.startLineNumber,
          startColumn: mk.startColumn,
          endLineNumber: mk.endLineNumber,
          endColumn: mk.endColumn,
          message: mk.message,
          severity: mk.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
        })),
      );
    }, 250);
    return () => clearTimeout(t);
    // editorReadyTick ensures we (re)lint once the editor finishes mounting.
  }, [query, language, editorReadyTick]);

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
    setFilterSearchText('');
  }, [activeResult?.sql, activeResultIndex]);

  const filteredRows = useMemo(() => {
    if (!activeResult || !activeResult.rows) return [];
    const rowsWithIdx = activeResult.rows.map((row, idx) => ({ row, idx }));
    if (!filterSearchText.trim()) return rowsWithIdx;
    const term = filterSearchText.toLowerCase();
    return rowsWithIdx.filter(({ row }) =>
      row.some(val => {
        if (val === null || val === undefined) return false;
        if (typeof val === 'object') {
          return JSON.stringify(val).toLowerCase().includes(term);
        }
        return String(val).toLowerCase().includes(term);
      })
    );
  }, [activeResult?.rows, filterSearchText]);
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
    const rows = filteredRows.map(x => x.row);
    return rows.map((row) => {
      const obj: Record<string, unknown> = {};
      activeResult.columns.forEach((col, idx) => {
        obj[col.name] = row[idx];
      });
      return obj;
    });
  }, [activeResult, filteredRows]);
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

  // Low-level run: executes exactly `sqlToRun` and streams results into state.
  // When `pagedFetchSize` is given (the page's LIMIT, i.e. pageSize+1), the
  // single result is trimmed to `pageSize` and `hasNextPage` is set from whether
  // the sentinel row came back. `logSql` is what we surface in the query log
  // (the user's original SQL, not the LIMIT-wrapped form).
  const runSql = async (
    sqlToRun: string,
    opts: { pagedFetchSize?: number } = {},
  ) => {
    runStartRef.current = performance.now();
    setRunElapsedMs(0);
    setIsExecuting(true);
    setResultStatements([]);
    setRunError(null);
    setActiveResultIndex(0);
    userPickedResultRef.current = false;

    const paging = opts.pagedFetchSize != null;
    const collected: StatementResult[] = [];

    // For a paged run, trim the +1 sentinel row off a result before it reaches
    // the UI, and record whether it existed (→ there's a next page).
    const finalizePaged = (s: StatementResult): StatementResult => {
      if (!paging || s.error) return s;
      const fetchSize = opts.pagedFetchSize!;
      const over = s.rows.length >= fetchSize; // got the sentinel → more rows
      setHasNextPage(over);
      if (over) return { ...s, rows: s.rows.slice(0, fetchSize - 1) };
      return s;
    };

    try {
      const finalResult = await db.runQueryStream(
        connection.id,
        sqlToRun,
        (s) => {
          collected.push(finalizePaged(s));
          // Log the ACTUAL executed SQL (including any auto-added LIMIT/OFFSET)
          // so the query log is truthful — the user can see paging is applied.
          onLogQuery?.(s.sql, {
            source: 'editor',
            durationMs: s.durationMs,
            status: s.error ? 'error' : 'ok',
            message: s.error ?? undefined,
          });
          setResultStatements([...collected]);
          if (!userPickedResultRef.current) {
            setActiveResultIndex(collected.length - 1);
          }
        },
        undefined,
        effectiveSchema,
        tabId,
      );
      if (collected.length === 0 && finalResult.statements.length > 0) {
        for (const s of finalResult.statements) {
          collected.push(finalizePaged(s));
          onLogQuery?.(s.sql, {
            source: 'editor',
            durationMs: s.durationMs,
            status: s.error ? 'error' : 'ok',
            message: s.error ?? undefined,
          });
        }
        setResultStatements([...collected]);
        setActiveResultIndex(collected.length - 1);
      }
      setRunError(null);
    } catch (err) {
      const message = isDbError(err) ? err.message : String(err);
      onLogQuery?.(sqlToRun, { source: 'editor', status: 'error', message });
      setRunError(message);
    } finally {
      setIsExecuting(false);
    }
  };

  // Run a specific page of the currently-paged statement.
  const runPage = async (stmt: string, targetPage: number, size: number) => {
    setPage(targetPage);
    // size === 0 → "Unlimited": run the bare statement with no LIMIT/OFFSET and
    // no sentinel-row trimming (fetch the whole result set).
    if (size <= 0) {
      setHasNextPage(false);
      await runSql(stmt);
      return;
    }
    await runSql(buildPagedSql(stmt, targetPage, size), {
      pagedFetchSize: size + 1,
    });
  };

  const executePayload = async (payload: string) => {
    // Auto-paging: a plain SELECT with no LIMIT of its own gets wrapped with
    // LIMIT/OFFSET and pager controls. Anything else (non-SELECT, multi-
    // statement, user-supplied LIMIT) runs verbatim with paging off.
    const pageable = pageableSelect(payload);
    if (pageable) {
      setPagedStmt(pageable);
      await runPage(pageable, 0, pageSize);
      return;
    }
    setPagedStmt(null);
    setHasNextPage(false);
    await runSql(payload);
  };

  const handleRun = async (statementOverride?: string) => {
    const payload = stripCodeComments(statementOverride ?? query, language, activeManifest?.queryEditor?.commentTags).trim();
    if (!payload) return;

    // Check for destructive statements before executing
    const dialect = activeManifest?.capabilities.sqlDialect ?? 'none';
    const analysis = analyzeDestructive(payload, dialect);
    if (settings.confirmDestructive && 'statements' in analysis) {
      pendingRunRef.current = payload;
      setDestructiveWarning(analysis.statements);
      return;
    }

    await executePayload(payload);
  };

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

  const handleCancelQuery = async () => {
    if (!tabId) {
      toast.error('Cannot cancel query: Tab ID is missing.');
      return;
    }
    try {
      await db.cancelQuery(connection.id, tabId);
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      toast.error(`Cancellation failed: ${msg}`);
    }
  };

  // Cmd/Ctrl+Enter runs the current statement (the primary action);
  // Cmd/Ctrl+Shift+Enter runs everything.
  handleRunRef.current = () => { handleRunCurrent(); };
  handleRunAllRef.current = () => { void handleRun(); };

  // Save the editor buffer to a file. Mongo's editor holds JS-shaped queries,
  // so we offer a .js default there.
  //   - Save (Cmd/Ctrl+S): writes back to the bound file silently. With no file
  //     bound yet (never saved/loaded), it behaves like Save As.
  //   - Save As (Cmd/Ctrl+Shift+S): always prompts for a location, then binds
  //     the buffer to the chosen file.
  const handleExportQuery = async (saveAs = false) => {
    const body = query;
    if (!body.trim()) {
      toast.error('Nothing to save — the editor is empty');
      return;
    }
    try {
      let path = savedFilePath;
      if (saveAs || !path) {
        const ext = isDocumentStore ? 'js' : 'sql';
        path = await saveDialog({
          defaultPath: savedFilePath ?? `query.${ext}`,
          filters: isDocumentStore
            ? [{ name: 'JavaScript', extensions: ['js'] }, { name: 'All files', extensions: ['*'] }]
            : [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }],
        });
        if (!path) return; // user cancelled
        setSavedFilePath(path);
      }
      await writeTextFile(path, body);
      toast.success('Query saved');
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Import a query from a file into the editor. If the buffer already has
  // content we append (separated by a blank line) rather than clobber the
  // user's work; an empty buffer is replaced outright.
  const handleImportQuery = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: isDocumentStore
          ? [{ name: 'Query', extensions: ['js', 'txt'] }, { name: 'All files', extensions: ['*'] }]
          : [{ name: 'SQL', extensions: ['sql', 'txt'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (!picked || Array.isArray(picked)) return; // cancelled
      const text = await readTextFile(picked);
      const editor = editorRef.current;
      const model = editor?.getModel();
      const current = model?.getValue() ?? query;
      const wasEmpty = !current.trim();
      const next = wasEmpty ? text : `${current.replace(/\s*$/, '')}\n\n${text}`;
      if (editor && model) {
        // executeEdits keeps the undo stack intact (vs setValue which wipes it).
        editor.executeEdits('import-query', [
          { range: model.getFullModelRange(), text: next, forceMoveMarkers: true },
        ]);
      }
      setQuery(next);
      // Bind the buffer to the loaded file only when it replaced an empty editor
      // — so Cmd+S writes back to it. If we appended to existing content, the
      // buffer is a mix and shouldn't silently overwrite the source file.
      setSavedFilePath(wasEmpty ? picked : null);
      toast.success('Query loaded');
    } catch (err) {
      toast.error(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Keep the mount-time shortcut commands pointed at the current handlers.
  handleSaveQueryRef.current = () => void handleExportQuery(false);
  handleSaveAsQueryRef.current = () => void handleExportQuery(true);
  handleLoadQueryRef.current = () => void handleImportQuery();

  // Save (⌘/Ctrl+S), Save As (⌘/Ctrl+⇧S) and Load (⌘/Ctrl+I) reach us two ways:
  //
  //  1. Native File-menu accelerators, which emit the `menu-file-*` events
  //     below. This is the path that shows the shortcut in the OS menu.
  //  2. A window-level keydown handler (below). This is REQUIRED on Windows:
  //     the query menu items are inserted into the File menu dynamically (only
  //     while a query tab is active), and on Windows accelerators for items
  //     added after the menu is first set are not reliably registered, so the
  //     native shortcut silently does nothing. The keydown handler makes the
  //     shortcuts work identically on every platform.
  //
  // Both are gated on `isActive` so only the visible query tab reacts, and the
  // keydown handler runs in the capture phase before Monaco/the browser. The
  // data grid's own ⌘/Ctrl+S (commit) is likewise gated on its `isActive`, and
  // only one tab is active at a time, so the two never fight over the key.
  useEffect(() => {
    if (!isActive) return;
    const unlistens = [
      listen<void>('menu-file-load_query', () => handleLoadQueryRef.current()),
      listen<void>('menu-file-save_query', () => handleSaveQueryRef.current()),
      listen<void>('menu-file-save_query_as', () => handleSaveAsQueryRef.current()),
    ];
    // On macOS the native accelerator fires reliably AND the OS consumes the
    // key, so a keydown fallback would double-fire (saving twice). Only add the
    // fallback off macOS, where the dynamic-menu accelerator doesn't register.
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      // `e.code` is keyboard-layout independent (KeyS regardless of layout).
      if (e.code === 'KeyS') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) handleSaveAsQueryRef.current();
        else handleSaveQueryRef.current();
      } else if (e.code === 'KeyI' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleLoadQueryRef.current();
      }
    };
    if (!IS_MAC) window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      for (const u of unlistens) void u.then((fn) => fn());
      if (!IS_MAC) window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [isActive]);

  // Export the ACTIVE result (the currently-shown Execution tab) to a file in
  // the chosen format. The result is already in memory, so we serialize the
  // whole thing in one pass. SQL export targets the analysed single-table name
  // when available; otherwise it falls back to a placeholder table name.
  const handleExportResult = async (format: ResultExportFormat) => {
    const res = activeResult;
    if (!res || res.error || res.columns.length === 0) {
      toast.error('No result rows to export');
      return;
    }
    const tableName = queryAnalysis.editable ? queryAnalysis.table : undefined;
    try {
      const text = serializeResult(format, {
        columns: res.columns.map(c => ({ name: c.name })),
        rows: res.rows,
        tableName,
        dialect: activeManifest?.capabilities.sqlDialect,
      });
      const filterMap: Record<ResultExportFormat, { name: string; ext: string }> = {
        csv: { name: 'CSV', ext: 'csv' },
        json: { name: 'JSON', ext: 'json' },
        sql: { name: 'SQL', ext: 'sql' },
      };
      const f = filterMap[format];
      const path = await saveDialog({
        defaultPath: defaultFileName(format, tableName),
        filters: [{ name: f.name, extensions: [f.ext] }, { name: 'All files', extensions: ['*'] }],
      });
      if (!path) return; // cancelled
      await writeTextFile(path, text);
      toast.success(`Exported ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} as ${format.toUpperCase()}`);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    const { formatted, error: err } = formatSql(query, {
      language: languageForDialect(
        dialectFromManifest(activeManifest?.capabilities),
      ),
    });
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
        {isExecuting ? (
          <Button size="sm" onClick={handleCancelQuery} className="bg-red-600 hover:bg-red-700 text-white gap-1.5" title="Stop current query execution">
            <Square className="w-3.5 h-3.5 fill-current" />
            Stop Query
          </Button>
        ) : (
          <Button size="sm" onClick={handleRunCurrent} className="bg-green-600 hover:bg-green-700 text-white gap-1.5" title="Run the statement under the cursor (or selection)">
            <Play className="w-3.5 h-3.5 fill-current" />
            Run Current
            <kbd className="inline-flex h-4 items-center rounded border border-white/30 bg-white/15 px-1 text-[10px] font-medium font-sans">{RUN_SHORTCUT}</kbd>
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => { void handleRun(); }} disabled={isExecuting} className="border-emerald-600/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300" title="Run all statements in the editor">
          <FastForward className="w-3.5 h-3.5" />
          Run All
          <kbd className="inline-flex h-4 items-center rounded border border-current/30 bg-current/10 px-1 text-[10px] font-medium font-sans">{RUN_ALL_SHORTCUT}</kbd>
        </Button>
        <div className="w-px h-4 bg-border mx-1" />
        <Button variant="ghost" size="sm" onClick={handleFormat}>
          <AlignLeft className="w-4 h-4 mr-2" />
          {isDocumentStore ? 'Format JSON' : 'Format SQL'}
        </Button>
        {/* Row limit lives in the persistent footer (always visible, before and
            after a run) rather than here. Load / Save / Save As live in the
            native File menu (and ⌘I / ⌘S / ⌘⇧S shortcuts). */}
        <div className="ml-auto" />
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
          Ask AI
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
            minimap: { enabled: settings.editorMinimap },
            fontFamily: EDITOR_FONT_FAMILY,
            fontSize: settings.editorFontSize,
            lineHeight: 20,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            renderLineHighlight: 'line',
            tabSize: settings.editorTabSize,
            automaticLayout: true,
            wordWrap: settings.editorWordWrap ? 'on' : 'off',
            padding: { top: 12, bottom: 12 },
            // fixedOverflowWidgets renders the suggest widget into document.body
            // so it can overflow the editor. In the Tauri webview that detached
            // node falls outside the editor's focus subtree, so Arrow Up/Down
            // never reach the suggest list (you can't navigate it). Keeping the
            // widget inside the editor's own overflow guard restores keyboard
            // navigation; the editor fills its pane, so clipping isn't an issue.
            fixedOverflowWidgets: false,
            scrollbar: {
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
            guides: { indentation: false },
            wordBasedSuggestions: 'off',
            quickSuggestions: settings.editorAutocomplete ? { other: true, comments: false, strings: true } : false,
            suggestOnTriggerCharacters: settings.editorAutocomplete,
          }}
        />
      </div>

      {/* Results pane — each executed statement gets its own tab so multi-
          statement runs (`a; b; c`) can be inspected independently. Stays
          mounted while a query runs so we can show a "Running…" timer instead
          of the pane vanishing. */}
      {(isExecuting || runError || resultStatements.length > 0) && (
        <div
          className="border-t border-border flex flex-col shrink-0 relative"
          style={{ height: resultsHeight }}
        >
          <VerticalResizeHandle
            onResize={(dy) => setResultsHeight(h => Math.max(120, Math.min(900, h - dy)))}
            orientation="top"
          />
          <div className="h-8 border-b border-border bg-muted/30 flex items-center justify-between px-3 text-xs font-medium text-muted-foreground shrink-0 gap-2">
            <div className="min-w-0 flex items-center gap-2">
              <span className="shrink-0 flex items-center gap-1.5">
                {isExecuting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                    <span>Running…</span>
                    {resultStatements.length > 0 && (
                      <span className="text-muted-foreground/70">
                        {resultStatements.length} done
                      </span>
                    )}
                    <span className="tabular-nums text-muted-foreground/70">{formatElapsed(runElapsedMs)}</span>
                  </>
                ) : runError
                  ? (isDocumentStore ? 'MongoDB Error' : 'Query Error')
                  : `Results${activeResult ? ` · ${activeResult.durationMs.toFixed(1)}ms` : ''}`}
              </span>
              {/* Read-only reason lives here (beside the duration) rather than
                  in its own row above the grid — saves vertical space. The
                  pending-edits bar still gets its own row since it carries the
                  Discard/Save actions. */}
              {!isExecuting && !runError && editableReason && pendingEditCount === 0 && (
                <span
                  className="min-w-0 inline-flex items-center gap-1 text-[11px] text-muted-foreground/80 font-normal"
                  title={editableReason}
                >
                  <span className="text-muted-foreground/40">·</span>
                  <Lock className="w-3 h-3 shrink-0" />
                  <span className="shrink-0">Read-only</span>
                  <span className="truncate">— {editableReason}</span>
                </span>
              )}
            </div>
            {/* View toggle + export only make sense when the active result has
                actual tabular data. Statements that return no columns (UPDATE,
                "executed successfully", errors) get no toolbar. */}
            {!isExecuting && !runError && activeResult && !activeResult.error && activeResult.columns.length > 0 && (
              <div className="inline-flex items-center gap-2 shrink-0">
                <div className="relative flex items-center w-48">
                  <input
                    type="text"
                    placeholder="Search results..."
                    value={filterSearchText}
                    onChange={(e) => setFilterSearchText(e.target.value)}
                    className="w-full h-5.5 px-2 pr-6 rounded border border-border bg-background/50 text-[11px] placeholder:text-muted-foreground/60 outline-none focus:ring-1 focus:ring-primary focus:border-primary text-foreground"
                  />
                  {filterSearchText && (
                    <button
                      type="button"
                      onClick={() => setFilterSearchText('')}
                      className="absolute right-1.5 text-muted-foreground/50 hover:text-muted-foreground focus:outline-none"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                {supportsJsonResultView && (
                  <>
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
                    <span className="w-px h-4 bg-border mx-0.5" />
                  </>
                )}
                {/* Export the active result to a file. SQL is offered only for
                    SQL adapters — INSERTs into a document store make no sense. */}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={(props) => (
                      <Button
                        {...props}
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        title="Export result to a file"
                      >
                        <Download className="w-3.5 h-3.5 mr-1" />
                        Export
                      </Button>
                    )}
                  />
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuItem onClick={() => void handleExportResult('csv')}>
                      Export as CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExportResult('json')}>
                      Export as JSON
                    </DropdownMenuItem>
                    {!isDocumentStore && (
                      <DropdownMenuItem onClick={() => void handleExportResult('sql')}>
                        Export as SQL (INSERT)
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
          {isExecuting && resultStatements.length === 0 && (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <div className="text-sm font-medium">Running query…</div>
              <div className="text-xs tabular-nums text-muted-foreground/70">{formatElapsed(runElapsedMs)}</div>
            </div>
          )}
          {runError && (
            <div className="px-4 py-2 text-xs bg-destructive/10 text-destructive font-mono flex items-start justify-between gap-2 border-b border-destructive/30 shrink-0 select-text">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 select-none" />
                <div className="min-w-0 wrap-break-word select-text">{runError}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 text-destructive hover:bg-destructive/20 select-none"
                onClick={() => { void copyText(runError, 'Error copied'); }}
                title="Copy error message"
              >
                <Copy className="w-3 h-3" />
              </Button>
            </div>
          )}
          {!runError && resultStatements.length > 1 && (
            <div className="h-8 border-b border-border bg-muted/30 shrink-0 flex items-center gap-2 px-2">
              <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
                <div className="h-full inline-flex items-center gap-1 w-max pr-2">
                  {resultStatements.map((stmt, idx) => {
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          // User explicitly picked a result — stop auto-following
                          // the newest one for the rest of this run.
                          userPickedResultRef.current = true;
                          setActiveResultIndex(idx);
                        }}
                        className={`h-6 px-2.5 rounded-md border text-[11px] whitespace-nowrap transition-colors ${
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
                <div className="px-4 py-2 text-xs bg-destructive/10 text-destructive font-mono flex items-start justify-between gap-2 border-b border-destructive/30 shrink-0 select-text">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 select-none" />
                    <div className="min-w-0 wrap-break-word select-text">{active.error}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 text-destructive hover:bg-destructive/20 select-none"
                    onClick={() => { void copyText(active.error!, 'Error copied'); }}
                    title="Copy error message"
                  >
                    <Copy className="w-3 h-3" />
                  </Button>
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
                  {(jsonResultError || jsonResultDirty || (!resultIsEditable && editableReason) || !!filterSearchText.trim()) && (
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
                        ) : !!filterSearchText.trim() ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-muted text-muted-foreground border border-border" title="Clear the search filter to edit query results.">
                            <Lock className="w-3 h-3" />
                            Read-only
                            <span className="text-muted-foreground/70 truncate max-w-[420px]">— Cannot edit results when search filter is active</span>
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
                        readOnly: !resultIsEditable || jsonResultSaving || !!filterSearchText.trim(),
                        minimap: { enabled: settings.editorMinimap },
                        fontFamily: EDITOR_FONT_FAMILY,
                        fontSize: settings.editorFontSize,
                        lineHeight: 20,
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        automaticLayout: true,
                        wordWrap: settings.editorWordWrap ? 'on' : 'off',
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
                    onClick={() => {
                      void copyText(jsonResultEditorRef.current?.getValue() ?? activeRowsAsJsonText, 'JSON copied');
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
                {/* Read-only notice — a prominent banner explaining WHY the
                    result can't be edited (no primary key, missing PK column in
                    the SELECT list, expression columns, etc.). Without this the
                    user just finds that double-click does nothing, with no clue
                    why. Only shown when the query analysed as a single-table
                    SELECT (so a hint is actionable) and there are no pending
                    edits competing for the row. */}
                {!resultIsEditable && editableReason && queryAnalysis.editable && pendingEditCount === 0 && (
                  <div className="shrink-0 flex items-start gap-2 px-3 py-2 border-b border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-400">
                    <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <span className="font-medium">Read-only result.</span>{' '}
                      <span className="text-amber-700/90 dark:text-amber-400/90">{editableReason}</span>
                    </div>
                  </div>
                )}
                {/* Pending-edits action bar — surfaces only when there are
                    unsaved cell edits to flush. */}
                {pendingEditCount > 0 && (
                  <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background/40 text-xs">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                        {pendingEditCount} unsaved cell{pendingEditCount === 1 ? '' : 's'}
                      </span>
                    </div>
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
                      {filteredRows.map(({ row, idx: ri }) => (
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
                            // Only render a short preview in the cell — long
                            // values (e.g. hex-rendered binary) bloat the DOM and
                            // can render blank. The full value is still available
                            // on double-click (the edit input gets it untruncated)
                            // and via copy.
                            const [previewText, previewTruncated] = truncateForCell(displayText);
                            const kind = kindByColumn[col.name] ?? { kind: 'text' as const };
                            const validationError = isCurrentlyEditing ? validateEditorValue(kind, activeResultEdit.value) : null;
                            const cellClass = isEdited
                              ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
                              : '';
                            return (
                              <td
                                key={ci}
                                className={`relative p-0 border-r border-border font-mono text-[11px] align-top min-w-24 max-w-80 ${cellClass} cursor-text`}
                                onDoubleClick={() => {
                                  // Always open an input on double-click so the
                                  // user can select + copy the value manually.
                                  // Editable cells commit on Enter/blur;
                                  // read-only cells open a read-only input (no
                                  // commit, not marked edited) — see below.
                                  setActiveResultEdit({ rowIdx: ri, col: col.name, value: isEdited ? pendingValue : (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)) });
                                }}
                                title={
                                  isPk ? 'Primary key — read-only'
                                  : !resultIsEditable ? undefined
                                  : !cellEditable ? 'Not a base-table column — read-only'
                                  : isEdited ? `Was: ${baseText}` : displayText
                                }
                              >
                                {/* Always render the text div so the cell keeps
                                    its natural width; the edit input overlays it
                                    absolutely so opening it never re-lays-out the
                                    column (the cause of the "cell moves" jump). */}
                                <div className="block box-border px-2 py-1.5 leading-normal truncate selectable cursor-text">
                                  {previewText}
                                  {previewTruncated && (
                                    <span className="ml-2 text-[10px] text-muted-foreground/70">
                                      +{(displayText.length - CELL_MAX_RENDER_CHARS).toLocaleString()} more
                                    </span>
                                  )}
                                </div>
                                {isCurrentlyEditing && (
                                  <input
                                    autoFocus
                                    readOnly={!cellEditable}
                                    // Overlay the cell exactly. Absolute inset-0 so
                                    // it covers the text without affecting layout.
                                    // Read-only → neutral ring; editable →
                                    // primary/destructive ring.
                                    className={`absolute inset-0 block box-border w-full h-full m-0 px-2 py-1.5 bg-background outline-none ring-1 ring-inset font-mono text-[11px] leading-normal ${
                                      !cellEditable ? 'ring-border' : validationError ? 'ring-destructive' : 'ring-primary'
                                    }`}
                                    value={activeResultEdit.value}
                                    // Select the whole value on open so Cmd/Ctrl+C
                                    // copies it immediately.
                                    onFocus={(e) => e.currentTarget.select()}
                                    onChange={(e) => {
                                      // Ignore edits on read-only cells.
                                      if (!cellEditable) return;
                                      setActiveResultEdit({ ...activeResultEdit, value: e.target.value });
                                    }}
                                    onKeyDown={(e) => {
                                      // Read-only: Enter/Escape just close; let
                                      // Cmd/Ctrl+C and selection keys work normally.
                                      if (!cellEditable) {
                                        if (e.key === 'Enter' || e.key === 'Escape') {
                                          e.preventDefault();
                                          setActiveResultEdit(null);
                                        }
                                        return;
                                      }
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
                                      // Read-only: nothing to commit, just close.
                                      if (!cellEditable) {
                                        setActiveResultEdit(null);
                                        return;
                                      }
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

      {/* Persistent footer — always visible so the user can pick the row Limit
          BEFORE running (no need to run once then change). When a paged result
          is on screen it also shows rows/execution on the left and the pager on
          the right; before any run it's just the Limit selector. We don't run a
          COUNT for a grand total (a second query on huge results), so the pager
          shows "Page N" rather than "1 of N"; Next is enabled only when the +1
          sentinel row came back. */}
      {(() => {
        const showPager = !!pagedStmt && !runError && !!activeResult && !activeResult.error;
        return (
          <div className="h-10 shrink-0 border-t border-border flex items-center justify-between px-4 bg-muted/10 text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              {showPager && activeResult ? (
                <>
                  <span>
                    {activeResult.rows.length.toLocaleString()} row{activeResult.rows.length === 1 ? '' : 's'}
                    {pageSize > 0 && ` on page ${page + 1}`}
                  </span>
                  <span>Execution: {activeResult.durationMs.toFixed(1)}ms</span>
                </>
              ) : (
                <span className="text-muted-foreground/70">Set the row limit, then run a query.</span>
              )}
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span>Limit:</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => {
                    const next = Number(v);
                    setPageSize(next);
                    // Apply immediately only when a paged result is already
                    // showing; otherwise it just seeds the next run.
                    if (showPager && pagedStmt && !isExecuting) void runPage(pagedStmt, 0, next);
                  }}
                >
                  <SelectTrigger size="sm" className="h-7! w-24 py-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['50', '100', '200', '500', '1000'].map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                    <SelectItem value="0">Unlimited</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {showPager && pageSize > 0 && pagedStmt && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-6 w-6"
                    disabled={isExecuting || page === 0}
                    onClick={() => void runPage(pagedStmt, Math.max(0, page - 1), pageSize)}
                    title="Previous page"
                  >
                    <ChevronLeft className="w-3 h-3" />
                  </Button>
                  <span className="px-2">Page {page + 1}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-6 w-6"
                    disabled={isExecuting || !hasNextPage}
                    onClick={() => void runPage(pagedStmt, page + 1, pageSize)}
                    title="Next page"
                  >
                    <ChevronRight className="w-3 h-3" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <DestructiveWarningDialog
        open={destructiveWarning !== null}
        onOpenChange={(open) => { if (!open) { setDestructiveWarning(null); pendingRunRef.current = null; } }}
        statements={destructiveWarning ?? []}
        onConfirm={() => {
          const payload = pendingRunRef.current;
          setDestructiveWarning(null);
          pendingRunRef.current = null;
          if (payload) {
            void executePayload(payload);
          }
        }}
      />
    </div>
  );
}
