// Serialize an in-memory query result (columns + rows) to CSV, JSON, or SQL
// INSERT statements. The result set is already fully loaded in the editor, so
// these build a single string in memory — no streaming needed (that's the
// data-grid's full-table export concern, handled by ExportWriter).

export type ResultExportFormat = 'csv' | 'json' | 'sql';

export interface ResultColumn {
  name: string;
}

interface SerializeOptions {
  columns: ResultColumn[];
  rows: unknown[][];
  /** Target table for SQL INSERTs. Falls back to a placeholder when unknown. */
  tableName?: string;
  /** Identifier-quote style for SQL output. */
  dialect?: 'mysql' | 'postgres' | 'sqlite' | 'generic' | 'none' | string;
}

/** Render a cell as its display string (used by CSV). null → empty field. */
function cellToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** RFC-4180 CSV field quoting: wrap in quotes and double internal quotes when
 *  the value contains a comma, quote, CR, or LF. */
function csvField(v: unknown): string {
  const s = cellToText(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(columns: ResultColumn[], rows: unknown[][]): string {
  const lines: string[] = [];
  lines.push(columns.map(c => csvField(c.name)).join(','));
  for (const row of rows) {
    lines.push(columns.map((_, i) => csvField(row[i])).join(','));
  }
  // Trailing newline so the file ends cleanly.
  return lines.join('\r\n') + '\r\n';
}

function toJson(columns: ResultColumn[], rows: unknown[][]): string {
  const objects = rows.map(row => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => { obj[c.name] = row[i] ?? null; });
    return obj;
  });
  return JSON.stringify(objects, null, 2) + '\n';
}

/** Quote a SQL identifier for the dialect (backticks for MySQL, double-quotes
 *  for ANSI/Postgres/SQLite). */
function quoteIdent(name: string, dialect?: string): string {
  if (dialect === 'mysql' || dialect === 'generic') {
    return '`' + name.replace(/`/g, '``') + '`';
  }
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Render a value as a SQL literal. Strings are single-quoted with escaping;
 *  numbers/bools pass through; null → NULL; objects → quoted JSON text. */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'bigint') return v.toString();
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

function toSqlInserts(
  columns: ResultColumn[],
  rows: unknown[][],
  tableName: string | undefined,
  dialect: string | undefined,
): string {
  const table = (tableName && tableName.trim()) ? tableName.trim() : 'exported_table';
  const qTable = quoteIdent(table, dialect);
  const qCols = columns.map(c => quoteIdent(c.name, dialect)).join(', ');
  const lines: string[] = [];
  lines.push(`-- ${rows.length} row${rows.length === 1 ? '' : 's'} exported`);
  for (const row of rows) {
    const vals = columns.map((_, i) => sqlLiteral(row[i])).join(', ');
    lines.push(`INSERT INTO ${qTable} (${qCols}) VALUES (${vals});`);
  }
  return lines.join('\n') + '\n';
}

/** Serialize a result to the requested format. */
export function serializeResult(format: ResultExportFormat, opts: SerializeOptions): string {
  switch (format) {
    case 'csv':  return toCsv(opts.columns, opts.rows);
    case 'json': return toJson(opts.columns, opts.rows);
    case 'sql':  return toSqlInserts(opts.columns, opts.rows, opts.tableName, opts.dialect);
  }
}

/** Default filename (no directory) for a given format. */
export function defaultFileName(format: ResultExportFormat, tableName?: string): string {
  const base = (tableName && tableName.trim()) ? tableName.trim().replace(/[^A-Za-z0-9_-]+/g, '_') : 'query-result';
  return `${base}.${format}`;
}
