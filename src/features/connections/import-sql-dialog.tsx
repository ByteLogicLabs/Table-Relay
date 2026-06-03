import { useCallback, useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import { Loader2, FileText, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { db } from '../../lib/db';
import { refreshSchemas } from '../../state/connections';

/**
 * "Import SQL" dialog — lets the user pick a `.sql` file, preview it,
 * and either run it against the active connection *immediately* (the
 * default action) or load it into a new query editor tab for review.
 *
 * Execution uses `db.runQuery` with the entire file as a single call;
 * the adapter splits statements itself (adapters already have robust
 * splitters that cope with `DELIMITER`, quoted identifiers, and
 * comments). Per-statement progress comes from the returned
 * `StatementResult[]` — we tally `rows_affected` / errors after the
 * fact rather than streaming progress, which keeps the dialog simple.
 */
/** Which import-safety prologue/epilogue to wrap the dump with. `null`
 *  means "don't add anything" — used for unknown adapters where we
 *  can't be sure the SQL-dialect-specific session tweaks would parse.
 *
 *  `postgres` behaves like `null` (no session wrapper, no `USE` prefix)
 *  because PG can't switch database mid-session and the per-dump
 *  `SET session_replication_role` trick needs a role most desktop
 *  users don't have. Dumps from `pg_dump` are safe to run as-is —
 *  they already carry their own `BEGIN;`/`COMMIT;` blocks. */
export type ImportDialect = 'mysql' | 'sqlite' | 'postgres' | null;

export default function ImportSqlDialog({
  isOpen,
  onClose,
  connectionId,
  connectionName,
  targetDatabase,
  dialect,
  onOpenInEditor,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Id of the live connection to run the import against. */
  connectionId: string | null;
  /** Display name of the connection — shown in the dialog title. */
  connectionName: string;
  /** Database currently focused on the rail for this connection, if any.
   *  Used to prepend `USE <db>;` for SQL-server-style adapters so
   *  `CREATE TABLE` in the dump lands in the right schema. Null for
   *  single-schema adapters (SQLite) — the dump runs as-is. */
  targetDatabase?: string | null;
  /** The adapter's SQL dialect, so we can wrap the dump with the right
   *  "disable FK checks, restore on finish" block. */
  dialect?: ImportDialect;
  /** Open the loaded SQL text in a new query tab for the given
   *  connection. The caller owns the tab machinery; we just hand back
   *  the contents. */
  onOpenInEditor: (connectionId: string, fileName: string, sql: string) => void;
}) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [contents, setContents] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [mode, setMode] = useState<'execute' | 'editor'>('execute');
  const [executing, setExecuting] = useState(false);
  // Per-statement outcome tally after a run.
  const [report, setReport] = useState<{
    ok: number;
    failed: number;
    firstError: string | null;
  } | null>(null);

  // Reset everything whenever the dialog closes/reopens — stale file
  // previews confuse users who re-open for a different import.
  useEffect(() => {
    if (!isOpen) {
      setFilePath(null);
      setFileName('');
      setContents('');
      setLoadingFile(false);
      setMode('execute');
      setExecuting(false);
      setReport(null);
    }
  }, [isOpen]);

  const pickFile = useCallback(async () => {
    try {
      const picked = await openDialog({
        title: 'Import SQL',
        multiple: false,
        directory: false,
        filters: [{ name: 'SQL file', extensions: ['sql', 'ddl', 'txt'] }],
      });
      if (typeof picked !== 'string' || !picked) return;
      setLoadingFile(true);
      setFilePath(picked);
      setFileName(picked.split('/').pop() ?? picked);
      setReport(null);
      const text = await readTextFile(picked);
      setContents(text);
    } catch (e) {
      toast.error(`Could not read file: ${String(e)}`);
    } finally {
      setLoadingFile(false);
    }
  }, []);

  // Rough line + statement count for the summary line. Statement count
  // is approximate — a semicolon inside a string literal inflates it —
  // but it's just informational so precision isn't worth the work.
  const stats = useMemo(() => {
    if (!contents) return null;
    const lines = contents.split('\n').length;
    const approxStatements = (contents.match(/;\s*(\n|$)/g) ?? []).length;
    const bytes = new TextEncoder().encode(contents).length;
    return { lines, approxStatements, bytes };
  }, [contents]);

  const canRun = !!filePath && !!contents && !loadingFile && !executing;

  const handleAction = async () => {
    if (!canRun) return;
    if (mode === 'editor') {
      if (!connectionId) {
        toast.error('No active connection to open the editor for');
        return;
      }
      onOpenInEditor(connectionId, fileName, contents);
      onClose();
      return;
    }
    // Execute immediately.
    if (!connectionId) {
      toast.error('No active connection to run the import against');
      return;
    }
    setExecuting(true);
    setReport(null);
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

      // Refresh the sidebar's schema/table list and any open data grids
      // whenever we ran SQL against the connection — even a partial
      // import may have created some tables, and the user needs to see
      // them without manually hitting ⌘+R. We fire both a schema refresh
      // and the global `tablerelay:reload` event (which DataGrid, Sidebar,
      // and DiagramView all listen for). Runs on success AND failure —
      // an import that failed at statement 40 of 60 might still have
      // created the first 39 tables.
      void refreshSchemas(connectionId);
      window.dispatchEvent(
        new CustomEvent('tablerelay:reload', { detail: { connectionId } }),
      );

      if (failed === 0) {
        toast.success(
          statements.length === 1
            ? 'Import complete (1 statement)'
            : `Import complete (${ok} statements)`,
        );
        // Auto-close on full success — the user doesn't need to see the
        // report when there's nothing to act on. Failures keep the
        // dialog open so the user can read the error + retry.
        onClose();
      } else {
        toast.error(
          `Import finished with ${failed} failing statement${failed === 1 ? '' : 's'}`,
        );
      }
    } catch (err) {
      // A runQuery-level error (connection dead, unsupported, etc.) —
      // no per-statement info available.
      const msg = err instanceof Error ? err.message : String(err);
      setReport({ ok: 0, failed: 1, firstError: msg });
      toast.error(`Import failed: ${msg}`);
    } finally {
      setExecuting(false);
    }
  };

  const actionLabel = mode === 'execute' ? 'Execute import' : 'Open in editor';

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl w-[92vw] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Import SQL · {connectionName}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto">
          {/* File picker row */}
          <div className="flex gap-2 items-center">
            <Button type="button" variant="outline" onClick={pickFile} disabled={loadingFile || executing}>
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              {filePath ? 'Replace file…' : 'Pick SQL file…'}
            </Button>
            {loadingFile && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Reading file…
              </span>
            )}
            {fileName && !loadingFile && (
              <span className="text-xs text-muted-foreground truncate" title={filePath ?? ''}>
                {fileName}
                {stats && (
                  <>
                    {' '}·{' '}
                    {stats.lines.toLocaleString()} lines ·{' '}
                    ~{stats.approxStatements.toLocaleString()} statements ·{' '}
                    {formatBytes(stats.bytes)}
                  </>
                )}
              </span>
            )}
          </div>

          {/* Mode selector */}
          <div className="grid gap-2">
            <label className="text-sm font-medium">What should happen?</label>
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
          </div>

          {/* Target-database hint (MySQL only). The import always runs
              inside the focused database — the user already chose it
              when opening the connection — so this is pure info. SQLite
              passes `targetDatabase=null` and this hides entirely. */}
          {mode === 'execute' && targetDatabase && (
            <div className="text-xs text-muted-foreground">
              Runs inside{' '}
              <span className="font-mono text-foreground">{targetDatabase}</span>.
              Dumps that declare their own <span className="font-mono">USE</span>{' '}
              or <span className="font-mono">CREATE DATABASE</span> are left untouched.
            </div>
          )}

          {/* Preview */}
          {contents && (
            <div className="grid gap-2 min-h-0 flex-1">
              <label className="text-sm font-medium">Preview</label>
              <pre className="text-[11px] leading-tight font-mono bg-muted/40 border border-border/50 rounded-md p-2 max-h-48 overflow-auto whitespace-pre">
                {contents.length > 4000
                  ? contents.slice(0, 4000) + `\n\n… ${(contents.length - 4000).toLocaleString()} more chars truncated from preview (full file will still be imported) …`
                  : contents}
              </pre>
            </div>
          )}

          {/* Post-run summary */}
          {report && (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${report.failed > 0
                ? 'border-destructive/50 bg-destructive/10 text-destructive'
                : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-500'
                }`}
            >
              <div className="font-medium flex items-center gap-1.5">
                {report.failed > 0 && <AlertCircle className="w-3.5 h-3.5" />}
                {report.failed === 0
                  ? `Executed ${report.ok} statement${report.ok === 1 ? '' : 's'} successfully`
                  : `${report.failed} statement${report.failed === 1 ? '' : 's'} failed, ${report.ok} succeeded`}
              </div>
              {report.firstError && (
                <div className="mt-1 font-mono opacity-80 whitespace-pre-wrap break-words">
                  First error: {report.firstError}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={onClose} disabled={executing}>
            {report ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={handleAction} disabled={!canRun}>
            {executing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      className={`text-left rounded-md border px-3 py-2 transition-colors ${selected
        ? 'border-primary bg-primary/5'
        : 'border-border/60 hover:border-border hover:bg-muted/40'
        } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${selected ? 'border-primary' : 'border-muted-foreground/50'
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
 *
 * Identifier quoting matches each dialect: MySQL uses backticks with
 * doubled-backtick escaping; SQLite uses double-quotes. For unknown
 * dialects we skip the wrapper and only do the `USE` prefix, which is
 * a safe no-op transformation.
 */
function buildPayload(
  sql: string,
  targetDatabase: string | null | undefined,
  dialect: ImportDialect,
): string {
  // Step 1: USE-prefix so the dump lands in the right schema. MySQL
  // only — other dialects either can't switch database mid-session
  // (Postgres) or have a single implicit one (SQLite).
  let out = sql;
  if (dialect === 'mysql' && targetDatabase) {
    const head = out
      .split('\n')
      .filter(l => !/^\s*(--|#|$)/.test(l))
      .slice(0, 5)
      .join('\n');
    if (!/^\s*(USE\s+|CREATE\s+DATABASE\b)/i.test(head)) {
      const quoted = '`' + targetDatabase.replace(/`/g, '``') + '`';
      out = `USE ${quoted};\n${out}`;
    }
  }

  // Step 2: safety wrapper. Stored session state in user-variables (for
  // MySQL) so the epilogue restores the *caller*'s settings rather than
  // hardcoding defaults — a connection the user left with
  // `FOREIGN_KEY_CHECKS=0` for their own reasons shouldn't get silently
  // re-enabled by an import.
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
    // SQLite has no way to read the old pragma value back into a script
    // variable, so we unconditionally re-enable FKs at the end. That
    // matches the defaults we set on connect (`foreign_keys(true)` in
    // the driver), so a re-enable won't surprise anyone.
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
