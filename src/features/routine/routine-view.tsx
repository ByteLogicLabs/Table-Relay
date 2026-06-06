import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Check, X, RefreshCw, Loader2, AlertCircle, AlignLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { ConnectionProfile } from '../../types';
import { db, isDbError, type RoutineDefinition } from '../../lib/db';
import { formatSql, languageForDialect } from '../../lib/format-sql';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { dialectFromManifest } from '../data-grid/editor-kinds';

interface LogQueryOptions {
  source?: 'editor' | 'grid' | 'system';
  durationMs?: number;
  status?: 'ok' | 'error';
  message?: string;
}

interface RoutineViewProps {
  connection: ConnectionProfile;
  schema: string;
  name: string;
  kind: 'function' | 'procedure' | 'view';
  /** When true, skip the describe fetch and seed the buffer with a scaffold. */
  isNew?: boolean;
  /** Reports unsaved state to the owning tab (drives the unsaved dot). */
  onDirtyChange?: (dirty: boolean) => void;
  onLogQuery?: (statement: string, opts?: LogQueryOptions) => void;
}

function scaffoldFor(kind: 'function' | 'procedure' | 'view', schema: string): string {
  if (kind === 'view') {
    return `CREATE VIEW ${q(schema)}.\`new_view\` AS\nSELECT 1 AS hello;\n`;
  }
  if (kind === 'function') {
    return [
      `CREATE FUNCTION ${q(schema)}.\`new_function\`(arg INT)`,
      'RETURNS INT',
      'DETERMINISTIC',
      'CONTAINS SQL',
      'BEGIN',
      '  RETURN arg + 1;',
      'END',
      '',
    ].join('\n');
  }
  return [
    `CREATE PROCEDURE ${q(schema)}.\`new_procedure\`(IN arg INT)`,
    'CONTAINS SQL',
    'BEGIN',
    '  SELECT arg;',
    'END',
    '',
  ].join('\n');
}

function q(ident: string): string {
  return '`' + ident.replace(/`/g, '``') + '`';
}

/** Double-quote an identifier for ANSI dialects (Postgres / SQLite). */
function qd(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}

/**
 * Fetch a view's CREATE DDL as editor text, per dialect. MySQL uses
 * SHOW CREATE VIEW; Postgres has no such statement (pg_get_viewdef returns the
 * SELECT body, which we wrap); SQLite stores the original text in
 * sqlite_master. Returns the text to drop into the editor buffer.
 */
async function loadViewDdl(
  connectionId: string,
  schema: string,
  name: string,
  dialect: ReturnType<typeof dialectFromManifest>,
): Promise<string> {
  if (dialect === 'postgres') {
    const qualified = `${qd(schema)}.${qd(name)}`;
    const res = await db.runQuery(
      connectionId,
      `SELECT pg_get_viewdef('${qualified.replace(/'/g, "''")}'::regclass, true) AS def`,
    );
    const last = res.statements[res.statements.length - 1];
    if (!last || last.error) throw new Error(last?.error ?? 'no definition returned');
    const body = last.rows[0]?.[0];
    if (typeof body !== 'string') throw new Error('definition not found in response');
    return `CREATE OR REPLACE VIEW ${qualified} AS\n${body.trim()}\n`;
  }
  if (dialect === 'sqlite') {
    const res = await db.runQuery(
      connectionId,
      `SELECT sql FROM sqlite_master WHERE type='view' AND name='${name.replace(/'/g, "''")}'`,
    );
    const last = res.statements[res.statements.length - 1];
    if (!last || last.error) throw new Error(last?.error ?? 'no definition returned');
    const ddl = last.rows[0]?.[0];
    if (typeof ddl !== 'string') throw new Error('definition not found in response');
    return `${ddl.trim()};\n`;
  }
  // MySQL / generic.
  const res = await db.runQuery(connectionId, `SHOW CREATE VIEW ${q(schema)}.${q(name)}`);
  const last = res.statements[res.statements.length - 1];
  if (!last || last.error) throw new Error(last?.error ?? 'no definition returned');
  const idx = last.columns.findIndex(c => /create view/i.test(c.name));
  return idx >= 0 ? String(last.rows[0]?.[idx] ?? '') : '';
}

/**
 * MySQL's SHOW CREATE always includes a `DEFINER=\`user\`@\`host\`` clause
 * between the verb and the routine type. The user never needs to see or edit
 * it — on save the server re-applies the current session's user — so we strip
 * it from the editor buffer for a cleaner view. Quoting rules: identifiers can
 * be backtick-quoted with escaped backticks, or unquoted; host can also be a
 * plain string. The regex covers both shapes.
 */
function stripDefiner(ddl: string): string {
  return ddl.replace(
    /\s+DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|\S+?)@(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|\S+)/i,
    '',
  );
}

