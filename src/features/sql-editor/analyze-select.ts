// Lightweight SELECT analyzer that decides whether a SQL statement's result
// can be edited in place. The bar is intentionally high — we only enable
// editing for the simple, unambiguous case where every result row maps back
// to exactly one base-table row:
//
//   - Single SELECT (no UNION / EXCEPT / INTERSECT, no CTEs)
//   - From exactly one base table (no JOINs, no subqueries, no functions)
//   - SELECT list is `*` or bare column references (no aliases, no
//     expressions, no aggregates, no DISTINCT)
//   - Optional WHERE / ORDER BY / LIMIT / OFFSET tail is fine
//
// Anything more clever is rejected with a reason — the user keeps a
// read-only result table and a tooltip explaining why.

export type SelectAnalysis =
  | {
      editable: true;
      schema: string | null;
      table: string;
      // null → SELECT *, every result column is a base-table column.
      // string[] → explicit column list (still bare names, no aliases).
      selectColumns: string[] | null;
    }
  | {
      editable: false;
      reason: string;
    };

const FORBIDDEN_KEYWORDS = [
  'JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'GROUP BY', 'HAVING', 'DISTINCT',
];

// Strip /* */ block comments and -- line comments. Keeps strings intact —
// the comment markers inside a quoted string would be a problem for a real
// parser, but for the rejection-style check below it's fine: any unusual
// SELECT shape ends up rejected anyway.
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) return t;
  const first = t[0];
  const last = t[t.length - 1];
  if ((first === '`' && last === '`') || (first === '"' && last === '"')) {
    // Double-double-quote / double-backtick is the standard escape — collapse it.
    return t.slice(1, -1).replace(first === '`' ? /``/g : /""/g, first);
  }
  if (first === '[' && last === ']') return t.slice(1, -1);
  return t;
}

// Split `schema.table` / `"schema"."table"` / single ident into parts.
// Returns null if the shape isn't a plain dotted identifier (e.g. it contains
// parens, spaces, or a function call).
function splitQualifiedIdent(raw: string): { schema: string | null; name: string } | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  // Reject anything that looks like a subquery, function call, or alias clause.
  if (/[()\s]/.test(t)) return null;
  // Walk the string honoring quoted segments so we don't split on a dot
  // inside a quoted identifier.
  const parts: string[] = [];
  let cur = '';
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '`' || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      const end = t.indexOf(close, i + 1);
      if (end === -1) return null;
      cur += t.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '.') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  parts.push(cur);
  if (parts.length === 1) return { schema: null, name: unquoteIdent(parts[0]) };
  if (parts.length === 2) return { schema: unquoteIdent(parts[0]), name: unquoteIdent(parts[1]) };
  // 3 parts (db.schema.table) — supported by some dialects but ambiguous to
  // map back to TableStructure. Reject for now.
  return null;
}

// Find the first top-level FROM keyword (i.e. not inside parens). Returns
// -1 if absent. Case-insensitive, word-boundary aware.
function findTopLevelFrom(sql: string): number {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (ch === 'f' || ch === 'F')) {
      // Match `FROM` with leading whitespace and a trailing whitespace/paren.
      const slice = sql.slice(i, i + 4);
      if (/^from$/i.test(slice)) {
        const before = i === 0 ? ' ' : sql[i - 1];
        const after = sql[i + 4] ?? ' ';
        if (/\s/.test(before) && /[\s(]/.test(after)) return i;
      }
    }
  }
  return -1;
}

// Find the start index of one of the trailing clauses (WHERE / ORDER BY /
// LIMIT / OFFSET / GROUP BY / HAVING / FOR / UNION / etc.) at top level.
// Returns sql.length when no such clause exists.
function findTailStart(sql: string): number {
  // We scan token-by-token-ish via a regex with word boundaries, but only
  // accept matches at depth 0.
  const re = /\b(where|order\s+by|limit|offset|group\s+by|having|for\s+update|for\s+share|union|intersect|except)\b/gi;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  // Build a depth map by walking once; cheaper than re-scanning per match.
  const depthAt: number[] = new Array(sql.length + 1).fill(0);
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inDouble && !inBack && ch === "'" && sql[i - 1] !== '\\') inSingle = !inSingle;
    else if (!inSingle && !inBack && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === '`') inBack = !inBack;
    else if (!inSingle && !inDouble && !inBack) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    depthAt[i + 1] = depth;
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (depthAt[m.index] === 0) return m.index;
  }
  return sql.length;
}

