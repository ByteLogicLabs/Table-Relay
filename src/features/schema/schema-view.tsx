import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ConnectionProfile } from '../../types';
import { db, isDbError, type IndexKeyValue, type IndexSpecPayload, type TableStructure } from '../../lib/db';
import { ensureTableStructure, refreshTableStructure } from '../../state/connections';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';
import { Loader2, AlertCircle, Plus, Trash2, Check, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { SearchableSelect } from '../../components/ui/searchable-select';
import { toast } from 'sonner';
import { dialectFromManifest } from '../data-grid/editor-kinds';
import {
  type ColumnKey,
  type DraftColumn,
  type DraftForeignKey,
  type DraftIndex,
  type IndexAlgorithm,
  FALLBACK_DATA_TYPES,
  SQL_INDEX_ALGORITHMS,
  extraOptionsFor,
  isStringyType,
  makeId,
  columnsToDrafts,
  indexesToDrafts,
  fksToDrafts,
} from './schema-types';
import {
  defaultFkName,
  buildSaveBatch,
  indexNeedsRecreate,
  isColumnsDirty,
  isIndexesDirty,
  isFksDirty,
} from './schema-ddl';
import {
  CellInput,
  CellSelect,
  CellCombobox,
  FkCell,
  Th,
  Td,
  MongoFieldsTable,
} from './schema-editors';

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
  // Server-wide collation catalogue for the per-column collation cell
  // (edit mode). Independent of charset; empty for adapters with no
  // collation concept (SQLite, Mongo, Redis) — the cell stays free-text.
  const [allCollations, setAllCollations] = useState<string[]>([]);

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

  // Server-wide collation list for the per-column collation cell. Fetched
  // in edit mode only (the cell is hidden while creating a table). Failure
  // is silent — the combobox just falls back to free-text entry.
  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    db.listAllCollations(connection.id)
      .then(list => { if (!cancelled) setAllCollations(list); })
      .catch(() => { if (!cancelled) setAllCollations([]); });
    return () => { cancelled = true; };
  }, [isNew, connection.id]);

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
  const dialect = useMemo(
    () => dialectFromManifest(activeManifest?.capabilities),
    [activeManifest],
  );
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
      // Seed a starter `id` column so the create-table grid opens ready to
      // type instead of empty — most tables start with an auto-increment
      // primary key, and an empty grid forced a confusing "Add column"
      // click before any work could begin. The row is a normal draft: the
      // user can rename, retype, or delete it. Dirty-tracking still gates
      // on a real table name + a named column, so this seed alone doesn't
      // mark the tab dirty.
      const dialect = dialectFromManifest(activeManifest?.capabilities);
      const seed: DraftColumn = {
        id: makeId('col'),
        originalName: null,
        name: 'id',
        dataType: dialect === 'postgres' ? 'serial' : 'int',
        nullable: false,
        defaultValue: null,
        key: 'PRIMARY',
        extra: dialect === 'mysql' ? 'AUTO_INCREMENT' : '',
        characterSet: '',
        collation: '',
        pendingDelete: false,
      };
      setColumns([seed]);
      setIndexes([]);
      setForeignKeys([]);
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

  // Hold the latest onDirtyChange in a ref so the dirty-reporting effect can
  // depend on `dirty` alone. The parent passes a fresh arrow closure every
  // render; if it were in the deps the effect would fire on every parent
  // render and (via setTabs) spin into a render loop.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

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

  const handleNewTableNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setNewTableName(e.target.value), []);
  const handleSaveClick = useCallback(async () => {
    setLocalSaving(true);
    try {
      await doSave();
    } finally {
      setLocalSaving(false);
    }
  }, [doSave]);

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
  // Per-row handler factories — the map closes over the column id; these
  // produce the named handlers without inlining arrows in JSX.
  const makeColumnNameCommit = (id: string) => (v: string) => updateColumn(id, { name: v });
  const makeColumnDataTypeCommit = (id: string) => (v: string) => updateColumn(id, { dataType: v });
  const makeColumnNullableChange = (id: string) => (v: string) => updateColumn(id, { nullable: v === 'YES' });
  const makeColumnDefaultCommit = (id: string) => (v: string) => updateColumn(id, { defaultValue: v === '' ? null : v });
  const makeColumnKeyChange = (id: string) => (v: string) => updateColumn(id, { key: v as ColumnKey });
  const makeColumnExtraCommit = (id: string) => (v: string) => updateColumn(id, { extra: v === 'NONE' ? '' : v });
  const makeColumnCharsetCommit = (id: string) => (v: string) => updateColumn(id, { characterSet: v });
  const makeColumnCollationCommit = (id: string) => (v: string) => updateColumn(id, { collation: v });
  const makeToggleDeleteColumn = (id: string) => () => toggleDeleteColumn(id);

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
  // Per-row handler factories for the indexes table.
  const makeIndexNameCommit = (id: string) => (v: string) => updateIndex(id, { name: v });
  const makeIndexAlgorithmChange = (id: string) => (v: string) => updateIndex(id, { algorithm: v as IndexAlgorithm });
  const makeIndexUniqueChange = (id: string) => (v: string) => updateIndex(id, { isUnique: v === 'TRUE' });
  const makeIndexColumnsCommit = (id: string) => (v: string) => updateIndex(id, { columns: v });
  const makeToggleDeleteIndex = (id: string) => () => toggleDeleteIndex(id);

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

  // Per-row FK handler factories — close over the column's effective name.
  const makeFkApply = (colName: string) => (patch: Omit<DraftForeignKey, 'id' | 'pendingDelete' | 'originalName' | 'name'> & { name?: string }) => upsertFk(colName, patch);
  const makeFkRemove = (colName: string) => () => dropFkForColumn(colName);

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
      <div className="h-10 border-b border-border flex items-center px-4 bg-muted/30 text-xs text-muted-foreground gap-2">
        <span className="font-mono">{structure.schema}.</span>
        {effectiveIsNew ? (
          <>
            <input
              value={newTableName}
              onChange={handleNewTableNameChange}
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
        <div className="ml-auto flex items-center gap-1.5">
          {columnsEditable && (
            <Button variant="secondary" size="xs" onClick={addColumn} className="font-medium text-foreground">
              <Plus className="w-3 h-3 mr-1" />
              Add column
            </Button>
          )}
          {schemaEditable && (
            <Button variant="secondary" size="xs" onClick={addIndex} className="font-medium text-foreground">
              <Plus className="w-3 h-3 mr-1" />
              Add index
            </Button>
          )}
          {schemaEditable && (
            <>
              <span className="w-px h-4 bg-border mx-0.5" />
              <Button
                size="xs"
                variant={dirty ? 'default' : 'outline'}
                disabled={saveDisabled}
                onClick={handleSaveClick}
              >
                <Check className="w-3 h-3 mr-1" />
                {localSaving
                  ? (effectiveIsNew ? 'Creating…' : 'Saving…')
                  : (effectiveIsNew ? 'Create table' : 'Save')}
              </Button>
              <Button size="xs" variant="destructive" disabled={!dirty || localSaving} onClick={doDiscard}>
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
          <SearchableSelect
            value={newCharset}
            onChange={setNewCharset}
            className="h-7 w-56"
            searchPlaceholder="Search encodings…"
            options={[
              { value: TABLE_DEFAULT_OPT, label: 'Default (inherit from DB)' },
              ...encodings.map(name => ({ value: name, label: name })),
            ]}
          />
          {newCharset !== TABLE_DEFAULT_OPT && collations.length > 0 && (
            <>
              <span className="text-muted-foreground ml-2">Collation</span>
              <SearchableSelect
                value={newCollation}
                onChange={setNewCollation}
                className="h-7 w-72"
                searchPlaceholder="Search collations…"
                options={[
                  { value: TABLE_DEFAULT_OPT, label: 'Default (server picks)' },
                  ...collations.map(name => ({ value: name, label: name })),
                ]}
              />
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
                        onCommit={makeColumnNameCommit(c.id)}
                        disabled={!columnsEditable || c.pendingDelete}
                        placeholder="column_name"
                      />
                    </Td>
                    <Td className="font-mono text-muted-foreground p-0">
                      <CellCombobox
                        value={c.dataType}
                        onCommit={makeColumnDataTypeCommit(c.id)}
                        options={dataTypeOptions}
                        disabled={!columnsEditable || c.pendingDelete}
                        placeholder="varchar(255)"
                      />
                    </Td>
                    <Td className="p-0">
                      <CellSelect
                        value={c.nullable ? 'YES' : 'NO'}
                        onChange={makeColumnNullableChange(c.id)}
                        disabled={!columnsEditable || c.pendingDelete}
                        options={[{ value: 'YES', label: 'YES' }, { value: 'NO', label: 'NO' }]}
                      />
                    </Td>
                    <Td className="font-mono text-muted-foreground p-0">
                      <CellInput
                        value={c.defaultValue ?? ''}
                        onCommit={makeColumnDefaultCommit(c.id)}
                        disabled={!columnsEditable || c.pendingDelete}
                        placeholder="NULL"
                      />
                    </Td>
                    <Td className="p-0">
                      <CellSelect
                        value={c.key}
                        onChange={makeColumnKeyChange(c.id)}
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
                        onCommit={makeColumnExtraCommit(c.id)}
                        options={extraOptionsFor(c.dataType, dialect)}
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
                          onCommit={makeColumnCharsetCommit(c.id)}
                          disabled={!columnsEditable || c.pendingDelete || !isStringyType(c.dataType)}
                          placeholder={isStringyType(c.dataType) ? 'utf8mb4' : ''}
                        />
                      </Td>
                    )}
                    {!effectiveIsNew && (
                      <Td className="font-mono text-muted-foreground p-0">
                        {allCollations.length > 0 ? (
                          <CellCombobox
                            value={c.collation}
                            onCommit={makeColumnCollationCommit(c.id)}
                            options={allCollations}
                            disabled={!columnsEditable || c.pendingDelete || !isStringyType(c.dataType)}
                            placeholder={isStringyType(c.dataType) ? 'utf8mb4_unicode_ci' : ''}
                          />
                        ) : (
                          <CellInput
                            value={c.collation}
                            onCommit={makeColumnCollationCommit(c.id)}
                            disabled={!columnsEditable || c.pendingDelete || !isStringyType(c.dataType)}
                            placeholder={isStringyType(c.dataType) ? 'utf8mb4_unicode_ci' : ''}
                          />
                        )}
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
                          onApply={makeFkApply(c.originalName ?? c.name)}
                          onRemove={makeFkRemove(c.originalName ?? c.name)}
                        />
                      </Td>
                    )}
                    <Td last className="p-0 w-8">
                      <button
                        type="button"
                        onClick={makeToggleDeleteColumn(c.id)}
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
                        onCommit={makeIndexNameCommit(idx.id)}
                        disabled={!schemaEditable || idx.pendingDelete}
                        placeholder="idx_name"
                      />
                    </Td>
                    {!indexesOnlyMode && (
                      <Td className="p-0">
                        <CellSelect
                          value={idx.algorithm}
                          onChange={makeIndexAlgorithmChange(idx.id)}
                          disabled={!schemaEditable || idx.pendingDelete}
                          options={SQL_INDEX_ALGORITHMS.map(a => ({ value: a, label: a }))}
                        />
                      </Td>
                    )}
                    <Td className="p-0">
                      <CellSelect
                        value={idx.isUnique ? 'TRUE' : 'FALSE'}
                        onChange={makeIndexUniqueChange(idx.id)}
                        disabled={!schemaEditable || idx.pendingDelete}
                        options={[{ value: 'TRUE', label: 'TRUE' }, { value: 'FALSE', label: 'FALSE' }]}
                      />
                    </Td>
                    <Td className="font-mono p-0">
                      <CellInput
                        value={idx.columns}
                        onCommit={makeIndexColumnsCommit(idx.id)}
                        disabled={!schemaEditable || idx.pendingDelete}
                        placeholder={indexesOnlyMode
                          ? 'email, score:desc, location:2dsphere'
                          : 'col1, col2'}
                      />
                    </Td>
                    <Td last className="p-0 w-8">
                      <button
                        type="button"
                        onClick={makeToggleDeleteIndex(idx.id)}
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