/**
 * Minimal routine editor: the Monaco buffer is the entire `CREATE FUNCTION …`
 * (or `CREATE PROCEDURE …`) DDL, exactly as SHOW CREATE returns it. Save does
 * a DROP + CREATE in one batch via the text protocol so the server parses the
 * body with its internal `;` in one shot.
 */
export default function RoutineView({
  connection, schema, name, kind, isNew, onDirtyChange, onLogQuery,
}: RoutineViewProps) {
  const manifests = useAdapterManifests();
  const dialect = dialectFromManifest(
    resolveManifest(manifests, connection.driver)?.capabilities ?? null,
  );
  const isPg = dialect === "postgres";
  const isSqlite = dialect === "sqlite";

  const [def, setDef] = useState<RoutineDefinition | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraftState] = useState(() => isNew ? scaffoldFor(kind, schema) : '');
  // Baseline we compare drafts against — empty string for new objects so any
  // edit counts as dirty immediately.
  const baselineRef = useState(() => isNew ? scaffoldFor(kind, schema) : '')[0];
  // True once the user has made at least one explicit edit via Monaco onChange.
  // Prevents the scaffold from showing the unsaved dot before any typing.
  const [userEdited, setUserEdited] = useState(false);

  const load = async () => {
    if (kind === 'view') {
      // Views aren't routines; fetch via SHOW CREATE VIEW into the same shape.
      setLoading(true);
      setError(null);
      try {
        const ddl = await loadViewDdl(connection.id, schema, name, dialect);
        const synthetic: RoutineDefinition = {
          schema, name, kind: 'view',
          returns: null, parameters: [], body: '',
          isDeterministic: false, dataAccess: '', securityType: '', definer: '',
          createSql: ddl,
        };
        setDef(synthetic);
        setDraftState(stripDefiner(ddl));
      } catch (e) {
        setError(isDbError(e) ? e.message : String(e));
      } finally { setLoading(false); }
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const d = await db.describeRoutine(connection.id, schema, name, kind);
      setDef(d);
      setDraftState(stripDefiner(d.createSql || ''));
    } catch (e) {
      setError(isDbError(e) ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isNew) return; // scaffold already seeded; nothing to fetch.
    let cancelled = false;
    (async () => {
      try {
        if (kind === 'view') {
          const ddl = await loadViewDdl(connection.id, schema, name, dialect);
          if (cancelled) return;
          const synthetic: RoutineDefinition = {
            schema, name, kind: 'view',
            returns: null, parameters: [], body: '',
            isDeterministic: false, dataAccess: '', securityType: '', definer: '',
            createSql: ddl,
          };
          setDef(synthetic);
          setDraftState(stripDefiner(ddl));
        } else {
          const d = await db.describeRoutine(connection.id, schema, name, kind);
          if (cancelled) return;
          setDef(d);
          setDraftState(stripDefiner(d.createSql || ''));
        }
      } catch (e) {
        if (!cancelled) setError(isDbError(e) ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connection.id, schema, name, kind, isNew, dialect]);

  const dirty = userEdited && (isNew
    ? draft.trim().length > 0 && draft !== baselineRef
    : def ? draft !== stripDefiner(def.createSql || '') : false);

  // Report dirty changes to the owning tab. Skip the initial mount so the dot
  // never flickers on — only fires when the value transitions after mount.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const save = async () => {
    if (!def && !isNew) return;
    const typeWord = kind === 'function' ? 'FUNCTION' : kind === 'procedure' ? 'PROCEDURE' : 'VIEW';
    const body = draft.trim();
    let batch: string;

    if (isPg || isSqlite) {
      // Postgres & SQLite: no USE, no DELIMITER, ANSI quoting. The editor
      // buffer already holds a complete CREATE statement:
      //   - PG views/routines come from pg_get_viewdef/pg_get_functiondef as
      //     `CREATE OR REPLACE …`, runnable as-is (no DROP needed).
      //   - SQLite views are full `CREATE VIEW …` text; we DROP first since
      //     SQLite has no CREATE OR REPLACE VIEW.
      const lines: string[] = [];
      if (isSqlite && kind === 'view' && !isNew && def) {
        lines.push(`DROP VIEW IF EXISTS ${qd(def.name)};`);
      }
      lines.push(body.replace(/;\s*$/, '') + ';');
      batch = lines.join('\n');
    } else {
      // MySQL / generic: USE + DROP + (DELIMITER-wrapped) CREATE.
      const batchLines: string[] = [`USE ${q(schema)};`];
      if (!isNew && def) {
        batchLines.push(`DROP ${typeWord} IF EXISTS ${q(schema)}.${q(def.name)};`);
      }
      if (kind === 'view') {
        // Views don't need DELIMITER (no inner semicolons).
        batchLines.push(`${body.replace(/;\s*$/, '')};`);
      } else {
        batchLines.push('DELIMITER //');
        batchLines.push(`${body.replace(/;\s*$/, '')}//`);
        batchLines.push('DELIMITER ;');
      }
      batch = batchLines.join('\n');
    }

    setSaving(true);
    const started = performance.now();
    try {
      onLogQuery?.(batch, { source: 'system' });
      const res = await db.runQuery(connection.id, batch);
      const failed = res.statements.find(s => s.error);
      const elapsed = performance.now() - started;
      if (failed) {
        onLogQuery?.(failed.sql, {
          source: 'system',
          status: 'error',
          message: failed.error ?? 'unknown error',
          durationMs: failed.durationMs,
        });
        toast.error(`Save failed: ${failed.error}`, { description: failed.sql });
        return;
      }
      onLogQuery?.(batch, {
        source: 'system',
        status: 'ok',
        durationMs: elapsed,
        message: `${res.statements.length} statement${res.statements.length === 1 ? '' : 's'}`,
      });
      toast.success(`Saved ${kind}`);
      setUserEdited(false);
    } catch (e) {
      const msg = isDbError(e) ? e.message : String(e);
      onLogQuery?.(batch, { source: 'system', status: 'error', message: msg });
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setUserEdited(false);
    if (isNew) setDraftState(baselineRef);
    else if (def) setDraftState(stripDefiner(def.createSql || ''));
  };

  const prettify = () => {
    const { formatted, error: err } = formatSql(draft, {
      language: languageForDialect(dialect),
    });
    if (err) {
      toast.error(`Format failed: ${err}`);
      return;
    }
    setDraftState(formatted);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading {kind}…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 text-sm">
        <AlertCircle className="w-4 h-4 text-destructive" />
        {error}
      </div>
    );
  }
  if (!def && !isNew) return null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="h-12 shrink-0 border-b border-border flex items-center justify-between gap-3 px-4 bg-muted/10">
        <div className="flex items-center gap-2">
          {!isNew && (
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={save}>
            <Check className="w-4 h-4 mr-2" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}>
            <X className="w-4 h-4 mr-2" />
            Discard
          </Button>
          <Button variant="ghost" size="sm" onClick={prettify}>
            <AlignLeft className="w-4 h-4 mr-2" />
            Format SQL
          </Button>
        </div>
        <div className="text-xs text-muted-foreground font-mono truncate">
          {kind.toUpperCase()} · {schema}.{def?.name ?? (isNew ? '(new)' : '')}
          {def?.definer && <span className="opacity-70"> · definer {def.definer}</span>}
        </div>
      </div>

      {/* Body editor — the entire CREATE statement lives here. */}
      <div className="flex-1 min-h-0">
        <Editor
          defaultLanguage="sql"
          value={draft}
          onChange={v => { setUserEdited(true); setDraftState(v ?? ''); }}
          theme="vs-dark"
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