// Split a SELECT projection list on top-level commas.
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inDouble && !inBack && ch === "'" && s[i - 1] !== '\\') inSingle = !inSingle;
    else if (!inSingle && !inBack && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === '`') inBack = !inBack;
    else if (!inSingle && !inDouble && !inBack) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}

// A "bare column" projection: an unqualified or table-qualified identifier
// with no alias and no expression. Returns the column name, or null.
function asBareColumn(item: string): string | null {
  const t = item.trim();
  if (t.length === 0) return null;
  // Reject anything containing operators / function calls / aliases.
  if (/[()*+\-/%]/.test(t)) return null;
  if (/\bAS\b/i.test(t)) return null;
  // Allow quoted identifiers and table-qualified names.
  const parts = splitQualifiedIdent(t);
  if (!parts) return null;
  return parts.name;
}

export function analyzeSelect(rawSql: string): SelectAnalysis {
  if (!rawSql || rawSql.trim().length === 0) {
    return { editable: false, reason: 'No statement to edit.' };
  }
  const sql = stripComments(rawSql).replace(/;+\s*$/, '').trim();
  if (sql.length === 0) {
    return { editable: false, reason: 'No statement to edit.' };
  }
  // Reject CTEs upfront — would need to chase the actual SELECT through the
  // WITH list to map back to a base table.
  if (/^with\b/i.test(sql)) {
    return { editable: false, reason: 'Editing CTE results isn’t supported.' };
  }
  if (!/^select\b/i.test(sql)) {
    return { editable: false, reason: 'Only SELECT results can be edited.' };
  }

  // Forbid join/union/group/having/distinct anywhere at top level.
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(sql)) {
      return { editable: false, reason: `Editing not supported when query uses ${kw}.` };
    }
  }

  const fromIdx = findTopLevelFrom(sql);
  if (fromIdx === -1) {
    return { editable: false, reason: 'SELECT without FROM cannot be edited.' };
  }

  // Projection: between SELECT and FROM.
  const projection = sql.slice('select'.length, fromIdx).trim();
  if (projection.length === 0) {
    return { editable: false, reason: 'Empty SELECT list.' };
  }

  let selectColumns: string[] | null = null;
  if (projection.trim() === '*') {
    selectColumns = null; // every result column is a base-table column
  } else {
    const items = splitTopLevelCommas(projection);
    const cols: string[] = [];
    for (const item of items) {
      // Reject `t.*` shorthand — for our single-table case it's equivalent
      // to `*`, but it complicates the column-name match below.
      if (/\.\s*\*$/.test(item.trim())) {
        return { editable: false, reason: 'Editing with `table.*` is not supported — use `*` or list columns.' };
      }
      const name = asBareColumn(item);
      if (!name) {
        return { editable: false, reason: 'Editing not supported when SELECT list has expressions, aliases, or functions.' };
      }
      cols.push(name);
    }
    selectColumns = cols;
  }

  // Source: between FROM and the first tail clause.
  const afterFrom = sql.slice(fromIdx + 'from'.length);
  const tailStart = findTailStart(afterFrom);
  const source = afterFrom.slice(0, tailStart).trim().replace(/;+\s*$/, '').trim();
  if (source.length === 0) {
    return { editable: false, reason: 'Missing FROM target.' };
  }
  // A single space-separated token is fine. A second token would be an alias
  // (`FROM users u`) — we reject for now since our DataGrid commit path
  // assumes the bare table name in messages, and aliases also imply the
  // SELECT list might use the alias. Accepting bare aliases would be a small
  // follow-up.
  if (/\s/.test(source)) {
    return { editable: false, reason: 'Editing not supported when FROM uses an alias or multiple tables.' };
  }
  const ident = splitQualifiedIdent(source);
  if (!ident) {
    return { editable: false, reason: 'Editing not supported for this FROM target (subquery or function call).' };
  }
  return {
    editable: true,
    schema: ident.schema,
    table: ident.name,
    selectColumns,
  };
}
