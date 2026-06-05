import { type ColumnInfo, type ForeignKey, type IndexInfo, type TableStructure } from '../../lib/db';
import { type Dialect } from '../data-grid/editor-kinds';
import {
  type DraftColumn,
  type DraftForeignKey,
  type DraftIndex,
  columnKeyFor,
  columnTypeString,
  isStringyType,
  normaliseExtra,
} from './schema-types';

export function q(ident: string, dialect: Dialect = 'mysql'): string {
  if (dialect === 'mysql') return '`' + ident.replace(/`/g, '``') + '`';
  return '"' + ident.replace(/"/g, '""') + '"';
}

export function quoteQualified(schema: string, table: string, dialect: Dialect = 'mysql'): string {
  return `${q(schema, dialect)}.${q(table, dialect)}`;
}

export function buildColumnClause(col: DraftColumn, dialect: Dialect = 'mysql'): string {
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

export function defaultFkName(table: string, col: string): string {
  return `fk_${table}_${col}`;
}

/** Generate a portable, deterministic index name when the user left
 *  the field blank. Mirrors common convention (`idx_table_col1_col2`,
 *  `uniq_…` for UNIQUE) so the schema diff stays readable. */
export function defaultIndexName(table: string, cols: string[], unique: boolean): string {
  const prefix = unique ? 'uniq' : 'idx';
  return [prefix, table, ...cols].join('_');
}

// -------- diff helpers --------

export function isColumnsDirty(original: ColumnInfo[], drafts: DraftColumn[]): boolean {
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

export function isIndexesDirty(original: IndexInfo[], drafts: DraftIndex[]): boolean {
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

export function isFksDirty(original: ForeignKey[], drafts: DraftForeignKey[]): boolean {
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

export function buildSaveBatch(
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

export function indexNeedsRecreate(d: DraftIndex, o?: IndexInfo): boolean {
  if (!o) return true;
  if (d.name !== o.name) return true;
  if (d.isUnique !== o.unique) return true;
  const cols = d.columns.split(',').map(s => s.trim()).filter(Boolean);
  return cols.join(',') !== o.columns.join(',');
}

export function fkNeedsRecreate(d: DraftForeignKey, o?: ForeignKey): boolean {
  if (!o) return true;
  if (d.columns.join(',') !== o.fromColumns.join(',')) return true;
  if (d.refTable !== o.toTable) return true;
  const refCols = d.refColumns.split(',').map(s => s.trim()).filter(Boolean);
  if (refCols.join(',') !== o.toColumns.join(',')) return true;
  if (d.onUpdate !== 'NO ACTION' || d.onDelete !== 'NO ACTION') return true;
  return false;
}
