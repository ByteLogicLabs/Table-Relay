import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Check, X, RefreshCw, Loader2, AlertCircle, AlignLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { ConnectionProfile } from '../../types';
import { db, isDbError, type TriggerDefinition } from '../../lib/db';
import { formatSql, languageForDialect } from '../../lib/format-sql';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { dialectFromManifest } from '../data-grid/editor-kinds';
import { useSettings } from '../../lib/settings-store';
import { pickMonacoTheme, ddlEditorOptions } from '../sql-editor/sql-editor-utils';

interface LogQueryOptions {
  source?: 'editor' | 'grid' | 'system';
  durationMs?: number;
  status?: 'ok' | 'error';
  message?: string;
}

interface TriggerViewProps {
  connection: ConnectionProfile;
  schema: string;
  /** Trigger name; ignored when `isNew`. */
  name: string;
  /** When true, seed the buffer with a dialect-appropriate scaffold. */
  isNew?: boolean;
  /** Optional prefill DDL (e.g. AI-supplied CREATE TRIGGER). When present it
   *  seeds the editor buffer instead of the scaffold/fetched definition. */
  initialSql?: string;
  /** Persisted in-progress buffer from the owning tab. When present (the user
   *  switched away and back), it's the source of truth — we don't refetch or
   *  re-scaffold, so unsaved edits are preserved. */
  draft?: string;
  /** Notifies the workspace of buffer edits so they can be persisted on the
   *  tab across unmounts. */
  onDraftChange?: (draft: string) => void;
  /** Notifies the workspace whether there are unsaved edits (drives the tab's
   *  unsaved dot). */
  onDirtyChange?: (dirty: boolean) => void;
  onLogQuery?: (statement: string, opts?: LogQueryOptions) => void;
}

type Dialect = ReturnType<typeof dialectFromManifest>;

/** Pull the trigger name out of a `CREATE TRIGGER [IF NOT EXISTS] <name>` head.
 *  Handles backtick / double-quote / bracket quoting and optional schema
 *  qualification (`schema.trigger`). Returns the bare trigger identifier, or
 *  null when it can't be parsed (caller falls back to the known name). */
function parseTriggerName(sql: string): string | null {
  const m = sql.match(
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+?)\s+(?:BEFORE|AFTER|INSTEAD)\b/i,
  );
  if (!m) return null;
  let ref = m[1].trim();
  // Drop a schema qualifier: keep the part after the last unquoted dot.
  // Simple split is fine here — trigger identifiers rarely contain a literal
  // dot, and quoted ones are unwrapped below regardless.
  const lastDot = ref.lastIndexOf('.');
  if (lastDot >= 0) ref = ref.slice(lastDot + 1).trim();
  // Unwrap one layer of quoting.
  if (ref.startsWith('`') && ref.endsWith('`')) return ref.slice(1, -1).replace(/``/g, '`');
  if (ref.startsWith('"') && ref.endsWith('"')) return ref.slice(1, -1).replace(/""/g, '"');
  if (ref.startsWith('[') && ref.endsWith(']')) return ref.slice(1, -1);
  return ref || null;
}

