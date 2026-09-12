// Auto-paging helpers for the query editor. TablePlus-style: when the user runs
// a plain SELECT with no LIMIT of its own, we wrap it with LIMIT/OFFSET and show
// pager controls so large tables don't dump millions of rows at once. Queries
// that already carry a LIMIT, or aren't a single SELECT, are left untouched.

import { splitSqlStatements } from './sql-editor-utils';

/**
 * Decide whether a payload is a single, pageable SELECT. Pageable means:
 *   - exactly one statement (multi-statement runs are not paged)
 *   - it's a SELECT (or a WITH … SELECT) — not INSERT/UPDATE/DDL/etc.
 *   - it has no top-level LIMIT / OFFSET / FETCH already (respect the user's)
 *   - no trailing locking or file-export clause we'd be unsafe to wrap
 *
 * Returns the trimmed single statement when pageable, else null.
 */
export function pageableSelect(payload: string): string | null {
  const trimmed = payload.trim().replace(/;\s*$/, '');
  if (!trimmed) return null;

  // Single statement only. splitSqlStatements honors quotes/comments.
  const stmts = splitSqlStatements(trimmed);
  if (stmts.length !== 1) return null;
  const stmt = stmts[0].trim();

  // Must start with SELECT or WITH (CTE feeding a SELECT).
  if (!/^(select|with)\b/i.test(stmt)) return null;

  // Mask string/identifier literals and comments so keywords inside them don't trip the
  // checks below (e.g. a column value 'limit 5' or a comment '-- check limit').
  const masked = maskLiteralsAndComments(stmt);

  // If it starts with WITH, verify the main statement after CTEs is a SELECT
  // (and not WITH … INSERT/UPDATE/DELETE).
  if (/^with\b/i.test(stmt)) {
    if (/\b(insert\s+into|update\s+\w+|delete\s+from)\b/i.test(masked)) {
      return null;
    }
  }

  // Already has its own paging — leave it alone.
  if (/\blimit\b/i.test(masked)) return null;
  if (/\boffset\b/i.test(masked)) return null;
  if (/\bfetch\s+(first|next)\b/i.test(masked)) return null;

  // Locking or special trailing clauses that disallow trailing LIMIT / OFFSET.
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(masked)) return null;
  if (/\block\s+in\s+share\s+mode\b/i.test(masked)) return null;
  if (/\binto\s+(@\w+|outfile|dumpfile)\b/i.test(masked)) return null;
  if (/\bprocedure\s+analyse\b/i.test(masked)) return null;

  return stmt;
}

/**
 * Wrap a pageable SELECT with LIMIT/OFFSET for the given page (0-based) and page
 * size. We fetch ONE extra row beyond the page size so the caller can tell
 * whether a next page exists without a separate COUNT. Returns the SQL to run.
 */
export function buildPagedSql(stmt: string, page: number, pageSize: number): string {
  const limit = pageSize + 1;          // +1 sentinel row → "has next page?"
  const offset = page * pageSize;
  const base = stmt.trim().replace(/;\s*$/, '');
  return `${base}\nLIMIT ${limit} OFFSET ${offset}`;
}

/**
 * Replace string literals, dollar quotes, and SQL comments with spaces
 * (preserving length and character positions) so regex scans for keywords
 * only see real SQL code.
 */
export function maskLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    // Line comments: -- or #
    if ((ch === '-' && next === '-') || ch === '#') {
      const isDash = ch === '-';
      out += isDash ? '  ' : ' ';
      i += isDash ? 2 : 1;
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    // Block comments: /* ... */
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Dollar quotes: $tag$...$tag$ or $$...$$
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
      if (match) {
        const tag = match[0];
        out += ' '.repeat(tag.length);
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx !== -1) {
          while (i < closeIdx + tag.length) {
            out += sql[i] === '\n' ? '\n' : ' ';
            i++;
          }
          continue;
        }
      }
    }

    // String / identifier quotes: '...', "...", `...`
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // SQL '' escape inside single quotes.
          if (quote === "'" && sql[i + 1] === "'") {
            out += '  ';
            i += 2;
            continue;
          }
          out += ' ';
          i++;
          break;
        }
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}
