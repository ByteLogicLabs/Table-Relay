import { type ColumnInfo, type ForeignKey, type IndexInfo } from '../../lib/db';

export type ColumnKey = 'PRIMARY' | 'UNIQUE' | 'NONE';

export interface DraftColumn {
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
export const FALLBACK_DATA_TYPES = [
  'bigint', 'boolean', 'char', 'date', 'datetime', 'decimal', 'double',
  'float', 'int', 'json', 'smallint', 'text', 'time', 'timestamp',
  'varchar(255)',
];

export const STRINGY_TYPES = new Set([
  'char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'set',
]);
export const TEMPORAL_TYPES = new Set(['datetime', 'timestamp', 'time', 'date']);

export function typeRoot(type: string): string {
  const m = type.trim().toLowerCase().match(/^([a-z_]+)/);
  return m ? m[1] : '';
}

export function isStringyType(type: string): boolean {
  return STRINGY_TYPES.has(typeRoot(type));
}

export function extraOptionsFor(type: string): string[] {
  const root = typeRoot(type);
  const base = ['NONE', 'AUTO_INCREMENT', 'SERIAL DEFAULT VALUE'];
  if (TEMPORAL_TYPES.has(root)) base.push('ON UPDATE CURRENT_TIMESTAMP');
  return base;
}

/** SQL index algorithm — drives MySQL's `USING <algo>` clause. Mongo's
 *  schema editor doesn't render this column (per-field key types live
 *  inside the columns textbox instead), so this enum is SQL-only. */
export type IndexAlgorithm = 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL';

export interface DraftIndex {
  id: string;
  originalName: string | null;
  name: string;
  algorithm: IndexAlgorithm;
  isUnique: boolean;
  columns: string; // comma-separated
  pendingDelete: boolean;
}

export type FkAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'SET DEFAULT';

export interface DraftForeignKey {
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

export const FK_ACTIONS: FkAction[] = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT'];
export const SQL_INDEX_ALGORITHMS: IndexAlgorithm[] = ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL'];

export function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function columnKeyFor(col: ColumnInfo): ColumnKey {
  if (col.isPrimary) return 'PRIMARY';
  if (col.isUnique) return 'UNIQUE';
  return 'NONE';
}

export function columnsToDrafts(cols: ColumnInfo[]): DraftColumn[] {
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
export function columnTypeString(c: ColumnInfo): string {
  // MySQL surfaces `int(10) unsigned` via COLUMN_TYPE (already includes length).
  // For drivers that still return a bare `dataType`, splice in the length so
  // the draft -> original diff stays accurate.
  return c.dataType.includes('(') ? c.dataType : (c.length ? `${c.dataType}(${c.length})` : c.dataType);
}

export function normaliseExtra(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const up = s.toUpperCase();
  if (up === 'AUTO_INCREMENT') return 'AUTO_INCREMENT';
  if (up === 'ON UPDATE CURRENT_TIMESTAMP') return 'ON UPDATE CURRENT_TIMESTAMP';
  if (up === 'SERIAL DEFAULT VALUE') return 'SERIAL DEFAULT VALUE';
  return s;
}

export function indexesToDrafts(idxs: IndexInfo[], defaultAlgorithm: IndexAlgorithm = 'BTREE'): DraftIndex[] {
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

export function fksToDrafts(fks: ForeignKey[]): DraftForeignKey[] {
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