/** Backtick-quote (MySQL). */
function q(ident: string): string {
  return '`' + ident.replace(/`/g, '``') + '`';
}
/** Double-quote (ANSI: Postgres / SQLite). */
function qd(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}

/** A starter CREATE TRIGGER template per dialect. */
function scaffoldFor(dialect: Dialect, schema: string): string {
  if (dialect === 'postgres') {
    // Postgres triggers call a function via EXECUTE FUNCTION. Seed both the
    // function and the trigger so the example runs end-to-end after editing.
    return [
      '-- Postgres triggers call a trigger function. Create the function first,',
      '-- then the trigger. Edit names/bodies to taste.',
      `CREATE OR REPLACE FUNCTION ${qd(schema)}."new_trigger_fn"()`,
      'RETURNS trigger AS $$',
      'BEGIN',
      '  -- NEW / OLD are available here.',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      '',
      `CREATE TRIGGER "new_trigger"`,
      `BEFORE INSERT ON ${qd(schema)}."your_table"`,
      `FOR EACH ROW EXECUTE FUNCTION ${qd(schema)}."new_trigger_fn"();`,
      '',
    ].join('\n');
  }
  if (dialect === 'sqlite') {
    return [
      'CREATE TRIGGER "new_trigger"',
      'AFTER INSERT ON "your_table"',
      'FOR EACH ROW',
      'BEGIN',
      '  -- Reference NEW.col / OLD.col here.',
      "  SELECT NEW.rowid;",
      'END;',
      '',
    ].join('\n');
  }
  // MySQL / generic.
  return [
    `CREATE TRIGGER ${q('new_trigger')}`,
    `BEFORE INSERT ON ${q('your_table')}`,
    'FOR EACH ROW',
    'BEGIN',
    '  -- Reference NEW.col / OLD.col here.',
    '  SET NEW.created_at = NOW();',
    'END',
    '',
  ].join('\n');
}

/**
 * Trigger editor. The Monaco buffer holds the full `CREATE TRIGGER …` text
 * (for Postgres, optionally the trigger function too). Save sends the buffer as
 * the `createSql` to `db.saveTrigger`, which drops the prior definition (when
 * editing) and runs the statement. This whole-statement approach is the only
 * portable one: Postgres/SQLite triggers don't decompose into a simple body.
 */
export default function TriggerView({
  connection, schema, name, isNew, initialSql, draft: persistedDraft, onDraftChange, onDirtyChange, onLogQuery,
}: TriggerViewProps) {
  const manifests = useAdapterManifests();
  const settings = useSettings();
  const activeManifest = resolveManifest(manifests, connection.driver);
  const dialect = dialectFromManifest(activeManifest?.capabilities ?? null);
  // Use the manifest's Monaco language id (pgsql / mysql / …) for accurate
  // highlighting, matching the query editor; fall back to generic SQL.
  const editorLanguage = activeManifest?.queryEditor?.language?.trim() || 'sql';

  // Follow the app's active Monaco theme (same as the query editor) instead of
  // hardcoding vs-dark — keeps the DDL editor consistent in light/dark/monokai.
  const [theme, setTheme] = useState<string>(pickMonacoTheme);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(pickMonacoTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  // An AI-supplied DDL prefill means we don't fetch/scaffold — the buffer is
  // seeded from `initialSql` and the user reviews + saves.
  const seeded = (initialSql ?? '').trim();
  const hasSeed = seeded.length > 0;
  // A persisted tab draft means the user already edited this tab and switched
  // away — restore their buffer verbatim and never re-scaffold/overwrite it.
  // `undefined` = never edited; `''` is a legitimate (emptied) buffer.
  const hasPersistedDraft = persistedDraft !== undefined;

  const [def, setDef] = useState<TriggerDefinition | null>(null);
  // Only show the loading spinner when we actually need to fetch the existing
  // definition (not new, not seeded, and no restored draft).
  const [loading, setLoading] = useState(!isNew && !hasSeed && !hasPersistedDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // True once the user has made at least one explicit edit via the Monaco
  // onChange callback. Prevents the scaffold (or a restored persisted draft)
  // from immediately flagging the tab as dirty before any real typing.
  const [userEdited, setUserEdited] = useState(hasPersistedDraft || hasSeed);
  const [draft, setDraftState] = useState(() =>
    hasPersistedDraft
      ? (persistedDraft as string)
      : hasSeed
        ? seeded
        : isNew
          ? scaffoldFor(dialect, schema)
          : '',
  );
  // Baseline for the dirty check.
  //   - hasSeed (AI prefill): empty so the buffer is immediately dirty (user
  //     must review + save a supplied statement).
  //   - isNew (blank scaffold): matches the initial draft so a fresh
  //     scaffold is NOT dirty until the user actually edits it.
  //   - existing trigger: set after the describe fetch resolves.
  const [baseline, setBaseline] = useState(() =>
    hasSeed ? '' : isNew ? scaffoldFor(dialect, schema) : '',
  );

  // Setter for user-initiated edits: marks the tab as intentionally edited,
  // persists the buffer on the tab, and updates local state.
  const setDraft = (next: string) => {
    setUserEdited(true);
    setDraftState(next);
    onDraftChange?.(next);
  };

  const load = async (lookupName: string = name) => {
    setLoading(true);
    setError(null);
    try {
      const d = await db.describeTrigger(connection.id, schema, lookupName);
      setDef(d);
      setDraft(d.createSql || '');
      setBaseline(d.createSql || '');
    } catch (e) {
      setError(isDbError(e) ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasSeed) {
      // AI-prefilled buffer — nothing to fetch or scaffold.
      return;
    }
    if (isNew) {
      if (hasPersistedDraft) return; // keep the user's restored buffer
      // Re-seed the scaffold if the dialect resolves after first paint.
      const s = scaffoldFor(dialect, schema);
      setDraftState(s);
      setBaseline(s);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await db.describeTrigger(connection.id, schema, name);
        if (cancelled) return;
        setDef(d);
        setBaseline(d.createSql || '');
        // Only overwrite the buffer with the fetched DDL when the user has no
        // restored draft — otherwise we'd clobber their unsaved edits.
        if (!hasPersistedDraft) setDraftState(d.createSql || '');
      } catch (e) {
        if (!cancelled) setError(isDbError(e) ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `persistedDraft` intentionally excluded: it changes on every keystroke
    // (we echo edits up to the tab), and re-running this effect would refetch /
    // reset on each character. We only key on the trigger's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, schema, name, isNew, dialect, hasSeed]);

  // Only dirty after the user has made at least one explicit edit. This prevents
  // the scaffold (new trigger) or a restored persisted buffer (tab switch-back)
  // from showing the unsaved dot before any real typing.
  const dirty = userEdited && draft.trim().length > 0 && draft !== baseline;

  // Surface dirty state to the owning tab (drives the unsaved dot). We do NOT
  // reset on unmount: switching tabs unmounts this editor, but the buffer is
  // Report dirty changes to the owning tab. Skip the initial mount render so the
  // dot never flickers on — only fire when the value actually transitions after
  // the editor is interactive.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const save = async () => {
    const body = draft.trim();
    if (!body) {
      toast.error('Trigger statement is empty');
      return;
    }
    // The trigger name in the edited SQL is authoritative — the user may have
    // renamed it. Fall back to the known name when it can't be parsed.
    const prevName = def?.name ?? (name !== '(new)' ? name : undefined);
    const savedName = parseTriggerName(body) ?? prevName;
    setSaving(true);
    const started = performance.now();
    try {
      onLogQuery?.(body, { source: 'system' });
      await db.saveTrigger(connection.id, {
        schema,
        // The structured fields aren't authoritative for the whole-statement
        // path; the backend parses everything it needs from `createSql`. We
        // pass the parsed name so MySQL's drop targets the right trigger, and
        // originalName (the prior name) when editing so a rename drops the old.
        name: savedName ?? '',
        originalName: prevName ?? null,
        table: def?.table ?? '',
        timing: def?.timing ?? '',
        event: def?.event ?? '',
        body: '',
        createSql: body,
      });
      const elapsed = performance.now() - started;
      onLogQuery?.(body, {
        source: 'system',
        status: 'ok',
        durationMs: elapsed,
        message: 'trigger saved',
      });
      toast.success('Saved trigger');
      // Re-sync the sidebar's trigger list.
      window.dispatchEvent(new CustomEvent('tablerelay:reload'));
      // The save succeeded — mark the current buffer as the clean baseline so
      // the dirty indicator clears. Then try to refetch by the name actually
      // written (handles renames / new triggers). A refetch miss is non-fatal:
      // the save already went through, so we keep the buffer instead of showing
      // a scary "not found" error over a successful save.
      // Reset userEdited — the buffer is now the saved state.
      setUserEdited(false);
      setBaseline(body);
      if (savedName) {
        try {
          const d = await db.describeTrigger(connection.id, schema, savedName);
          setDef(d);
          setDraftState(d.createSql || '');   // internal only; no user edit
          setBaseline(d.createSql || '');
          onDraftChange?.(d.createSql || ''); // keep tab.trigger.draft in sync
        } catch {
          // Keep the buffer + baseline=body; sidebar reload still reflects truth.
        }
      }
    } catch (e) {
      const msg = isDbError(e) ? e.message : String(e);
      onLogQuery?.(body, { source: 'system', status: 'error', message: msg });
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setUserEdited(false);
    setDraftState(baseline);
    onDraftChange?.(baseline);
  };

  const prettify = () => {
    const { formatted, error: err } = formatSql(draft, {
      language: languageForDialect(dialect),
    });
    if (err) {
      toast.error(`Format failed: ${err}`);
      return;
    }
    setDraft(formatted);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading trigger…
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

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="h-12 shrink-0 border-b border-border flex items-center justify-between gap-3 px-4 bg-muted/10">
        <div className="flex items-center gap-2">
          {!isNew && (
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
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
          TRIGGER · {schema}.{def?.name ?? (isNew ? '(new)' : name)}
          {def?.table && <span className="opacity-70"> · on {def.table}</span>}
        </div>
      </div>

      {/* Body editor — the entire CREATE TRIGGER statement lives here. */}
      <div className="flex-1 min-h-0">
        <Editor
          language={editorLanguage}
          value={draft}
          onChange={v => setDraft(v ?? '')}
          theme={theme}
          options={ddlEditorOptions({
            fontSize: settings.editorFontSize,
            wordWrap: settings.editorWordWrap,
            minimap: settings.editorMinimap,
            tabSize: settings.editorTabSize,
          })}
        />
      </div>
    </div>
  );
}
