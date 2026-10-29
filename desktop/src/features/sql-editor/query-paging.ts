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
 *   - no trailing locking clause we'd be unsafe to wrap (FOR UPDATE/SHARE)
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

  // Mask string/identifier literals so keywords inside them don't trip the
  // checks below (e.g. a column value 'limit 5').
  const masked = maskLiterals(stmt);

  // Already has its own paging / locking — leave it alone.
  if (/\blimit\b/i.test(masked)) return null;
  if (/\boffset\b/i.test(masked)) return null;
  if (/\bfetch\s+(first|next)\b/i.test(masked)) return null;
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(masked)) return null;

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
  return `${base} LIMIT ${limit} OFFSET ${offset}`;
}

/**
 * Replace string and quoted-identifier literals with spaces (preserving length)
 * so a regex scan for keywords like LIMIT only sees real SQL, never literal
 * contents. Handles '...' (with '' escape), "..." and `...`.
 */
function maskLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // SQL '' escape inside single quotes.
          if (quote === "'" && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
          out += ' ';
          i++;
          break;
        }
        out += ' ';
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
