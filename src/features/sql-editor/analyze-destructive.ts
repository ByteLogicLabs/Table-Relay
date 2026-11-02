import type { SqlDialect } from '../../lib/db';
import { mainVerbIndex, maskLiteralsAndComments, splitStatementRanges, tokenize } from './sql-lexer';

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

/**
 * Judge one statement by its words outside literals and comments. Only the
 * statement's own clauses count: a `WHERE` inside a string (`SET note =
 * 'where'`) or a subquery (`SET a = (SELECT … WHERE …)`) doesn't limit which
 * rows an UPDATE or DELETE touches.
 */
function analyzeSingle(sql: string, dialect: SqlDialect): DestructiveStatement | null {
  const words = tokenize(maskLiteralsAndComments(sql, dialect));
  const verbAt = mainVerbIndex(words);
  if (verbAt < 0) return null;
  const verb = words[verbAt];
  const clauses = words.slice(verbAt + 1).filter((w) => w.depth === verb.depth).map((w) => w.text);

  switch (verb.text) {
    case 'DELETE':
      if (!clauses.includes('WHERE')) {
        return { sql, kind: 'DELETE', detail: 'DELETE without WHERE clause will affect all rows' };
      }
      break;
    case 'UPDATE':
      if (!clauses.includes('WHERE')) {
        return { sql, kind: 'UPDATE', detail: 'UPDATE without WHERE clause will modify all rows' };
      }
      break;
    case 'TRUNCATE':
      return { sql, kind: 'TRUNCATE', detail: 'TRUNCATE will remove all rows from the table' };
    case 'DROP':
      return { sql, kind: 'DROP', detail: `DROP ${clauses[0] ?? 'object'} is irreversible` };
    case 'ALTER':
      if (clauses.includes('DROP')) {
        return { sql, kind: 'ALTER_DROP', detail: 'ALTER TABLE ... DROP is irreversible' };
      }
      break;
  }
  return null;
}

export function analyzeDestructive(
  sql: string,
  dialect: SqlDialect,
): DestructiveResult {
  if (dialect === 'none') return { safe: true };

  const dangerous: DestructiveStatement[] = [];
  for (const range of splitStatementRanges(sql, dialect)) {
    const stmt = sql.slice(range.start, range.end).trim();
    if (!stmt) continue;
    const result = analyzeSingle(stmt, dialect);
    if (result) dangerous.push(result);
  }

  if (dangerous.length === 0) return { safe: true };
  return { safe: false, statements: dangerous };
}
