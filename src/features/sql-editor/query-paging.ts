// Auto-paging helpers for the query editor. TablePlus-style: when the user runs
// a plain SELECT with no LIMIT of its own, we wrap it with LIMIT/OFFSET and show
// pager controls so large tables don't dump millions of rows at once. Queries
// that already carry a LIMIT, or aren't a single SELECT, are left untouched.
//
// Mirrors the backend row cap (src-tauri/adapter-api/src/query_cap.rs): the
// statement is inspected on a dialect-aware *masked* copy — literals, quoted
// identifiers and comments blanked out, length preserved — and only clauses at
// paren depth 0 count, so a LIMIT inside a subquery doesn't stop paging.

import type { SqlDialect } from '../../lib/db';
import { isSqlSpace, isWordChar, mainVerbIndex, maskLiteralsAndComments, tokenize } from './sql-lexer';

/** Verbs that write. Paging re-runs the statement for every page, so anything
 *  that writes (e.g. a Postgres data-modifying CTE) must run exactly once. */
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/**
 * Decide whether a payload is a single, pageable query. Pageable means:
 *   - exactly one statement (multi-statement runs are not paged)
 *   - it returns rows: SELECT, WITH … SELECT, TABLE t, VALUES …, or one of
 *     those in parentheses (`(SELECT …) UNION (SELECT …)`)
 *   - it has no top-level LIMIT (or, where they're reserved, OFFSET / FETCH)
 *     already — respect the user's
 *   - no INTO target (`SELECT … INTO new_table` would copy only one page)
 *   - no trailing locking or PROCEDURE clause we'd be unsafe to wrap
 *   - nothing in it writes data
 *
 * Returns the statement cut after its last significant token (trailing `;` and
 * comments dropped) when pageable, else null.
 */
export function pageableSelect(payload: string, dialect: SqlDialect): string | null {
  if (dialect === 'none') return null;
  let start = 0;
  while (start < payload.length && isSqlSpace(payload[start])) start++;
  const sql = payload.slice(start);
  const masked = maskLiteralsAndComments(sql, dialect);

  let end = masked.length;
  while (end > 0 && (isSqlSpace(masked[end - 1]) || masked[end - 1] === ';')) end--;
  if (end === 0) return null;
  const body = masked.slice(0, end);
  // A `;` before the end means more than one statement.
  if (body.includes(';')) return null;
  // SQLite takes LIMIT only on SELECT — not after a bare VALUES — and has no
  // parenthesized top-level queries.
  const sqlite = dialect === 'sqlite';
  // Only opening parens may come before the first keyword.
  let firstWordAt = 0;
  while (firstWordAt < end && !isWordChar(body[firstWordAt])) firstWordAt++;
  if ([...body.slice(0, firstWordAt)].some(ch => !isSqlSpace(ch) && (ch !== '(' || sqlite))) return null;

  const words = tokenize(body);
  const verb = words[mainVerbIndex(words)]?.text;
  const returnsRows = verb === 'SELECT' || (!sqlite && (verb === 'TABLE' || verb === 'VALUES'));
  if (!returnsRows) return null;

  if (words.some(w => WRITE_VERBS.has(w.text))) return null;

  // MySQL and SQLite only accept OFFSET after LIMIT and have no FETCH clause,
  // so there the words are plain identifiers (`SELECT t.offset FROM t`).
  const pagingWords = dialect === 'mysql' || dialect === 'sqlite' ? ['LIMIT'] : ['LIMIT', 'OFFSET', 'FETCH'];
  const top = words.filter(w => w.depth === 0).map(w => w.text);
  for (let i = 0; i < top.length; i++) {
    const word = top[i];
    const next = top[i + 1] ?? '';
    // Already has its own paging — leave it alone.
    if (pagingWords.includes(word)) return null;
    switch (word) {
      // SELECT … INTO @var / OUTFILE / DUMPFILE (MySQL), SELECT … INTO new_table (Postgres).
      case 'INTO':
      // PROCEDURE ANALYSE (MySQL 5.x).
      case 'PROCEDURE':
        return null;
      // FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE.
      case 'FOR':
        if (['UPDATE', 'SHARE', 'NO', 'KEY'].includes(next)) return null;
        break;
      // LOCK IN SHARE MODE (MySQL).
      case 'LOCK':
        if (next === 'IN') return null;
        break;
    }
  }

  return sql.slice(0, end);
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
