import type { SqlDialect } from '../../lib/db';

export interface DestructiveStatement {
  sql: string;
  kind: 'DELETE' | 'UPDATE' | 'DROP' | 'TRUNCATE' | 'ALTER_DROP';
  detail: string;
}

export interface DestructiveAnalysis {
  safe: true;
}

export interface DestructiveAnalysisWarning {
  safe: false;
  statements: DestructiveStatement[];
}

export type DestructiveResult = DestructiveAnalysis | DestructiveAnalysisWarning;

function findKeyword(upper: string, keyword: string): boolean {
  const idx = upper.indexOf(keyword);
  if (idx === -1) return false;
  const before = idx === 0 || !/\w/.test(upper[idx - 1]);
  const afterIdx = idx + keyword.length;
  const after = afterIdx >= upper.length || !/\w/.test(upper[afterIdx]);
  return before && after;
}

function analyzeSingle(sql: string): DestructiveStatement | null {
  const upper = sql.trimStart().toUpperCase();

  if (upper.startsWith('DELETE')) {
    if (!findKeyword(upper, 'WHERE')) {
      return {
        sql,
        kind: 'DELETE',
        detail: 'DELETE without WHERE clause will affect all rows',
      };
    }
  }

  if (upper.startsWith('UPDATE')) {
    if (!findKeyword(upper, 'WHERE')) {
      return {
        sql,
        kind: 'UPDATE',
        detail: 'UPDATE without WHERE clause will modify all rows',
      };
    }
  }

  if (upper.startsWith('TRUNCATE')) {
    return {
      sql,
      kind: 'TRUNCATE',
      detail: 'TRUNCATE will remove all rows from the table',
    };
  }

  if (upper.startsWith('DROP ')) {
    return {
      sql,
      kind: 'DROP',
      detail: `DROP ${upper.slice(5).trimStart().split(/\s+/)[0] || 'object'} is irreversible`,
    };
  }

  if (upper.startsWith('ALTER') && findKeyword(upper, 'DROP')) {
    return {
      sql,
      kind: 'ALTER_DROP',
      detail: 'ALTER TABLE ... DROP is irreversible',
    };
  }

  return null;
}

const SEPARATORS: Record<string, string> = {
  mysql: ';',
  postgres: ';',
  sqlite: ';',
  generic: ';',
};

function splitStatements(sql: string, dialect: SqlDialect): string[] {
  const sep = SEPARATORS[dialect] ?? ';';
  if (sep === '\n') {
    return sql
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Split on `;` respecting single/double quotes and backticks
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBack = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      current += ch;
      if (ch === "'" && sql[i - 1] !== '\\') inSingle = false;
    } else if (inDouble) {
      current += ch;
      if (ch === '"' && sql[i - 1] !== '\\') inDouble = false;
    } else if (inBack) {
      current += ch;
      if (ch === '`') inBack = false;
    } else {
      if (ch === "'") { inSingle = true; current += ch; }
      else if (ch === '"') { inDouble = true; current += ch; }
      else if (ch === '`') { inBack = true; current += ch; }
      else if (ch === ';') {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

export function analyzeDestructive(
  sql: string,
  dialect: SqlDialect,
): DestructiveResult {
  if (dialect === 'none') return { safe: true };

  const statements = splitStatements(sql, dialect);
  const dangerous: DestructiveStatement[] = [];

  for (const stmt of statements) {
    const result = analyzeSingle(stmt);
    if (result) dangerous.push(result);
  }

  if (dangerous.length === 0) return { safe: true };
  return { safe: false, statements: dangerous };
}
