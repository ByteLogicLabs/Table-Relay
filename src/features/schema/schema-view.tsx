import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConnectionProfile } from '../../types';
import { db, isDbError, type ColumnInfo, type ForeignKey, type IndexInfo, type IndexKeyValue, type IndexSpecPayload, type TableStructure } from '../../lib/db';
import { ensureTableStructure, refreshTableStructure } from '../../state/connections';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { Loader2, AlertCircle, Plus, Trash2, Link2, Link2Off, Check, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { toast } from 'sonner';

interface LogQueryOptions {
  source?: 'editor' | 'grid' | 'system';
  durationMs?: number;
  status?: 'ok' | 'error';
  message?: string;
}

interface SchemaViewProps {
  tableName: string;
  connection: ConnectionProfile;
  /** Database / schema the table lives in. */
  schema?: string;
  isNew?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onLogQuery?: (statement: string, opts?: LogQueryOptions) => void;
  /** Fired after a successful create-table save with the chosen
   *  name. Lets the parent flip the tab from "new" mode to a normal
   *  structure tab targeting the now-real table — without that, the
   *  view stays stuck in `isNew` mode and the dirty indicator never
   *  clears even though the create already succeeded. */
  onTableCreated?: (savedName: string) => void;
}

export interface SchemaViewHandle {
  save: () => Promise<void>;
  discard: () => void;
  isDirty: () => boolean;
}

type ColumnKey = 'PRIMARY' | 'UNIQUE' | 'NONE';

interface DraftColumn {
  id: string;              // stable client id
  originalName: string | null; // null = freshly added row
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null; // null = NULL default
  key: ColumnKey;
  /** Free-form `EXTRA` — `AUTO_INCREMENT`, `ON UPDATE CURRENT_TIMESTAMP`, etc. */
  extra: string;
  characterSet: string;
  collation: string;
  pendingDelete: boolean;
}

/** Fallback types for adapters whose manifest declared no `column_types`.
 *  Keeps the picker usable with a reasonable generic SQL set instead of
 *  leaving the user with an empty dropdown. */
const FALLBACK_DATA_TYPES = [
  'bigint', 'boolean', 'char', 'date', 'datetime', 'decimal', 'double',
  'float', 'int', 'json', 'smallint', 'text', 'time', 'timestamp',
  'varchar(255)',
];

const STRINGY_TYPES = new Set([
  'char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'set',
]);
const TEMPORAL_TYPES = new Set(['datetime', 'timestamp', 'time', 'date']);

function typeRoot(type: string): string {
  const m = type.trim().toLowerCase().match(/^([a-z_]+)/);
  return m ? m[1] : '';
}

function isStringyType(type: string): boolean {
  return STRINGY_TYPES.has(typeRoot(type));
}

function extraOptionsFor(type: string): string[] {
  const root = typeRoot(type);
  const base = ['NONE', 'AUTO_INCREMENT', 'SERIAL DEFAULT VALUE'];
  if (TEMPORAL_TYPES.has(root)) base.push('ON UPDATE CURRENT_TIMESTAMP');
  return base;
}

/** SQL index algorithm — drives MySQL's `USING <algo>` clause. Mongo's
 *  schema editor doesn't render this column (per-field key types live
 *  inside the columns textbox instead), so this enum is SQL-only. */
type IndexAlgorithm = 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL';

interface DraftIndex {
  id: string;
  originalName: string | null;
  name: string;
  algorithm: IndexAlgorithm;
  isUnique: boolean;
  columns: string; // comma-separated
  pendingDelete: boolean;
}

type FkAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'SET DEFAULT';

interface DraftForeignKey {
  id: string;
  originalName: string | null;
  name: string;
  columns: string[];       // source columns on current table
  refTable: string;
  refColumns: string;      // comma-separated
  onUpdate: FkAction;
  onDelete: FkAction;
  pendingDelete: boolean;
}

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT'];
const SQL_INDEX_ALGORITHMS: IndexAlgorithm[] = ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL'];

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function columnKeyFor(col: ColumnInfo): ColumnKey {
  if (col.isPrimary) return 'PRIMARY';
  if (col.isUnique) return 'UNIQUE';
  return 'NONE';
}

function columnsToDrafts(cols: ColumnInfo[]): DraftColumn[] {
  return cols.map(c => ({
    id: makeId('col'),
    originalName: c.name,
    name: c.name,
    dataType: columnTypeString(c),
    nullable: c.nullable,
    defaultValue: c.default,
    key: columnKeyFor(c),
    extra: normaliseExtra(c.extra ?? ''),
    characterSet: c.characterSet ?? '',
    collation: c.collation ?? '',
    pendingDelete: false,
  }));
}

/** MySQL writes `EXTRA` lowercase (`auto_increment`, `on update CURRENT_TIMESTAMP`).
 *  Normalise to the uppercase forms we show in the combobox so draft equality
 *  checks don't see every row as dirty. */
function columnTypeString(c: ColumnInfo): string {
  // MySQL surfaces `int(10) unsigned` via COLUMN_TYPE (already includes length).
  // For drivers that still return a bare `dataType`, splice in the length so
  // the draft -> original diff stays accurate.
  return c.dataType.includes('(') ? c.dataType : (c.length ? `${c.dataType}(${c.length})` : c.dataType);
}

function normaliseExtra(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const up = s.toUpperCase();
  if (up === 'AUTO_INCREMENT') return 'AUTO_INCREMENT';
  if (up === 'ON UPDATE CURRENT_TIMESTAMP') return 'ON UPDATE CURRENT_TIMESTAMP';
  if (up === 'SERIAL DEFAULT VALUE') return 'SERIAL DEFAULT VALUE';
  return s;
}

function indexesToDrafts(idxs: IndexInfo[], defaultAlgorithm: IndexAlgorithm = 'BTREE'): DraftIndex[] {
  // We can't recover the original Mongo kind from `IndexInfo` (it's not
  // returned by `describe_table` today). For Mongo we default to
  // `regular` — if the user edits and saves, the index is dropped and
  // recreated with whatever kind is currently selected. Compass behaves
  // the same way: existing indexes can't be edited in place, only
  // dropped and recreated.
  return idxs.map(i => ({
    id: makeId('idx'),
    originalName: i.name,
    name: i.name,
    algorithm: defaultAlgorithm,
    isUnique: i.unique,
    columns: i.columns.join(', '),
    pendingDelete: false,
  }));
}

function fksToDrafts(fks: ForeignKey[]): DraftForeignKey[] {
  return fks.map(f => ({
    id: makeId('fk'),
    originalName: f.name,
    name: f.name,
    columns: [...f.fromColumns],
    refTable: f.toTable,
    refColumns: f.toColumns.join(', '),
    onUpdate: 'NO ACTION',
    onDelete: 'NO ACTION',
    pendingDelete: false,
  }));
}

// Dialect for `buildSaveBatch` comes from the adapter manifest now.
// Local re-exports of the type so DDL builders below stay self-contained.
import { dialectFromManifest, type Dialect } from '../data-grid/editor-kinds';

function q(ident: string, dialect: Dialect = 'mysql'): string {
  if (dialect === 'mysql') return '`' + ident.replace(/`/g, '``') + '`';
  return '"' + ident.replace(/"/g, '""') + '"';
}

function quoteQualified(schema: string, table: string, dialect: Dialect = 'mysql'): string {
  return `${q(schema, dialect)}.${q(table, dialect)}`;
}

function buildColumnClause(col: DraftColumn, dialect: Dialect = 'mysql'): string {
  const parts = [q(col.name, dialect), col.dataType.trim()];
  // CHARACTER SET / COLLATE only apply to string-ish types and are MySQL
  // syntax; Postgres uses `COLLATE "foo"` without CHARACTER SET, and
  // SQLite has no concept of either. Skip for non-MySQL to keep the
  // emitted DDL valid across dialects.
  if (dialect === 'mysql' && isStringyType(col.dataType)) {
    if (col.characterSet.trim()) parts.push(`CHARACTER SET ${col.characterSet.trim()}`);
    if (col.collation.trim()) parts.push(`COLLATE ${col.collation.trim()}`);
  }
  parts.push(col.nullable ? 'NULL' : 'NOT NULL');
  if (col.defaultValue !== null && col.defaultValue !== '') {
    parts.push(`DEFAULT ${col.defaultValue}`);
  }
  const extra = col.extra.trim();
  if (extra && extra.toUpperCase() !== 'NONE') {
    parts.push(extra);
  }
  return parts.join(' ');
}

function defaultFkName(table: string, col: string): string {
  return `fk_${table}_${col}`;
}

/** Generate a portable, deterministic index name when the user left
 *  the field blank. Mirrors common convention (`idx_table_col1_col2`,
 *  `uniq_…` for UNIQUE) so the schema diff stays readable. */
function defaultIndexName(table: string, cols: string[], unique: boolean): string {
  const prefix = unique ? 'uniq' : 'idx';
  return [prefix, table, ...cols].join('_');
}

const SchemaView = forwardRef<SchemaViewHandle, SchemaViewProps>(function SchemaView(
  { tableName, connection, schema, isNew, onDirtyChange, onTableCreated },
  ref,
) {
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  // After a successful create-table save we treat the view as no
  // longer new — even if the parent's `isNew` prop hasn't propagated
  // yet (the parent updates its tab state asynchronously). Without
  // this, the dirty calc stays in the `isNew` branch forever and the
  // "● unsaved changes" badge never clears.
  const [createdLocally, setCreatedLocally] = useState(false);
  const effectiveIsNew = !!isNew && !createdLocally;
  // If the parent prop comes back to `isNew=true` (e.g. user opened a
  // brand-new table in the same component instance after a previous
  // create), reset our local override so create-mode behaves correctly.
  useEffect(() => {
    if (!isNew && createdLocally) setCreatedLocally(false);
  }, [isNew, createdLocally]);

  const [columns, setColumns] = useState<DraftColumn[]>([]);
  const [indexes, setIndexes] = useState<DraftIndex[]>([]);
  const [foreignKeys, setForeignKeys] = useState<DraftForeignKey[]>([]);
  const [siblingTables, setSiblingTables] = useState<string[]>([]);
  // Only used when `isNew` — the user-editable name for the new table.
  const [newTableName, setNewTableName] = useState(isNew ? '' : tableName);
  const [localSaving, setLocalSaving] = useState(false);
  // Optional table-level encoding + collation for `CREATE TABLE`.
  // `__default__` (or empty) means "inherit from database" — i.e.
  // emit no CHARACTER SET / COLLATE clause. The lists are server-
  // sourced via `db.listCharsets` / `db.listCollations`.
  const TABLE_DEFAULT_OPT = '__default__';
  const [newCharset, setNewCharset] = useState<string>(TABLE_DEFAULT_OPT);
  const [newCollation, setNewCollation] = useState<string>(TABLE_DEFAULT_OPT);
  const [encodings, setEncodings] = useState<string[]>([]);
  const [collations, setCollations] = useState<string[]>([]);

  // Load encodings once the create-table view is active. Mirrors the
  // database-picker dialog's pattern — adapters that don't model
  // per-database encodings (SQLite, Mongo, Redis) return [], and the
  // pickers stay hidden.
  useEffect(() => {
    if (!isNew) return;
    let cancelled = false;
    db.listCharsets(connection.id)
      .then(list => { if (!cancelled) setEncodings(list); })
      .catch(() => { if (!cancelled) setEncodings([]); });
    return () => { cancelled = true; };
  }, [isNew, connection.id]);

  // Reload collations when the user picks a different charset; reset
  // the user's collation choice (the prior pick almost certainly
  // doesn't apply to the new charset).
  useEffect(() => {
    if (!isNew) return;
    if (newCharset === TABLE_DEFAULT_OPT) {
      setCollations([]);
      return;
    }
    let cancelled = false;
    db.listCollations(connection.id, newCharset)
      .then(list => {
        if (cancelled) return;
        setCollations(list);
        setNewCollation(TABLE_DEFAULT_OPT);
      })
      .catch(() => { if (!cancelled) setCollations([]); });
    return () => { cancelled = true; };
  }, [isNew, connection.id, newCharset]);

  const effectiveSchema = schema ?? connection.database ?? '';

  // Resolve the active adapter's manifest so the "data type" picker pulls
  // its options from the adapter catalogue (MySQL's 37 types, SQLite's
  // affinities + aliases, …). Falls back to a generic SQL set when no
  // manifest matches — e.g. a legacy row whose driver label doesn't
  // resolve, or before the first listAdapters() fetch returns.
  const manifests = useAdapterManifests();
  const activeManifest = useMemo(
    () => resolveManifest(manifests, connection.driver),
    [manifests, connection.driver],
  );
  const dataTypeOptions = useMemo<string[]>(() => {
    const declared = activeManifest?.columnTypes;
    return declared && declared.length > 0 ? declared : FALLBACK_DATA_TYPES;
  }, [activeManifest]);
  // Safe default: read-only until the active adapter explicitly advertises
  // DDL support (ALTER/CREATE/DROP table).
  const supportsAlterTable = activeManifest?.capabilities.alterTable ?? false;
  const supportsManageIndexes = activeManifest?.capabilities.manageIndexes ?? false;
  // The schema editor is "open for business" if EITHER full-table DDL is
  // supported (SQL adapters) OR we have the structured index path
  // (Mongo). In document-store mode the column / PK / FK editors stay
  // visible — the inferred shape is useful reference — but every cell
  // is disabled. Only the indexes pane accepts edits.
  const schemaEditable = supportsAlterTable || supportsManageIndexes;
  const indexesOnlyMode = supportsManageIndexes && !supportsAlterTable;
  // Granular gate for the column/PK/FK editors specifically. Indexes use
  // `schemaEditable` directly because they're editable in both modes.
  const columnsEditable = schemaEditable && !indexesOnlyMode;

  const resetDrafts = (s: TableStructure) => {
    setColumns(columnsToDrafts(s.columns));
    // `algorithm` is SQL-only; Mongo ignores it and the column isn't
    // rendered in indexesOnlyMode, so the default below is just a
    // placeholder that will never reach a Mongo `create_index` call.
    setIndexes(indexesToDrafts(s.indexes, 'BTREE'));
    setForeignKeys(fksToDrafts(s.foreignKeys));
  };

  useEffect(() => {
    if (isNew) {
      // Synthesize an empty baseline so dirty-tracking and Save have something
      // to diff against. tableName at this point is the placeholder name the
      // user will rename before saving.
      setLoading(false);
      setError(null);
      const empty: TableStructure = {
        schema: effectiveSchema,
        name: tableName,
        kind: 'table',
        columns: [],
        indexes: [],
        primaryKey: [],
        foreignKeys: [],
        rowCount: null,
      };
      setStructure(empty);
      resetDrafts(empty);
      return;
    }
    if (!effectiveSchema) {
      setError('No database context for this table.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    ensureTableStructure(connection.id, effectiveSchema, tableName)
      .then(s => {
        if (cancelled) return;
        setStructure(s);
        resetDrafts(s);
      })
      .catch(e => { if (!cancelled) setError(isDbError(e) ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connection.id, effectiveSchema, tableName, isNew]);

  // Fetch sibling tables for the FK "Referenced Table" dropdown.
  useEffect(() => {
    if (!effectiveSchema) return;
    let cancelled = false;
    db.listSchemas(connection.id)
      .then(list => {
        if (cancelled) return;
        const s = list.find(x => x.name === effectiveSchema);
        if (s) setSiblingTables(s.tables.map(t => t.name));
      })
      .catch(() => { /* silent — FK picker just falls back to empty */ });
    return () => { cancelled = true; };
  }, [connection.id, effectiveSchema]);

  const dirty = useMemo(() => {
    if (!schemaEditable) return false;
    if (!structure) return false;
    if (effectiveIsNew) {
      // New-table mode: dirty as soon as the user has entered a name AND at
      // least one column. We don't diff against the empty synthetic structure
      // because everything is new by definition.
      return newTableName.trim().length > 0 && columns.some(c => !c.pendingDelete && c.name.trim());
    }
    return isColumnsDirty(structure.columns, columns)
        || isIndexesDirty(structure.indexes, indexes)
        || isFksDirty(structure.foreignKeys, foreignKeys);
  }, [schemaEditable, structure, columns, indexes, foreignKeys, effectiveIsNew, newTableName]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // Create-mode name collision: precheck against the live sibling
  // table list (already fetched for the FK picker). Disable Save with
  // an inline hint so the user doesn't hit a "Table already exists"
  // error from the server. Case-insensitive on engines that fold
  // identifiers (MySQL on case-insensitive filesystems is the common
  // gotcha).
  const newNameTrim = newTableName.trim();
  const newNameCollides = effectiveIsNew
    && newNameTrim.length > 0
    && siblingTables.some(t => t.toLowerCase() === newNameTrim.toLowerCase());
  const saveDisabled = !dirty || localSaving || newNameCollides;

  const doDiscard = () => {
    if (!schemaEditable) return;
    if (structure) resetDrafts(structure);
  };
  const doSave = async () => {
    if (!schemaEditable) {
      toast.info('Schema editing is not supported for this adapter.');
      return;
    }
    if (!structure || !effectiveSchema) {
      toast.error('No schema context — cannot save.');
      return;
    }
    const nameForSave = isNew ? newTableName.trim() : tableName;
    if (isNew && !nameForSave) {
      toast.error('Enter a table name before saving.');
      return;
    }

    // Document-store path: only indexes are editable, and we ship them
    // through the structured `db.modifyIndexes` command so the adapter
    // doesn't need a SQL-DDL emitter. Compass-equivalent flow.
    if (indexesOnlyMode) {
      const origByName = new Map(structure.indexes.map(i => [i.name, i]));
      const drop = indexes
        .filter(i => i.originalName && (i.pendingDelete || indexNeedsRecreate(i, origByName.get(i.originalName))))
        .map(i => i.originalName!)
        .filter(Boolean);
      // Compass-shaped per-field types are captured in the columns
      // textbox via a `field:type` suffix. Recognised types:
      //   asc, desc, text, 2dsphere, 2d, hashed, wildcard
      // No suffix → ascending. The whole-index `algorithm` slot is now
      // unused for Mongo (kind moved to per-field per the Compass model).
      const KEY_TYPES: IndexKeyValue[] = ['asc', 'desc', 'text', '2dsphere', '2d', 'hashed', 'wildcard'];
      const create: IndexSpecPayload[] = indexes
        .filter(i => !i.pendingDelete && (i.originalName === null || indexNeedsRecreate(i, origByName.get(i.originalName))))
        .map(i => ({
          name: i.name.trim() || undefined,
          unique: i.isUnique,
          columns: i.columns
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(part => {
              const [rawName, rawType] = part.split(':').map(s => s.trim());
              const t = rawType?.toLowerCase();
              const direction: IndexKeyValue = (KEY_TYPES.find(k => k === t) ?? 'asc');
              return { name: rawName, direction };
            }),
        }));
      if (drop.length === 0 && create.length === 0) {
        toast.info('No index changes to save.');
        return;
      }
      try {
        await db.modifyIndexes(connection.id, {
          schema: effectiveSchema,
          table: nameForSave,
          drop,
          create,
        });
        const total = drop.length + create.length;
        toast.success(`Applied ${total} index change${total === 1 ? '' : 's'}`);
        window.dispatchEvent(new CustomEvent('tablerelay:reload', { detail: { connectionId: connection.id } }));
        try {
          const fresh = await refreshTableStructure(connection.id, effectiveSchema, nameForSave);
          setStructure(fresh);
          resetDrafts(fresh);
        } catch (e) {
          toast.error(`Refetch failed: ${isDbError(e) ? e.message : String(e)}`);
        }
      } catch (e) {
        console.error('[SchemaView] modifyIndexes error:', e);
        toast.error(isDbError(e) ? e.message : String(e));
      }
      return;
    }

    const stmts = buildSaveBatch(
      effectiveSchema,
      nameForSave,
      structure,
      columns,
      indexes,
      foreignKeys,
      !!isNew,
      dialectFromManifest(activeManifest?.capabilities),
      // Only forward user-picked options — `__default__` -> undefined
      // so `buildSaveBatch` can omit the clause and let the database's
      // own default kick in (matches how the create-database dialog
      // treats the same sentinel).
      isNew
        ? {
            charset: newCharset !== TABLE_DEFAULT_OPT ? newCharset : undefined,
            collation: newCollation !== TABLE_DEFAULT_OPT ? newCollation : undefined,
          }
        : undefined,
    );
    if (stmts.length === 0) {
      toast.info(isNew ? 'Add at least one column before saving.' : 'No changes to save.');
      return;
    }
    const batch = stmts.join(';\n') + ';';
    try {
      const res = await db.runQuery(connection.id, batch);
      const failed = res.statements.find(s => s.error);
      if (failed) {
        toast.error(`Failed: ${failed.error}`, { description: failed.sql });
        return;
      }
      toast.success(
        isNew
          ? `Created table ${nameForSave}`
          : `Applied ${res.statements.length} statement${res.statements.length === 1 ? '' : 's'}`,
      );
      // Saving a table can add / rename / drop columns and FKs — tell the
      // rest of the app to refresh its schema view. Sidebar, DiagramView,
      // autocomplete and any open DataGrid listen for this event.
      window.dispatchEvent(new CustomEvent('tablerelay:reload', { detail: { connectionId: connection.id } }));
      try {
        const fresh = await refreshTableStructure(connection.id, effectiveSchema, nameForSave);
        setStructure(fresh);
        resetDrafts(fresh);
        // Create-mode → flip the local "no longer new" flag so the
        // dirty calc switches to the diff path immediately, and notify
        // the parent so it can rename / un-`isNew` the tab. Without
        // both, the "● unsaved changes" badge never clears even
        // though the table is already on disk.
        if (isNew) {
          setCreatedLocally(true);
          onTableCreated?.(nameForSave);
        }
      } catch (e) {
        toast.error(`Refetch failed: ${isDbError(e) ? e.message : String(e)}`);
      }
    } catch (e) {
      console.error('[SchemaView] save error:', e);
      toast.error(isDbError(e) ? e.message : String(e));
    }
  };

  useImperativeHandle(ref, () => ({
    isDirty: () => dirty,
    discard: doDiscard,
    save: doSave,
  }), [dirty, structure, columns, indexes, foreignKeys, connection.id, effectiveSchema, tableName, isNew, newTableName]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading schema…
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
  if (!structure) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No structure available.
      </div>
    );
  }

  const updateColumn = (id: string, patch: Partial<DraftColumn>) => {
    if (!columnsEditable) return;
    setColumns(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  };
  const addColumn = () => {
    if (!columnsEditable) return;
    setColumns(prev => [...prev, {
      id: makeId('col'),
      originalName: null,
      name: '',
      dataType: '',
      nullable: true,
      defaultValue: null,
      key: 'NONE',
      extra: '',
      characterSet: '',
      collation: '',
      pendingDelete: false,
    }]);
  };
  const toggleDeleteColumn = (id: string) => {
    if (!columnsEditable) return;
    setColumns(prev => prev.flatMap(c => {
      if (c.id !== id) return [c];
      // freshly added + not persisted → drop entirely
      if (c.originalName === null) return [];
      return [{ ...c, pendingDelete: !c.pendingDelete }];
    }));
  };

  const updateIndex = (id: string, patch: Partial<DraftIndex>) => {
    if (!schemaEditable) return;
    setIndexes(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
  };
  const addIndex = () => {
    if (!schemaEditable) return;
    setIndexes(prev => [...prev, {
      id: makeId('idx'),
      originalName: null,
      name: '',
      algorithm: 'BTREE',
      isUnique: false,
      columns: '',
      pendingDelete: false,
    }]);
  };
  const toggleDeleteIndex = (id: string) => {
    if (!schemaEditable) return;
    setIndexes(prev => prev.flatMap(i => {
      if (i.id !== id) return [i];
      if (i.originalName === null) return [];
      return [{ ...i, pendingDelete: !i.pendingDelete }];
    }));
  };

  const upsertFk = (colName: string, patch: Omit<DraftForeignKey, 'id' | 'pendingDelete' | 'originalName' | 'name'> & { name?: string }) => {
    if (!columnsEditable) return;
    setForeignKeys(prev => {
      const idx = prev.findIndex(f => f.columns.includes(colName) && !f.pendingDelete);
      const next = [...prev];
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...patch, name: patch.name ?? next[idx].name };
      } else {
        next.push({
          id: makeId('fk'),
          originalName: null,
          name: patch.name ?? defaultFkName(tableName, colName),
          columns: patch.columns,
          refTable: patch.refTable,
          refColumns: patch.refColumns,
          onUpdate: patch.onUpdate,
          onDelete: patch.onDelete,
          pendingDelete: false,
        });
      }
      return next;
    });
  };

  const dropFkForColumn = (colName: string) => {
    if (!columnsEditable) return;
    setForeignKeys(prev => prev.flatMap(f => {
      if (!f.columns.includes(colName)) return [f];
      if (f.originalName === null) return []; // unsaved — just remove
      return [{ ...f, pendingDelete: true }];
    }));
  };

  const fkByColumn = new Map<string, DraftForeignKey>();
  for (const fk of foreignKeys) {
    if (fk.pendingDelete) continue;
    for (const col of fk.columns) {
      if (!fkByColumn.has(col)) fkByColumn.set(col, fk);
    }
  }

  const visibleColumns = columns;
  const visibleIndexes = indexes;

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="h-10 border-b border-border flex items-center px-4 bg-muted/10 text-xs text-muted-foreground gap-2">
        <span className="font-mono">{structure.schema}.</span>
        {effectiveIsNew ? (
          <>
            <input
              value={newTableName}
              onChange={e => setNewTableName(e.target.value)}
              placeholder="new_table_name"
              aria-invalid={newNameCollides}
              className={`font-mono text-foreground bg-transparent outline-none focus:bg-muted/40 px-1.5 py-0.5 rounded border border-dashed ${newNameCollides ? 'border-destructive' : 'border-border'}`}
            />
            {newNameCollides && (
              <span className="text-destructive">already exists</span>
            )}
          </>
        ) : (
          <span className="font-medium text-foreground font-mono">{structure.name}</span>
        )}
        <span className="mx-2">·</span>
        <span>{visibleColumns.filter(c => !c.pendingDelete).length} columns</span>
        <span className="mx-2">·</span>
        <span>{visibleIndexes.filter(i => !i.pendingDelete).length} indexes</span>
        {!effectiveIsNew && (
          <>
            <span className="mx-2">·</span>
            <span>{foreignKeys.filter(f => !f.pendingDelete).length} foreign keys</span>
          </>
        )}
        {!schemaEditable && (
          <span className="text-muted-foreground">read-only</span>
        )}
        {schemaEditable && dirty && <span className="text-yellow-600 dark:text-yellow-400">● unsaved changes</span>}
        <div className="ml-auto flex items-center gap-1">
          {columnsEditable && (
            <Button variant="ghost" size="xs" onClick={addColumn}>
              <Plus className="w-3 h-3 mr-1" />
              Add column
            </Button>
          )}
          {schemaEditable && (
            <Button variant="ghost" size="xs" onClick={addIndex}>
              <Plus className="w-3 h-3 mr-1" />
              Add index
            </Button>
          )}
          {schemaEditable && (
            <>
              <Button
                size="xs"
                variant={dirty ? 'default' : 'ghost'}
                disabled={saveDisabled}
                onClick={async () => { setLocalSaving(true); try { await doSave(); } finally { setLocalSaving(false); } }}
              >
                <Check className="w-3 h-3 mr-1" />
                {localSaving
                  ? (effectiveIsNew ? 'Creating…' : 'Saving…')
                  : (effectiveIsNew ? 'Create table' : 'Save')}
              </Button>
              <Button size="xs" variant="ghost" disabled={!dirty || localSaving} onClick={doDiscard}>
                <X className="w-3 h-3 mr-1" />
                Discard
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Create-mode only: optional table-level encoding + collation
          pickers. Hidden in edit mode (per-column charset/collation
          cells in the column table cover edits) and on adapters that
          don't model per-database encodings (the live charset list
          will be empty). Default ⇒ inherit from the database. */}
      {effectiveIsNew && encodings.length > 0 && (
        <div className="shrink-0 border-b border-border bg-muted/10 px-4 py-2 flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">Encoding</span>
          <Select value={newCharset} onValueChange={setNewCharset}>
            <SelectTrigger className="h-7 w-56">
              <SelectValue>
                {(v) => (v === TABLE_DEFAULT_OPT ? 'Default (inherit from DB)' : String(v ?? ''))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TABLE_DEFAULT_OPT}>Default (inherit from DB)</SelectItem>
              {encodings.map(name => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {newCharset !== TABLE_DEFAULT_OPT && collations.length > 0 && (
            <>
              <span className="text-muted-foreground ml-2">Collation</span>
              <Select value={newCollation} onValueChange={setNewCollation}>
                <SelectTrigger className="h-7 w-72">
                  <SelectValue>
                    {(v) => (v === TABLE_DEFAULT_OPT ? 'Default (server picks)' : String(v ?? ''))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TABLE_DEFAULT_OPT}>Default (server picks)</SelectItem>
                  {collations.map(name => (
                    <SelectItem key={name} value={name}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0">
        {/* Columns — always rendered. In document-store mode (Mongo) the
            cells are disabled but kept visible because the inferred shape
            is still useful as reference. Real edits go through Indexes. */}
        <div className="flex-1 flex flex-col min-h-0 border-b border-border">
          <div className="flex-1 overflow-auto min-h-0">
          {indexesOnlyMode ? (
            // Mongo-flavoured column view. The backend's `describe_table`
            // samples docs and returns inferred field types — we render
            // that shape directly: field, type(s), present-in-all flag,
            // indexed flag. None of MySQL's columns (default, charset,
            // collation, FK) apply, and the schema isn't enforced anyway.
            <MongoFieldsTable columns={visibleColumns} />
          ) : (
          <table className="w-full text-sm text-left border-collapse">
            <thead className="text-[11px] text-muted-foreground uppercase bg-muted sticky top-0 z-10">
              <tr>
                <Th>name</Th>
                <Th>data_type</Th>
                <Th>is_nullable</Th>
                <Th>column_default</Th>
                <Th>key</Th>
                <Th>extra</Th>
                {!effectiveIsNew && <Th>character_set</Th>}
                {!effectiveIsNew && <Th>collation</Th>}
                {!effectiveIsNew && <Th>foreign_key</Th>}
                <Th last></Th>
              </tr>
            </thead>
            <tbody>
              {visibleColumns.map(c => {
                const fk = fkByColumn.get(c.originalName ?? c.name);
                const rowCls = c.pendingDelete
                  ? 'border-b border-border/60 line-through opacity-60 bg-destructive/5'
                  : c.originalName === null
                    ? 'border-b border-border/60 border-l-2 border-l-primary/60 bg-primary/5'
                    : 'border-b border-border/60 hover:bg-muted/20 transition-colors';
                return (
                  <tr key={c.id} className={rowCls}>
                    <Td className="font-mono font-medium text-foreground p-0">
                      <CellInput
                        value={c.name}
                        onCommit={v => updateColumn(c.id, { name: v })}
                        disabled={!columnsEditable || c.pendingDelete}
                        placeholder="column_name"
                      />
                    </Td>
                    <Td className="font-mono text-muted-foreground p-0">
                      <CellCombobox
                        value={c.dataType}
                        onCommit={v => updateColumn(c.id, { dataType: v })}
                        options={dataTypeOptions}
                        disabled={!columnsEditable || c.pendingDelete}
                        placeholder="varchar(255)"
                      />
                    </Td>
                    <Td className="p-0">
                      <CellSelect
                        value={c.nullable ? 'YES' : 'NO'}
                        onChange={v => updateColumn(c.id, { nullable: v === 'YES' })}
                        disabled={!columnsEditable || c.pendingDelete}
                        options={[{ value: 'YES', label: 'YES' }, { value: 'NO', label: 'NO' }]}
                      />
                    </Td>
                    <Td className="font-mono text-muted-foreground p-0">
                      <CellInput
                        value={c.defaultValue ?? ''}
                        onCommit={v => updateColumn(c.id, { defaultValue: v === '' ? null : v })}
                        disabled={!columnsEditable || c.pendingDelete}
                        placeholder="NULL"
                      />
                    </Td>
                    <Td className="p-0">
                      <CellSelect
                        value={c.key}
                        onChange={v => updateColumn(c.id, { key: v as ColumnKey })}
                        disabled={!columnsEditable || c.pendingDelete}
                        options={[
                          { value: 'NONE', label: '—' },
                          { value: 'PRIMARY', label: 'PRIMARY' },
                          { value: 'UNIQUE', label: 'UNIQUE' },
                        ]}
                      />
                    </Td>
                    <Td className="font-mono text-muted-foreground p-0">
                      <CellCombobox
                        value={c.extra}
                        onCommit={v => updateColumn(c.id, { extra: v === 'NONE' ? '' : v })}
                        options={extraOptionsFor(c.dataType)}
                        disabled={!columnsEditable || c.pendingDelete}
                        placeholder="—"
                      />
                    </Td>
                    {/* Charset / collation / FK cells are hidden in
                        create-table mode — most users want a name +
                        columns first, and the table-default charset
                        (set by CREATE DATABASE) covers the common case.
                        These cells reappear in edit mode for tuning. */}
                    {!effectiveIsNew && (
                      <Td className="font-mono text-muted-foreground p-0">
                        <CellInput
                          value={c.characterSet}
                          onCommit={v => updateColumn(c.id, { characterSet: v })}
                          disabled={!columnsEditable || c.pendingDelete || !isStringyType(c.dataType)}
                          placeholder={isStringyType(c.dataType) ? 'utf8mb4' : ''}
                        />
                      </Td>
                    )}
                    {!effectiveIsNew && (
                      <Td className="font-mono text-muted-foreground p-0">
                        <CellInput
                          value={c.collation}
                          onCommit={v => updateColumn(c.id, { collation: v })}
                          disabled={!columnsEditable || c.pendingDelete || !isStringyType(c.dataType)}
                          placeholder={isStringyType(c.dataType) ? 'utf8mb4_unicode_ci' : ''}
                        />
                      </Td>
                    )}
                    {!effectiveIsNew && (
                      <Td className="p-0">
                        <FkCell
                          tableName={tableName}
                          column={c}
                          fk={fk}
                          allColumns={visibleColumns.map(x => x.originalName ?? x.name).filter(Boolean)}
                          siblingTables={siblingTables}
                          connectionId={connection.id}
                          schema={effectiveSchema}
                          disabled={!columnsEditable || c.pendingDelete}
                          onApply={(patch) => upsertFk(c.originalName ?? c.name, patch)}
                          onRemove={() => dropFkForColumn(c.originalName ?? c.name)}
                        />
                      </Td>
                    )}
                    <Td last className="p-0 w-8">
                      <button
                        type="button"
                        onClick={() => toggleDeleteColumn(c.id)}
                        disabled={!columnsEditable}
                        className="p-1.5 text-muted-foreground hover:text-destructive"
                        title={c.pendingDelete ? 'Restore' : 'Delete'}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
          </div>
        </div>

        {/* Indexes — fixed header, capped body so it stays anchored at
            the bottom of the columns table. */}
        <div className="shrink-0 flex flex-col min-h-30" style={{ maxHeight: '40%' }}>
          {indexesOnlyMode && (
            <div className="shrink-0 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border bg-muted/20">
              Field syntax: <code className="font-mono text-foreground">name</code> (asc),{' '}
              <code className="font-mono text-foreground">name:desc</code>,{' '}
              <code className="font-mono text-foreground">name:text</code>,{' '}
              <code className="font-mono text-foreground">name:2dsphere</code>,{' '}
              <code className="font-mono text-foreground">name:2d</code>,{' '}
              <code className="font-mono text-foreground">name:hashed</code>,{' '}
              <code className="font-mono text-foreground">name:wildcard</code>. Compound: comma-separate.
            </div>
          )}
          <div className="flex-1 overflow-auto min-h-0">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="text-[11px] text-muted-foreground uppercase bg-muted sticky top-0 z-10">
              <tr>
                <Th>index_name</Th>
                {!indexesOnlyMode && <Th>index_algorithm</Th>}
                <Th>is_unique</Th>
                <Th>{indexesOnlyMode ? 'fields' : 'column_name'}</Th>
                <Th last></Th>
              </tr>
            </thead>
            <tbody>
              {visibleIndexes.length === 0 && (
                <tr>
                  <td colSpan={indexesOnlyMode ? 4 : 5} className="px-4 py-6 text-sm text-muted-foreground">
                    No indexes defined.
                  </td>
                </tr>
              )}
              {visibleIndexes.map(idx => {
                const rowCls = idx.pendingDelete
                  ? 'border-b border-border/60 line-through opacity-60 bg-destructive/5'
                  : idx.originalName === null
                    ? 'border-b border-border/60 border-l-2 border-l-primary/60 bg-primary/5'
                    : 'border-b border-border/60 hover:bg-muted/20 transition-colors';
                return (
                  <tr key={idx.id} className={rowCls}>
                    <Td className="font-mono font-medium p-0">
                      <CellInput
                        value={idx.name}
                        onCommit={v => updateIndex(idx.id, { name: v })}
                        disabled={!schemaEditable || idx.pendingDelete}
                        placeholder="idx_name"
                      />
                    </Td>
                    {!indexesOnlyMode && (
                      <Td className="p-0">
                        <CellSelect
                          value={idx.algorithm}
                          onChange={v => updateIndex(idx.id, { algorithm: v as IndexAlgorithm })}
                          disabled={!schemaEditable || idx.pendingDelete}
                          options={SQL_INDEX_ALGORITHMS.map(a => ({ value: a, label: a }))}
                        />
                      </Td>
                    )}
                    <Td className="p-0">
                      <CellSelect
                        value={idx.isUnique ? 'TRUE' : 'FALSE'}
                        onChange={v => updateIndex(idx.id, { isUnique: v === 'TRUE' })}
                        disabled={!schemaEditable || idx.pendingDelete}
                        options={[{ value: 'TRUE', label: 'TRUE' }, { value: 'FALSE', label: 'FALSE' }]}
                      />
                    </Td>
                    <Td className="font-mono p-0">
                      <CellInput
                        value={idx.columns}
                        onCommit={v => updateIndex(idx.id, { columns: v })}
                        disabled={!schemaEditable || idx.pendingDelete}
                        placeholder={indexesOnlyMode
                          ? 'email, score:desc, location:2dsphere'
                          : 'col1, col2'}
                      />
                    </Td>
                    <Td last className="p-0 w-8">
                      <button
                        type="button"
                        onClick={() => toggleDeleteIndex(idx.id)}
                        disabled={!schemaEditable}
                        className="p-1.5 text-muted-foreground hover:text-destructive"
                        title={idx.pendingDelete ? 'Restore' : 'Delete'}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  );
});

export default SchemaView;

// -------- diff helpers --------

function isColumnsDirty(original: ColumnInfo[], drafts: DraftColumn[]): boolean {
  if (original.length !== drafts.filter(d => !d.pendingDelete && d.originalName !== null).length
    + drafts.filter(d => d.pendingDelete).length) {
    // any add → dirty
    if (drafts.some(d => d.originalName === null)) return true;
  }
  if (drafts.some(d => d.originalName === null)) return true;
  if (drafts.some(d => d.pendingDelete)) return true;
  const origByName = new Map(original.map(c => [c.name, c]));
  for (const d of drafts) {
    if (d.originalName === null || d.pendingDelete) continue;
    const o = origByName.get(d.originalName);
    if (!o) return true;
    const origType = columnTypeString(o);
    if (d.name !== o.name) return true;
    if (d.dataType !== origType) return true;
    if (d.nullable !== o.nullable) return true;
    if ((d.defaultValue ?? null) !== (o.default ?? null)) return true;
    if (d.key !== columnKeyFor(o)) return true;
    if (d.extra !== normaliseExtra(o.extra ?? '')) return true;
    if (d.characterSet !== (o.characterSet ?? '')) return true;
    if (d.collation !== (o.collation ?? '')) return true;
  }
  return false;
}

function isIndexesDirty(original: IndexInfo[], drafts: DraftIndex[]): boolean {
  if (drafts.some(d => d.originalName === null)) return true;
  if (drafts.some(d => d.pendingDelete)) return true;
  const origByName = new Map(original.map(i => [i.name, i]));
  for (const d of drafts) {
    if (d.originalName === null || d.pendingDelete) continue;
    const o = origByName.get(d.originalName);
    if (!o) return true;
    if (d.name !== o.name) return true;
    if (d.isUnique !== o.unique) return true;
    if (d.columns.split(',').map(s => s.trim()).filter(Boolean).join(',') !== o.columns.join(',')) return true;
  }
  return false;
}

function isFksDirty(original: ForeignKey[], drafts: DraftForeignKey[]): boolean {
  if (drafts.some(d => d.originalName === null)) return true;
  if (drafts.some(d => d.pendingDelete)) return true;
  const origByName = new Map(original.map(f => [f.name, f]));
  for (const d of drafts) {
    if (d.originalName === null || d.pendingDelete) continue;
    const o = origByName.get(d.originalName);
    if (!o) return true;
    if (d.columns.join(',') !== o.fromColumns.join(',')) return true;
    if (d.refTable !== o.toTable) return true;
    if (d.refColumns.split(',').map(s => s.trim()).filter(Boolean).join(',') !== o.toColumns.join(',')) return true;
    // onUpdate/onDelete aren't in ForeignKey — treat as non-dirty unless changed from NO ACTION
    if (d.onUpdate !== 'NO ACTION' || d.onDelete !== 'NO ACTION') return true;
  }
  return false;
}

// -------- SQL batch builder --------

function buildSaveBatch(
  schemaName: string,
  table: string,
  structure: TableStructure,
  columns: DraftColumn[],
  indexes: DraftIndex[],
  foreignKeys: DraftForeignKey[],
  isNew = false,
  dialect: Dialect = 'mysql',
  /** New-table only: optional table-level CHARACTER SET / COLLATE.
   *  `undefined` either field → omit the clause; the database's
   *  default applies. MySQL-only — Postgres / SQLite have no
   *  table-level analog and this argument is ignored. */
  tableOpts?: { charset?: string; collation?: string },
): string[] {
  const qi = (s: string) => q(s, dialect);
  const qq = (s: string, t: string) => quoteQualified(s, t, dialect);
  const clause = (c: DraftColumn) => buildColumnClause(c, dialect);

  // New-table path: emit a single CREATE TABLE with inline column/key clauses,
  // then append CREATE INDEX + ADD CONSTRAINT statements for anything that
  // can't live inside the CREATE (secondary indexes, FKs).
  if (isNew) {
    const tbl = qq(schemaName, table);
    const out: string[] = [];
    const liveCols = columns.filter(c => !c.pendingDelete);
    if (liveCols.length === 0) {
      // CREATE TABLE requires at least one column — let the caller surface the
      // error by returning an empty batch, consistent with "nothing to do".
      return [];
    }
    const colClauses = liveCols.map(clause);
    const pkCols = liveCols.filter(c => c.key === 'PRIMARY').map(c => qi(c.name));
    if (pkCols.length > 0) colClauses.push(`PRIMARY KEY (${pkCols.join(', ')})`);
    const uniqueCols = liveCols.filter(c => c.key === 'UNIQUE').map(c => c.name);
    // Postgres/SQLite don't have MySQL's `UNIQUE KEY`; use the portable
    // `UNIQUE (...)` table constraint instead. MySQL accepts both.
    for (const u of uniqueCols) colClauses.push(`UNIQUE (${qi(u)})`);
    // MySQL-only storage/charset trailer. Postgres + SQLite reject it.
    // Charset/collation honour the user's create-dialog picks; without
    // them we omit the clause (server falls back to the database's
    // default), so this no longer hardcodes utf8mb4.
    let trailer = '';
    if (dialect === 'mysql') {
      trailer = ' ENGINE=InnoDB';
      if (tableOpts?.charset) trailer += ` DEFAULT CHARSET=${tableOpts.charset}`;
      if (tableOpts?.collation) trailer += ` COLLATE=${tableOpts.collation}`;
    }
    out.push(`CREATE TABLE ${tbl} (\n  ${colClauses.join(',\n  ')}\n)${trailer}`);

    // Secondary indexes (anything not covered by the PK/UNIQUE above).
    // Auto-generate a name when the user left it blank — silently
    // skipping the index (the previous behaviour) made it look as
    // though the index "wasn't saved" when really it was discarded.
    for (const i of indexes.filter(x => !x.pendingDelete)) {
      const cols = i.columns.split(',').map(s => s.trim()).filter(Boolean);
      if (cols.length === 0) continue;
      const name = i.name.trim() || defaultIndexName(table, cols, i.isUnique);
      const unique = i.isUnique ? 'UNIQUE ' : '';
      // `USING <algorithm>` placement differs by dialect. MySQL accepts it
      // in CREATE INDEX; Postgres uses it but spelled `USING btree`/`USING hash`;
      // SQLite has no method clause. Only emit it for MySQL to keep the
      // emitted DDL portable.
      const using = dialect === 'mysql' ? ` USING ${i.algorithm}` : '';
      out.push(`CREATE ${unique}INDEX ${qi(name)}${using} ON ${tbl} (${cols.map(qi).join(', ')})`);
    }

    // Foreign keys.
    for (const f of foreignKeys.filter(x => !x.pendingDelete)) {
      const refCols = f.refColumns.split(',').map(s => s.trim()).filter(Boolean);
      if (f.columns.length === 0 || refCols.length === 0 || !f.refTable.trim()) continue;
      const name = f.name.trim() || defaultFkName(table, f.columns[0] ?? 'col');
      out.push(
        `ALTER TABLE ${tbl} ADD CONSTRAINT ${qi(name)} FOREIGN KEY (${f.columns.map(qi).join(', ')}) `
        + `REFERENCES ${qq(schemaName, f.refTable)} (${refCols.map(qi).join(', ')}) `
        + `ON UPDATE ${f.onUpdate} ON DELETE ${f.onDelete}`,
      );
    }
    return out;
  }

  const tbl = qq(schemaName, table);
  const origCols = new Map(structure.columns.map(c => [c.name, c]));
  const origIndexes = new Map(structure.indexes.map(i => [i.name, i]));
  const origFks = new Map(structure.foreignKeys.map(f => [f.name, f]));

  const out: string[] = [];

  // 1) Drop FKs that are removed or edited (edits = drop+add).
  //    Postgres spells this `DROP CONSTRAINT`, MySQL uses `DROP FOREIGN KEY`.
  const dropFkKeyword = dialect === 'mysql' ? 'DROP FOREIGN KEY' : 'DROP CONSTRAINT';
  for (const f of foreignKeys) {
    if (f.originalName && (f.pendingDelete || fkNeedsRecreate(f, origFks.get(f.originalName)))) {
      out.push(`ALTER TABLE ${tbl} ${dropFkKeyword} ${qi(f.originalName)}`);
    }
  }

  // 2) Drop indexes that are removed or edited. Postgres `DROP INDEX` is
  //    standalone (no `ON table`); MySQL wants `DROP INDEX name ON tbl`.
  for (const i of indexes) {
    if (i.originalName && (i.pendingDelete || indexNeedsRecreate(i, origIndexes.get(i.originalName)))) {
      if (dialect === 'mysql') {
        out.push(`DROP INDEX ${qi(i.originalName)} ON ${tbl}`);
      } else {
        // Postgres indexes live in the schema namespace, so qualify with it.
        out.push(`DROP INDEX ${qq(schemaName, i.originalName)}`);
      }
    }
  }

  // 3) Drop columns.
  for (const c of columns) {
    if (c.pendingDelete && c.originalName) {
      // Drop any keys on that column first. MySQL: `DROP PRIMARY KEY`.
      // Postgres: `DROP CONSTRAINT <pk_name>` — we don't track the PK
      // name, so skip (cascading the column drop will error loudly on
      // constraint violation, which is the correct surface for now).
      const orig = origCols.get(c.originalName);
      if (orig?.isPrimary && dialect === 'mysql') {
        out.push(`ALTER TABLE ${tbl} DROP PRIMARY KEY`);
      }
      out.push(`ALTER TABLE ${tbl} DROP COLUMN ${qi(c.originalName)}`);
    }
  }

  // 4) Change / add columns. Column mutation SQL diverges between MySQL's
  //    `CHANGE COLUMN old new TYPE …` and Postgres's separate `ALTER COLUMN`
  //    sub-commands. Keep MySQL behaviour; for Postgres, emit a best-effort
  //    sequence so rename / type / nullability each get their own statement.
  for (const c of columns) {
    if (c.pendingDelete) continue;
    if (c.originalName === null) {
      out.push(`ALTER TABLE ${tbl} ADD COLUMN ${clause(c)}`);
      if (c.key === 'PRIMARY') out.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${qi(c.name)})`);
      if (c.key === 'UNIQUE') {
        out.push(
          dialect === 'mysql'
            ? `ALTER TABLE ${tbl} ADD UNIQUE KEY (${qi(c.name)})`
            : `ALTER TABLE ${tbl} ADD UNIQUE (${qi(c.name)})`,
        );
      }
    } else {
      const orig = origCols.get(c.originalName);
      if (!orig) continue;
      const origType = columnTypeString(orig);
      const renamed = c.name !== orig.name;
      const typeChanged = c.dataType !== origType;
      const nullChanged = c.nullable !== orig.nullable;
      const defaultChanged = (c.defaultValue ?? null) !== (orig.default ?? null);
      const extraChanged = c.extra !== normaliseExtra(orig.extra ?? '');
      const charsetChanged = c.characterSet !== (orig.characterSet ?? '');
      const collationChanged = c.collation !== (orig.collation ?? '');
      const anyChange = renamed || typeChanged || nullChanged || defaultChanged
        || extraChanged || charsetChanged || collationChanged;
      if (anyChange) {
        if (dialect === 'mysql') {
          out.push(`ALTER TABLE ${tbl} CHANGE COLUMN ${qi(c.originalName)} ${clause(c)}`);
        } else {
          // Postgres: one sub-statement per facet.
          if (renamed) {
            out.push(`ALTER TABLE ${tbl} RENAME COLUMN ${qi(c.originalName)} TO ${qi(c.name)}`);
          }
          const colRef = qi(c.name);
          if (typeChanged && c.dataType.trim()) {
            out.push(`ALTER TABLE ${tbl} ALTER COLUMN ${colRef} TYPE ${c.dataType.trim()}`);
          }
          if (nullChanged) {
            out.push(
              c.nullable
                ? `ALTER TABLE ${tbl} ALTER COLUMN ${colRef} DROP NOT NULL`
                : `ALTER TABLE ${tbl} ALTER COLUMN ${colRef} SET NOT NULL`,
            );
          }
          if (defaultChanged) {
            out.push(
              c.defaultValue !== null && c.defaultValue !== ''
                ? `ALTER TABLE ${tbl} ALTER COLUMN ${colRef} SET DEFAULT ${c.defaultValue}`
                : `ALTER TABLE ${tbl} ALTER COLUMN ${colRef} DROP DEFAULT`,
            );
          }
          // `extra`, charset, collation are MySQL concepts — skip on PG.
        }
      }
      // Key transitions
      const oldKey = columnKeyFor(orig);
      if (oldKey !== c.key) {
        if (oldKey === 'PRIMARY' && dialect === 'mysql') {
          out.push(`ALTER TABLE ${tbl} DROP PRIMARY KEY`);
        }
        if (oldKey === 'UNIQUE') {
          if (dialect === 'mysql') {
            out.push(`ALTER TABLE ${tbl} DROP INDEX ${qi(orig.name)}`);
          } else {
            out.push(`DROP INDEX ${qq(schemaName, orig.name)}`);
          }
        }
        if (c.key === 'PRIMARY') out.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${qi(c.name)})`);
        if (c.key === 'UNIQUE') {
          out.push(
            dialect === 'mysql'
              ? `ALTER TABLE ${tbl} ADD UNIQUE KEY (${qi(c.name)})`
              : `ALTER TABLE ${tbl} ADD UNIQUE (${qi(c.name)})`,
          );
        }
      }
    }
  }

  // 5) Add / restore indexes
  for (const i of indexes) {
    if (i.pendingDelete) continue;
    const cols = i.columns.split(',').map(s => s.trim()).filter(Boolean);
    if (cols.length === 0 || !i.name.trim()) continue;
    const orig = i.originalName ? origIndexes.get(i.originalName) : null;
    const recreate = !orig || indexNeedsRecreate(i, orig);
    if (recreate) {
      const unique = i.isUnique ? 'UNIQUE ' : '';
      const colList = cols.map(qi).join(', ');
      const using = dialect === 'mysql' ? ` USING ${i.algorithm}` : '';
      out.push(`CREATE ${unique}INDEX ${qi(i.name)}${using} ON ${tbl} (${colList})`);
    }
  }

  // 6) Add FKs
  for (const f of foreignKeys) {
    if (f.pendingDelete) continue;
    const refCols = f.refColumns.split(',').map(s => s.trim()).filter(Boolean);
    if (f.columns.length === 0 || refCols.length === 0 || !f.refTable.trim()) continue;
    const orig = f.originalName ? origFks.get(f.originalName) : null;
    const recreate = !orig || fkNeedsRecreate(f, orig);
    if (recreate) {
      const name = f.name.trim() || defaultFkName(table, f.columns[0] ?? 'col');
      const fromCols = f.columns.map(qi).join(', ');
      const toCols = refCols.map(qi).join(', ');
      out.push(
        `ALTER TABLE ${tbl} ADD CONSTRAINT ${qi(name)} FOREIGN KEY (${fromCols}) `
        + `REFERENCES ${qq(schemaName, f.refTable)} (${toCols}) `
        + `ON UPDATE ${f.onUpdate} ON DELETE ${f.onDelete}`,
      );
    }
  }

  return out;
}

function indexNeedsRecreate(d: DraftIndex, o?: IndexInfo): boolean {
  if (!o) return true;
  if (d.name !== o.name) return true;
  if (d.isUnique !== o.unique) return true;
  const cols = d.columns.split(',').map(s => s.trim()).filter(Boolean);
  return cols.join(',') !== o.columns.join(',');
}

function fkNeedsRecreate(d: DraftForeignKey, o?: ForeignKey): boolean {
  if (!o) return true;
  if (d.columns.join(',') !== o.fromColumns.join(',')) return true;
  if (d.refTable !== o.toTable) return true;
  const refCols = d.refColumns.split(',').map(s => s.trim()).filter(Boolean);
  if (refCols.join(',') !== o.toColumns.join(',')) return true;
  if (d.onUpdate !== 'NO ACTION' || d.onDelete !== 'NO ACTION') return true;
  return false;
}

// -------- editable cell primitives --------

function CellInput({
  value, onCommit, disabled, placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <input
      ref={ref}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setLocal(value); (e.target as HTMLInputElement).blur(); }
      }}
      className="w-full px-2.5 py-1.5 bg-transparent text-sm font-[inherit] outline-none focus:bg-muted/40 disabled:opacity-50"
    />
  );
}

function CellSelect({
  value, onChange, options, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" className="h-7 border-0 bg-transparent hover:bg-muted/40 rounded-none w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/**
 * Typeahead input with a preset dropdown + "Manual input..." escape.
 * Shown as an input cell; clicking the caret opens the preset list, typing
 * filters it, and picking "Manual input..." just keeps the typed text.
 */
function CellCombobox({
  value, onCommit, options, disabled, placeholder, className,
}: {
  value: string;
  onCommit: (v: string) => void;
  options: string[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [local, setLocal] = useState(value);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setLocal(value); }, [value]);

  // Measure + track the input's viewport rect whenever the popover is
  // open so the fixed-position list stays attached through table scroll
  // and window resize. Recalculated on scroll of any ancestor, not just
  // window — the schema table lives inside its own scroll container.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      if (ref.current) setAnchorRect(ref.current.getBoundingClientRect());
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  // Close when clicking outside either the input wrapper or the portal'd
  // popover itself. Without the popover check the first click on a list
  // item would race the close handler.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useMemo(() => {
    const q = local.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, local]);

  const commit = (v: string) => {
    setLocal(v);
    if (v !== value) onCommit(v);
    setOpen(false);
  };

  // Choose above vs. below based on which side has more room, so the
  // dropdown doesn't get clipped by the grid's overflow container.
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const spaceBelow = anchorRect ? viewportH - anchorRect.bottom : 0;
  const spaceAbove = anchorRect ? anchorRect.top : 0;
  const openUp = anchorRect != null && spaceBelow < 180 && spaceAbove > spaceBelow;
  const maxH = Math.max(120, Math.min(288, openUp ? spaceAbove - 8 : spaceBelow - 8));

  return (
    <div ref={wrapRef} className={`relative w-full ${className ?? ''}`}>
      <input
        ref={ref}
        value={local}
        disabled={disabled}
        placeholder={placeholder}
        onChange={e => { setLocal(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (local !== value && !open) onCommit(local); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit(local); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setLocal(value); setOpen(false); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'ArrowDown' && !open) { setOpen(true); }
        }}
        className="w-full px-2.5 py-1.5 pr-5 bg-transparent text-sm font-[inherit] outline-none focus:bg-muted/40 disabled:opacity-50"
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(e) => { e.preventDefault(); setOpen(o => !o); ref.current?.focus(); }}
        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 4l3 3 3-3z" /></svg>
      </button>
      {open && filtered.length > 0 && anchorRect && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            left: anchorRect.left,
            top: openUp ? undefined : anchorRect.bottom + 2,
            bottom: openUp ? viewportH - anchorRect.top + 2 : undefined,
            width: anchorRect.width,
            maxHeight: maxH,
          }}
          className="z-50 min-w-36 overflow-auto rounded-lg bg-popover shadow-md ring-1 ring-foreground/10 py-1"
        >
          {filtered.map(o => (
            <button
              key={o}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(o); }}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground ${
                o === local ? 'bg-accent/50' : ''
              }`}
            >
              {o}
            </button>
          ))}
          <div className="border-t border-border/60 mt-1 pt-1">
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); ref.current?.focus(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground italic hover:bg-accent hover:text-accent-foreground"
            >
              Manual input…
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// -------- FK cell + popover --------

function FkCell({
  tableName, column, fk, allColumns, siblingTables, connectionId, schema, disabled, onApply, onRemove,
}: {
  tableName: string;
  column: DraftColumn;
  fk: DraftForeignKey | undefined;
  allColumns: string[];
  siblingTables: string[];
  connectionId: string;
  schema: string;
  disabled?: boolean;
  onApply: (patch: {
    columns: string[];
    refTable: string;
    refColumns: string;
    onUpdate: FkAction;
    onDelete: FkAction;
    name?: string;
  }) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Draft state for the popover (only committed on OK). This UI only supports
  // single-column FKs — the most common case, matching TablePlus. Composite
  // keys are rare and the existing multi-column storage stays underneath.
  const seedCol = column.originalName ?? column.name;
  const [col, setCol] = useState<string>(fk?.columns[0] ?? seedCol ?? '');
  const [refTable, setRefTable] = useState(fk?.refTable ?? '');
  const [refColumn, setRefColumn] = useState<string>(
    fk?.refColumns ? fk.refColumns.split(',').map(s => s.trim()).filter(Boolean)[0] ?? '' : '',
  );
  const [targetCols, setTargetCols] = useState<string[]>([]);
  const [targetLoading, setTargetLoading] = useState(false);
  const [onUpdate, setOnUpdate] = useState<FkAction>(fk?.onUpdate ?? 'NO ACTION');
  const [onDelete, setOnDelete] = useState<FkAction>(fk?.onDelete ?? 'NO ACTION');
  const [name, setName] = useState(fk?.name ?? '');

  useEffect(() => {
    if (!open) return;
    // reseed when opening
    setCol(fk?.columns[0] ?? seedCol ?? '');
    setRefTable(fk?.refTable ?? '');
    setRefColumn(fk?.refColumns ? fk.refColumns.split(',').map(s => s.trim()).filter(Boolean)[0] ?? '' : '');
    setOnUpdate(fk?.onUpdate ?? 'NO ACTION');
    setOnDelete(fk?.onDelete ?? 'NO ACTION');
    setName(fk?.name ?? '');
  }, [open, fk, seedCol]);

  // Load the target table's columns once a Referenced Table is picked so the
  // Referenced Columns field can autocomplete against real column names.
  useEffect(() => {
    if (!open || !refTable || !schema) {
      setTargetCols([]);
      return;
    }
    let cancelled = false;
    setTargetLoading(true);
    ensureTableStructure(connectionId, schema, refTable)
      .then(s => { if (!cancelled) setTargetCols(s.columns.map(c => c.name)); })
      .catch(() => { if (!cancelled) setTargetCols([]); })
      .finally(() => { if (!cancelled) setTargetLoading(false); });
    return () => { cancelled = true; };
  }, [open, refTable, schema, connectionId]);

  const hasFk = !!fk;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled && next) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            disabled={disabled}
            className="w-full h-full px-2.5 py-1.5 text-left text-xs font-mono hover:bg-muted/40 flex items-center gap-1"
            title={hasFk ? 'Edit foreign key' : 'Add foreign key'}
          >
            {hasFk ? (
              <>
                <Link2 className="w-3 h-3 text-primary" />
                <span className="text-primary truncate">{fk!.refTable}({fk!.refColumns})</span>
              </>
            ) : (
              <>
                <Link2Off className="w-3 h-3 text-muted-foreground/50" />
                <span className="opacity-50">—</span>
              </>
            )}
          </button>
        )}
      />
      <PopoverContent className="w-80 gap-3">
        <div className="text-sm font-medium border-b border-border/60 pb-2">
          {hasFk ? 'Edit foreign key' : 'Add foreign key'}
        </div>

        <FkField label="Constraint name">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={`fk_${tableName}_${col || 'col'}`}
            disabled={disabled}
          />
        </FkField>

        <FkField label="Table">
          <Input value={tableName} disabled />
        </FkField>

        <FkField label="Column">
          <Select value={col} onValueChange={setCol} disabled={disabled}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue placeholder="Select column" />
            </SelectTrigger>
            <SelectContent>
              {allColumns.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </FkField>

        <FkField label="Referenced Table">
          {siblingTables.length > 0 ? (
            <Select value={refTable} onValueChange={setRefTable} disabled={disabled}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="Select table" />
              </SelectTrigger>
              <SelectContent>
                {siblingTables.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <Input value={refTable} onChange={e => setRefTable(e.target.value)} placeholder="referenced_table" disabled={disabled} />
          )}
        </FkField>

        <FkField label="Referenced Column">
          {refTable ? (
            targetLoading ? (
              <div className="text-xs text-muted-foreground px-1 py-1.5 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading columns…
              </div>
            ) : targetCols.length > 0 ? (
              <Select value={refColumn} onValueChange={setRefColumn} disabled={disabled}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue placeholder="Select column" />
                </SelectTrigger>
                <SelectContent>
                  {targetCols.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={refColumn}
                onChange={e => setRefColumn(e.target.value)}
                placeholder="id"
                disabled={disabled}
              />
            )
          ) : (
            <div className="text-xs text-muted-foreground px-1 py-1.5">Pick a referenced table first.</div>
          )}
        </FkField>

        <div className="grid grid-cols-2 gap-2">
          <FkField label="On Update">
            <Select value={onUpdate} onValueChange={v => setOnUpdate(v as FkAction)} disabled={disabled}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FK_ACTIONS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
          </FkField>
          <FkField label="On Delete">
            <Select value={onDelete} onValueChange={v => setOnDelete(v as FkAction)} disabled={disabled}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FK_ACTIONS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
          </FkField>
        </div>

        <div className="flex items-center justify-between border-t border-border/60 pt-2 gap-2">
          {hasFk ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() => { onRemove(); setOpen(false); }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Delete
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={disabled}>Cancel</Button>
            <Button
              variant="default"
              size="sm"
              disabled={disabled || !col || !refTable.trim() || !refColumn.trim()}
              onClick={() => {
                onApply({
                  columns: [col],
                  refTable: refTable.trim(),
                  refColumns: refColumn.trim(),
                  onUpdate,
                  onDelete,
                  name: name.trim() || undefined,
                });
                setOpen(false);
              }}
            >
              OK
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FkField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

// -------- table shell --------

function Th({ children, last }: { children?: React.ReactNode; last?: boolean }) {
  return (
    <th className={`px-4 py-2 border-b ${last ? '' : 'border-r'} border-border font-medium whitespace-nowrap`}>
      {children}
    </th>
  );
}

function Td({ children, last, className }: { children: React.ReactNode; last?: boolean; className?: string }) {
  return (
    <td className={`${last ? '' : 'border-r'} border-border whitespace-nowrap ${className ?? ''}`}>
      {children}
    </td>
  );
}

// Mongo-flavoured fields table. Mongo has no enforced schema — what
// `describe_table` returns is a 200-doc sample summary: which fields
// exist, what BSON types they hold (multiple if heterogeneous), and
// whether they're missing in some sampled docs. We render that shape
// directly instead of pretending it's an SQL column definition.
function MongoFieldsTable({ columns }: { columns: DraftColumn[] }) {
  const visible = columns.filter(c => !c.pendingDelete);
  return (
    <table className="w-full text-sm text-left border-collapse">
      <thead className="text-[11px] text-muted-foreground uppercase bg-muted sticky top-0 z-10">
        <tr>
          <Th>field</Th>
          <Th>bson_types</Th>
          <Th>presence</Th>
          <Th>indexed</Th>
          <Th last></Th>
        </tr>
      </thead>
      <tbody>
        {visible.length === 0 && (
          <tr>
            <td className="px-4 py-3 text-xs text-muted-foreground" colSpan={5}>
              No fields seen in the sampled documents.
            </td>
          </tr>
        )}
        {visible.map(c => {
          // `dataType` arrives pipe-joined from the adapter ("string|null",
          // "objectId", "int|long", …). Splitting + rendering as chips
          // matches Compass's "Multiple types" badge while staying compact
          // when it's just one.
          const types = c.dataType
            .split('|')
            .map(t => t.trim())
            .filter(Boolean);
          const presenceLabel = c.nullable ? 'sometimes' : 'always';
          const presenceClass = c.nullable
            ? 'text-yellow-700 dark:text-yellow-400'
            : 'text-emerald-700 dark:text-emerald-400';
          const isPk = c.key === 'PRIMARY';
          return (
            <tr key={c.id} className="border-b border-border/60 hover:bg-muted/20">
              <Td className="font-mono text-foreground px-4 py-2">
                <span className="inline-flex items-center gap-1.5">
                  {c.name}
                  {isPk && <span className="text-[10px] uppercase text-muted-foreground tracking-wide">primary</span>}
                </span>
              </Td>
              <Td className="font-mono text-muted-foreground px-4 py-2">
                {types.length === 0 ? (
                  <span className="text-muted-foreground/60">—</span>
                ) : (
                  <span className="inline-flex flex-wrap gap-1">
                    {types.map(t => (
                      <span
                        key={t}
                        className="px-1.5 py-0.5 rounded bg-muted text-[11px] font-mono"
                        title={types.length > 1 ? 'Field has multiple BSON types across sampled docs' : undefined}
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </Td>
              <Td className={`px-4 py-2 text-[11px] uppercase tracking-wide ${presenceClass}`}>
                {presenceLabel}
              </Td>
              <Td className="px-4 py-2 text-[11px] text-muted-foreground">
                {/* `is_unique` covers both PK + secondary unique indexes;
                    we surface it alongside indexed for at-a-glance reading. */}
                {isPk
                  ? 'unique (_id)'
                  : c.key === 'UNIQUE'
                    ? 'unique'
                    : '—'}
              </Td>
              <Td last className="px-4 py-2"> </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
