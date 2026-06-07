import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import {
  Loader2,
  FileText,
  AlertCircle,
  FileSpreadsheet,
  Braces,
  Database,
  Table2,
  CheckCircle2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { db, type SchemaInfo } from '../../lib/db';
import { refreshSchemas } from '../../state/connections';
import ProgressDialog, { type ProgressState, type ProgressLogLine } from '../../components/ui/progress-dialog';

/**
 * "Import" dialog — pick a file (SQL / CSV / JSON), preview it when it's small
 * enough, and load it into the active connection.
 *
 * Two execution paths, chosen by format:
 *
 *   • **SQL** (SQL stores only) — the whole file is handed to `db.runQuery`
 *     as one call; the adapter splits statements itself (robust splitters
 *     cope with `DELIMITER`, quoted identifiers, comments). Per-statement
 *     outcomes come back as `StatementResult[]`. SQL can alternatively be
 *     opened in a new editor tab for review.
 *
 *   • **CSV / JSON** (any store with `insert_rows`) — rows are parsed in the
 *     webview and inserted into a chosen target table/collection one row at a
 *     time via `db.insertRows`. This is the only meaningful import path for
 *     document stores (Mongo), and a convenient one for SQL stores too. A
 *     progress count + Cancel keep large files responsive.
 */
export type ImportDialect = 'mysql' | 'sqlite' | 'postgres' | null;

type ImportFormat = 'sql' | 'csv' | 'json';

// Files larger than this are imported in full but NOT previewed — rendering a
// huge string into a <pre> stalls the webview, and the preview is only ever a
// sanity check. We still parse CSV/JSON for the row count regardless.
const PREVIEW_MAX_BYTES = 512 * 1024; // 512 KB
const PREVIEW_MAX_CHARS = 4000;

interface FormatMeta {
  value: ImportFormat;
  label: string;
  icon: typeof FileText;
  hint: string;
  exts: string[];
}

const FORMATS: FormatMeta[] = [
  {
    value: 'sql',
    label: 'SQL',
    icon: Database,
    hint: 'Run a dump of statements (INSERT / CREATE / …) against the connection.',
    exts: ['sql', 'ddl', 'txt'],
  },
  {
    value: 'csv',
    label: 'CSV',
    icon: FileSpreadsheet,
    hint: 'Insert spreadsheet rows into one table. First row is the header.',
    exts: ['csv', 'tsv', 'txt'],
  },
  {
    value: 'json',
    label: 'JSON',
    icon: Braces,
    hint: 'Insert an array of objects (or newline-delimited objects) into one table.',
    exts: ['json', 'ndjson', 'jsonl', 'txt'],
  },
];

export default function ImportSqlDialog({
  isOpen,
  onClose,
  connectionId,
  connectionName,
  targetDatabase,
  dialect,
  /** Whether the active store can execute a SQL dump. False for document/KV
   *  stores (Mongo); those import CSV/JSON only. */
  supportsSql = true,
  /** Whether the active store can ingest rows via `db.insertRows`. Gates the
   *  CSV/JSON paths. Redis is false; everyone else is true. */
  supportsRowInsert = true,
  /** Schemas/tables of the connection, for the CSV/JSON target picker. */
  schemas = [],
  onOpenInEditor,
}: {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string | null;
  connectionName: string;
  targetDatabase?: string | null;
  dialect?: ImportDialect;
  supportsSql?: boolean;
  supportsRowInsert?: boolean;
  schemas?: SchemaInfo[];
  onOpenInEditor: (connectionId: string, fileName: string, sql: string) => void;
}) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [contents, setContents] = useState<string>('');
  const [fileBytes, setFileBytes] = useState(0);
  const [loadingFile, setLoadingFile] = useState(false);
  const [format, setFormat] = useState<ImportFormat>(supportsSql ? 'sql' : 'csv');
  const [mode, setMode] = useState<'execute' | 'editor'>('execute');
  const [executing, setExecuting] = useState(false);
  // CSV/JSON target.
  const [targetSchema, setTargetSchema] = useState<string>('');
  const [targetTable, setTargetTable] = useState<string>('');
  // Rich progress popup (bar + step + log + cancel) for the actual run.
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const cancelRef = useRef(false);
  // Per-statement / per-row outcome tally after a run.
  const [report, setReport] = useState<{
    ok: number;
    failed: number;
    firstError: string | null;
  } | null>(null);

  const availableFormats = useMemo(
    () => (supportsSql ? FORMATS : FORMATS.filter((f) => f.value !== 'sql')),
    [supportsSql],
  );

  // Reset everything whenever the dialog closes/reopens — stale file
  // previews confuse users who re-open for a different import.
  useEffect(() => {
    if (!isOpen) {
      setFilePath(null);
      setFileName('');
      setContents('');
      setFileBytes(0);
      setLoadingFile(false);
      setFormat(supportsSql ? 'sql' : 'csv');
      setMode('execute');
      setExecuting(false);
      setTargetSchema('');
      setTargetTable('');
      setProgress(null);
      cancelRef.current = false;
      setReport(null);
    }
  }, [isOpen, supportsSql]);

  // When opening a row-import for a connection whose schema/table list hasn't
  // been loaded yet (e.g. import launched from the rail before a tile was
  // focused), kick a refresh so the target picker has tables/collections to
  // offer. The parent subscribes to the connections store, so the fresh list
  // flows back in as the `schemas` prop.
  useEffect(() => {
    if (!isOpen || !connectionId) return;
    if (schemas.length === 0) void refreshSchemas(connectionId, { silent: true });
    // Only re-run when the dialog opens or the connection changes — not on
    // every schemas update (that would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, connectionId]);

  // Seed the target schema once schemas arrive / the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    if (targetSchema && schemas.some((s) => s.name === targetSchema)) return;
    const initial =
      (targetDatabase && schemas.find((s) => s.name === targetDatabase)?.name) ??
      schemas[0]?.name ??
      '';
    setTargetSchema(initial);
  }, [isOpen, schemas, targetDatabase, targetSchema]);

  const selectedSchema = useMemo(
    () => schemas.find((s) => s.name === targetSchema) ?? null,
    [schemas, targetSchema],
  );
  const targetTables = useMemo(
    () => (selectedSchema?.tables ?? []).filter((t) => t.kind !== 'view'),
    [selectedSchema],
  );
  // Keep the selected table valid when the schema changes.
  useEffect(() => {
    if (targetTable && targetTables.some((t) => t.name === targetTable)) return;
    setTargetTable(targetTables[0]?.name ?? '');
  }, [targetTables, targetTable]);

  // If SQL becomes unavailable but is selected, snap to CSV.
  useEffect(() => {
    if (!supportsSql && format === 'sql') setFormat('csv');
  }, [supportsSql, format]);

  const pickFile = useCallback(async () => {
    try {
      const picked = await openDialog({
        title: 'Import data',
        multiple: false,
        directory: false,
        filters: [
          { name: 'Data file', extensions: ['sql', 'ddl', 'csv', 'tsv', 'json', 'ndjson', 'jsonl', 'txt'] },
        ],
      });
      if (typeof picked !== 'string' || !picked) return;
      setLoadingFile(true);
      setFilePath(picked);
      const name = picked.split(/[/\\]/).pop() ?? picked;
      setFileName(name);
      setReport(null);
      // Guess the format from the extension and switch to it if available.
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      const guessed = guessFormat(ext);
      if (guessed && (guessed !== 'sql' || supportsSql)) setFormat(guessed);
      const text = await readTextFile(picked);
      setContents(text);
      setFileBytes(new TextEncoder().encode(text).length);
    } catch (e) {
      toast.error(`Could not read file: ${String(e)}`);
    } finally {
      setLoadingFile(false);
    }
  }, [supportsSql]);

  // Parse CSV/JSON into rows for insert + count. Returns null for SQL (or on
  // parse failure, surfaced separately). Memoised so we don't re-parse on every
  // render — big files make this non-trivial.
  const parsed = useMemo<{ rows: Record<string, unknown>[]; error: string | null } | null>(() => {
    if (!contents || format === 'sql') return null;
    try {
      const rows = format === 'csv' ? parseCsv(contents) : parseJsonRows(contents);
      return { rows, error: null };
    } catch (e) {
      return { rows: [], error: e instanceof Error ? e.message : String(e) };
    }
  }, [contents, format]);

  // Summary line below the file name.
  const stats = useMemo(() => {
    if (!contents) return null;
    const lines = contents.split('\n').length;
    if (format === 'sql') {
      const approxStatements = (contents.match(/;\s*(\n|$)/g) ?? []).length;
      return { kind: 'sql' as const, lines, approxStatements, bytes: fileBytes };
    }
    return { kind: 'rows' as const, lines, rows: parsed?.rows.length ?? 0, bytes: fileBytes };
  }, [contents, format, fileBytes, parsed]);

  const previewable = fileBytes > 0 && fileBytes <= PREVIEW_MAX_BYTES;

  const isRowImport = format === 'csv' || format === 'json';
  const rowCount = parsed?.rows.length ?? 0;
  const canRun =
    !!filePath &&
    !!contents &&
    !loadingFile &&
    !executing &&
    (format === 'sql'
      ? true
      : !!parsed && !parsed.error && rowCount > 0 && !!targetSchema && !!targetTable);

  const runSqlImport = async () => {
    if (!connectionId) {
      toast.error('No active connection to run the import against');
      return;
    }
    setExecuting(true);
    setReport(null);
    // SQL runs as a single adapter call (the splitter lives server-side), so we
    // can't show per-statement progress or cancel mid-run — use an indeterminate
    // bar and disable cancel while it executes.
    const log: ProgressLogLine[] = [{ text: `→ Executing ${fileName || 'SQL file'}…` }];
    setProgress({ step: 'Running SQL import…', fraction: null, phase: 'running', log: [...log] });
    try {
      const sqlToRun = buildPayload(contents, targetDatabase, dialect ?? null);
      const result = await db.runQuery(connectionId, sqlToRun);
      const statements = result.statements ?? [];
      let ok = 0;
      let failed = 0;
      let firstError: string | null = null;
      for (const s of statements) {
        if (s.error) {
          failed += 1;
          if (!firstError) firstError = s.error;
        } else {
          ok += 1;
        }
      }
      setReport({ ok, failed, firstError });
      void refreshSchemas(connectionId);
      window.dispatchEvent(
        new CustomEvent('tablerelay:reload', { detail: { connectionId } }),
      );
      if (failed === 0) {
        log.push({ text: `Done — ${ok.toLocaleString()} statement${ok === 1 ? '' : 's'} executed`, kind: 'success' });
        setProgress({ step: 'Import complete', fraction: 1, phase: 'done', log: [...log] });
        toast.success(
          statements.length === 1 ? 'Import complete (1 statement)' : `Import complete (${ok} statements)`,
        );
      } else {
        log.push({ text: `${failed} statement${failed === 1 ? '' : 's'} failed`, kind: 'error' });
        if (firstError) log.push({ text: `First error: ${firstError}`, kind: 'error' });
        setProgress({ step: 'Import finished with errors', fraction: 1, phase: 'error', log: [...log] });
        toast.error(`Import finished with ${failed} failing statement${failed === 1 ? '' : 's'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setReport({ ok: 0, failed: 1, firstError: msg });
      log.push({ text: `Error: ${msg}`, kind: 'error' });
      setProgress({ step: 'Import failed', fraction: null, phase: 'error', log: [...log] });
      toast.error(`Import failed: ${msg}`);
    } finally {
      setExecuting(false);
    }
  };

  const runRowImport = async () => {
    if (!connectionId) {
      toast.error('No active connection to import into');
      return;
    }
    if (!parsed || parsed.error || !targetSchema || !targetTable) return;
    const rows = parsed.rows;
    setExecuting(true);
    setReport(null);
    cancelRef.current = false;
    const log: ProgressLogLine[] = [
      { text: `→ Inserting ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} into ${targetTable}…` },
    ];
    setProgress({
      step: `Importing into ${targetTable}`,
      fraction: 0,
      detail: `0 / ${rows.length.toLocaleString()} rows`,
      phase: 'running',
      log: [...log],
    });
    let ok = 0;
    let failed = 0;
    let firstError: string | null = null;
    try {
      for (let i = 0; i < rows.length; i++) {
        if (cancelRef.current) break;
        try {
          await db.insertRows(connectionId, {
            schema: targetSchema,
            table: targetTable,
            values: rows[i],
          });
          ok += 1;
        } catch (e) {
          failed += 1;
          if (!firstError) firstError = e instanceof Error ? e.message : String(e);
        }
        // Throttle progress paints to keep large imports smooth.
        if (i % 25 === 0 || i === rows.length - 1) {
          const done = i + 1;
          setProgress({
            step: `Importing into ${targetTable}`,
            fraction: rows.length ? done / rows.length : 1,
            detail: `${done.toLocaleString()} / ${rows.length.toLocaleString()} rows${failed ? ` · ${failed.toLocaleString()} failed` : ''}`,
            phase: 'running',
            log: [...log],
          });
        }
      }
      setReport({ ok, failed, firstError });
      void refreshSchemas(connectionId);
      window.dispatchEvent(
        new CustomEvent('tablerelay:reload', { detail: { connectionId } }),
      );
      const cancelled = cancelRef.current;
      if (cancelled) {
        log.push({ text: `Cancelled — ${ok.toLocaleString()} row${ok === 1 ? '' : 's'} inserted`, kind: 'error' });
        setProgress({ step: 'Cancelled', fraction: null, phase: 'cancelled', log: [...log] });
        toast.message(`Import cancelled — ${ok.toLocaleString()} row${ok === 1 ? '' : 's'} inserted`);
      } else if (failed === 0) {
        log.push({ text: `Done — ${ok.toLocaleString()} row${ok === 1 ? '' : 's'} imported`, kind: 'success' });
        setProgress({ step: 'Import complete', fraction: 1, phase: 'done', log: [...log] });
        toast.success(`Imported ${ok.toLocaleString()} row${ok === 1 ? '' : 's'} into ${targetTable}`);
      } else {
        log.push({ text: `${ok.toLocaleString()} imported, ${failed.toLocaleString()} failed`, kind: 'error' });
        if (firstError) log.push({ text: `First error: ${firstError}`, kind: 'error' });
        setProgress({ step: 'Import finished with errors', fraction: 1, phase: 'error', log: [...log] });
        toast.error(`Imported ${ok.toLocaleString()} row${ok === 1 ? '' : 's'}, ${failed.toLocaleString()} failed`);
      }
    } finally {
      setExecuting(false);
    }
  };

  const handleAction = async () => {
    if (!canRun) return;
    if (format === 'sql' && mode === 'editor') {
      if (!connectionId) {
        toast.error('No active connection to open the editor for');
        return;
      }
      onOpenInEditor(connectionId, fileName, contents);
      onClose();
      return;
    }
    if (isRowImport) {
      await runRowImport();
    } else {
      await runSqlImport();
    }
  };

  const actionLabel =
    format === 'sql'
      ? mode === 'execute'
        ? 'Execute import'
        : 'Open in editor'
      : `Import ${rowCount > 0 ? rowCount.toLocaleString() + ' ' : ''}row${rowCount === 1 ? '' : 's'}`;

  return (
    <>
    <Dialog open={isOpen && !progress} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl w-[92vw] max-h-[85vh] overflow-hidden flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            Import Data
          </DialogTitle>
          <DialogDescription>
            Pick a file and format, then run it against {connectionName}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">
          {/* Format selector */}
          <Field label="Format">
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${availableFormats.length}, minmax(0,1fr))` }}
            >
              {availableFormats.map((f) => {
                const active = format === f.value;
                const Icon = f.icon;
                return (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFormat(f.value)}
                    disabled={executing}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors ${
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                    } ${executing ? 'opacity-60 cursor-not-allowed' : ''}`}
                  >
                    <Icon className="w-4 h-4" />
                    {f.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed mt-1.5">
              {FORMATS.find((f) => f.value === format)?.hint}
            </p>
          </Field>

          {/* File picker — drop-zone card, matching the connection-import UI. */}
          <Field label="File">
            <div className="rounded-lg border border-dashed border-border py-10 flex flex-col items-center gap-3 text-center">
              {loadingFile ? (
                <Loader2 className="w-8 h-8 text-muted-foreground/40 animate-spin" />
              ) : (
                <FileText className="w-8 h-8 text-muted-foreground/40" />
              )}
              <div>
                <p className="text-sm text-muted-foreground">
                  {fileName && !loadingFile
                    ? fileName
                    : loadingFile
                      ? 'Reading file…'
                      : 'No file selected'}
                </p>
                <p className="text-xs text-muted-foreground/60 mt-0.5 max-w-xs">
                  {fileName && !loadingFile && stats
                    ? `${
                        stats.kind === 'sql'
                          ? `~${stats.approxStatements.toLocaleString()} statements`
                          : `${stats.rows.toLocaleString()} rows`
                      } · ${formatBytes(stats.bytes)}`
                    : 'SQL, CSV, or JSON'}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={pickFile}
                disabled={loadingFile || executing}
              >
                <FileText className="w-3.5 h-3.5" />
                {filePath ? 'Choose a different file' : 'Choose file'}
              </Button>
            </div>
          </Field>

          {/* CSV/JSON target picker */}
          {isRowImport && contents && (
            <div className="grid grid-cols-2 gap-3">
              {schemas.length > 1 && (
                <Field label="Target database">
                  <Select value={targetSchema} onValueChange={setTargetSchema} disabled={executing}>
                    <SelectTrigger className="w-full">
                      <Database className="w-3.5 h-3.5 text-muted-foreground mr-1.5 shrink-0" />
                      <SelectValue placeholder="Select database" />
                    </SelectTrigger>
                    <SelectContent>
                      {schemas.map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label={isDocumentTarget(dialect) ? 'Target collection' : 'Target table'}>
                <Select
                  value={targetTable}
                  onValueChange={setTargetTable}
                  disabled={executing || targetTables.length === 0}
                >
                  <SelectTrigger className="w-full">
                    <Table2 className="w-3.5 h-3.5 text-muted-foreground mr-1.5 shrink-0" />
                    <SelectValue
                      placeholder={targetTables.length === 0 ? 'No tables' : 'Select table'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {targetTables.map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}

          {/* No-table guidance — replaces the old hard error popup. */}
          {isRowImport && contents && !parsed?.error && targetTables.length === 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 px-3 py-2 text-xs flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="min-w-0">
                There are no {isDocumentTarget(dialect) ? 'collections' : 'tables'} in this database yet.{' '}
                {supportsSql
                  ? 'Create one first (or import a .sql file that creates it), then re-run this row import.'
                  : 'Create one first, then re-run this row import.'}
              </span>
            </div>
          )}

          {/* Mode selector — SQL only (CSV/JSON have no "open in editor"). */}
          {format === 'sql' && (
            <Field label="What should happen?">
              <div className="flex flex-col gap-2">
                <ModeOption
                  value="execute"
                  current={mode}
                  onChange={setMode}
                  title="Execute immediately"
                  hint="Runs every statement against the current connection now. Safer for small, trusted dumps."
                  disabled={executing}
                />
                <ModeOption
                  value="editor"
                  current={mode}
                  onChange={setMode}
                  title="Open in editor"
                  hint="Loads the file into a new SQL tab so you can review, edit, and run it step by step."
                  disabled={executing}
                />
              </div>
            </Field>
          )}

          {/* Target-database hint (MySQL SQL only). */}
          {format === 'sql' && mode === 'execute' && targetDatabase && (
            <div className="text-xs text-muted-foreground">
              Runs inside{' '}
              <span className="font-mono text-foreground">{targetDatabase}</span>.
              Dumps that declare their own <span className="font-mono">USE</span>{' '}
              or <span className="font-mono">CREATE DATABASE</span> are left untouched.
            </div>
          )}

          {/* Parse error (CSV/JSON) */}
          {parsed?.error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 text-destructive px-3 py-2 text-xs flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="min-w-0">
                Couldn’t parse this {format.toUpperCase()} file: {parsed.error}
              </span>
            </div>
          )}

          {/* Preview — only for files small enough to render cheaply. */}
          {contents && (
            <Field label="Preview">
              {previewable ? (
                <pre className="text-[11px] leading-tight font-mono bg-muted/40 border border-border/50 rounded-md p-2 max-h-48 overflow-auto whitespace-pre">
                  {contents.length > PREVIEW_MAX_CHARS
                    ? contents.slice(0, PREVIEW_MAX_CHARS) +
                      `\n\n… ${(contents.length - PREVIEW_MAX_CHARS).toLocaleString()} more chars hidden from preview (full file is still imported) …`
                    : contents}
                </pre>
              ) : (
                <div className="text-xs text-muted-foreground rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
                  File is {formatBytes(fileBytes)} — too large to preview. It will
                  still be imported in full.
                </div>
              )}
            </Field>
          )}

          {/* Run progress (bar + log + cancel) is shown in a dedicated
              ProgressDialog popup while executing — see below. */}

          {/* Post-run summary */}
          {report && (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                report.failed > 0
                  ? 'border-destructive/50 bg-destructive/10 text-destructive'
                  : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-500'
              }`}
            >
              <div className="font-medium flex items-center gap-1.5">
                {report.failed > 0 ? (
                  <AlertCircle className="w-3.5 h-3.5" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                {report.failed === 0
                  ? `${report.ok.toLocaleString()} ${isRowImport ? 'row' : 'statement'}${report.ok === 1 ? '' : 's'} imported successfully`
                  : `${report.failed.toLocaleString()} ${isRowImport ? 'row' : 'statement'}${report.failed === 1 ? '' : 's'} failed, ${report.ok.toLocaleString()} succeeded`}
              </div>
              {report.firstError && (
                <div className="mt-1 font-mono opacity-80 whitespace-pre-wrap wrap-break-word">
                  First error: {report.firstError}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-t border-border/60 bg-muted/10 px-5 py-3.5 sm:justify-between items-center">
          <span className="text-xs text-muted-foreground min-w-0 truncate">
            {!filePath
              ? 'Choose a file to import.'
              : isRowImport && !supportsRowInsert
                ? 'This connection can’t accept row imports.'
                : isRowImport && targetTables.length === 0
                  ? (supportsSql
                      ? 'No table here yet — create one first, or import a .sql file instead.'
                      : 'No table here yet — create a table before importing rows.')
                  : isRowImport && rowCount === 0 && !parsed?.error
                    ? 'No rows found in this file.'
                    : ''}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={executing}>
              {report ? 'Close' : 'Cancel'}
            </Button>
            <Button onClick={handleAction} disabled={!canRun || (isRowImport && !supportsRowInsert)}>
              {executing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              {actionLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ProgressDialog
      open={progress !== null}
      title="Import Data"
      state={progress}
      onCancel={() => {
        // Only the row-insert loop checks this; SQL runs server-side as one call.
        cancelRef.current = true;
      }}
      onClose={() => {
        if (progress?.phase === 'running') return;
        setProgress(null);
        // Close the whole import flow once the run settled successfully.
        if (progress?.phase === 'done') onClose();
      }}
    />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ModeOption({
  value,
  current,
  onChange,
  title,
  hint,
  disabled,
}: {
  value: 'execute' | 'editor';
  current: 'execute' | 'editor';
  onChange: (v: 'execute' | 'editor') => void;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(value)}
      className={`text-left rounded-md border px-3 py-2 transition-colors ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border/60 hover:border-border hover:bg-muted/40'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
            selected ? 'border-primary' : 'border-muted-foreground/50'
          }`}
        >
          {selected && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
        </span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="mt-1 ml-5 text-xs text-muted-foreground">{hint}</div>
    </button>
  );
}

/** Map a file extension to its most likely import format. */
function guessFormat(ext: string): ImportFormat | null {
  if (['sql', 'ddl'].includes(ext)) return 'sql';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (['json', 'ndjson', 'jsonl'].includes(ext)) return 'json';
  return null; // .txt — leave the current selection
}

/** SQL adapters call the target a "table"; document stores a "collection". */
function isDocumentTarget(dialect: ImportDialect): boolean {
  return dialect === null;
}

/**
 * Parse a CSV (or TSV) string into row objects keyed by the header row.
 * Handles quoted fields with embedded commas, quotes (`""`), and newlines,
 * and auto-detects `\t` vs `,` from the header. Values stay strings — the
 * adapter coerces them to column types on insert. Empty unquoted fields
 * become `null` so they hit column defaults instead of empty strings.
 */
function parseCsv(text: string): Record<string, unknown>[] {
  const rows = parseDelimited(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip fully-empty trailing lines.
    if (cells.length === 1 && cells[0] === '') continue;
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      const v = cells[c];
      obj[key] = v === undefined || v === '' ? null : v;
    }
    out.push(obj);
  }
  return out;
}

/** Tokenize delimited text into a 2D array of cells. */
function parseDelimited(text: string): string[][] {
  // Detect delimiter from the first line: tab if present, else comma.
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // swallow — handled by the following \n
    } else {
      field += ch;
    }
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse JSON rows. Accepts either a top-level array of objects, a single
 * object, or newline-delimited JSON (NDJSON / JSONL — one object per line).
 * Non-object array members are rejected with a clear error.
 */
function parseJsonRows(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Array or single object → standard JSON.
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : [data];
    return arr.map((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`item ${i + 1} is not an object`);
      }
      return item as Record<string, unknown>;
    });
  }
  // Otherwise assume NDJSON — one object per non-empty line.
  const out: Record<string, unknown>[] = [];
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not valid JSON`);
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`line ${i + 1} is not an object`);
    }
    out.push(item as Record<string, unknown>);
  }
  return out;
}

/** Build the final SQL payload sent to the adapter. Two transforms:
 *
 *  1. **`USE <db>;` prefix** — MySQL dumps often omit this and the
 *     adapter's connection has no default schema set, so statements
 *     land in limbo. We prepend it when `targetDatabase` is supplied
 *     AND the dump doesn't already declare its own.
 *
 *  2. **Import-safety wrapper** — foreign-key checks, unique checks,
 *     and strict SQL modes routinely trip on legitimate dumps that
 *     forward-reference tables or rely on implicit conversions.
 *     Standard mysqldump output already carries its own prologue /
 *     epilogue for this; non-standard dumps don't. We wrap
 *     unconditionally — it's idempotent if the dump disabled the same
 *     checks itself, and the per-statement error loop in the adapter
 *     means the closing block ALWAYS runs, even if the middle failed.
 */
function buildPayload(
  sql: string,
  targetDatabase: string | null | undefined,
  dialect: ImportDialect,
): string {
  let out = sql;
  if (dialect === 'mysql' && targetDatabase) {
    const head = out
      .split('\n')
      .filter((l) => !/^\s*(--|#|$)/.test(l))
      .slice(0, 5)
      .join('\n');
    if (!/^\s*(USE\s+|CREATE\s+DATABASE\b)/i.test(head)) {
      const quoted = '`' + targetDatabase.replace(/`/g, '``') + '`';
      out = `USE ${quoted};\n${out}`;
    }
  }

  if (dialect === 'mysql') {
    const prologue = [
      '-- Import safety prologue (Table Relay)',
      'SET @_OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS;',
      'SET @_OLD_UNIQUE_CHECKS = @@UNIQUE_CHECKS;',
      'SET @_OLD_SQL_MODE = @@SQL_MODE;',
      'SET FOREIGN_KEY_CHECKS = 0;',
      'SET UNIQUE_CHECKS = 0;',
      "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
    ].join('\n');
    const epilogue = [
      '-- Import safety epilogue (Table Relay)',
      'SET SQL_MODE = @_OLD_SQL_MODE;',
      'SET UNIQUE_CHECKS = @_OLD_UNIQUE_CHECKS;',
      'SET FOREIGN_KEY_CHECKS = @_OLD_FOREIGN_KEY_CHECKS;',
    ].join('\n');
    return `${prologue}\n${out}\n${epilogue}\n`;
  }

  if (dialect === 'sqlite') {
    return [
      '-- Import safety prologue (Table Relay)',
      'PRAGMA foreign_keys = OFF;',
      out,
      '-- Import safety epilogue (Table Relay)',
      'PRAGMA foreign_keys = ON;',
      '',
    ].join('\n');
  }

  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
