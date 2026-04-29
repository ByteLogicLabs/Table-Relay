// Regex-based SQL buffer analysis. The goal is "good enough for 95% of real
// queries" without pulling in a full SQL parser. Detects:
//   - the statement the cursor sits in (splits on top-level `;`)
//   - the clause the cursor sits in (SELECT / FROM / JOIN / WHERE / …)
//   - tables referenced by FROM / JOIN / UPDATE / INTO, including aliases
//   - whether the cursor is inside a backtick-quoted identifier
//   - the `prefix` typed so far and the `qualifier` before a trailing `.`

export type SqlClause =
  | 'select'
  | 'from'
  | 'join'
  | 'where'
  | 'group'
  | 'order'
  | 'having'
  | 'set'
  | 'values'
  | 'update'
  | 'into'
  | 'on'
  | 'unknown';

export interface SqlReferencedTable {
  schema?: string;
  name: string;
  alias?: string;
}

export interface SqlContext {
  clause: SqlClause;
  referencedTables: SqlReferencedTable[];
  /** Identifier fragment immediately before the cursor. */
  prefix: string;
  /** True when the cursor sits inside an unclosed backtick. */
  quoted: boolean;
  /** Token before a trailing `.` — e.g. `users` in `SELECT users.` */
  qualifier?: string;
  /** The statement text the cursor sits in (excluding the leading/trailing `;`). */
  statement: string;
  /** Offset of the cursor within `statement`. */
  cursorInStatement: number;
}

/**
 * Split a buffer into statements at top-level `;`. Respects single-quoted,
 * double-quoted and backtick-quoted strings plus `--` line comments. Mirrors
 * the Rust split_statements in src-tauri/src/db/mysql.rs so the behaviour is
 * consistent end-to-end.
 */
export function splitStatements(input: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let buf = '';
  let bufStart = 0;
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const prev = i > 0 ? input[i - 1] : '';
    if (ch === "'" && !inDouble && !inBack && prev !== '\\') inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBack && prev !== '\\') inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inBack = !inBack;
    else if (ch === '-' && !inSingle && !inDouble && !inBack && input[i + 1] === '-') {
      // line comment — consume to newline.
      while (i < input.length && input[i] !== '\n') { buf += input[i]; i++; }
      if (i < input.length) { buf += input[i]; /* newline */ }
      continue;
    } else if (ch === ';' && !inSingle && !inDouble && !inBack) {
      out.push({ text: buf, start: bufStart });
      buf = '';
      bufStart = i + 1;
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push({ text: buf, start: bufStart });
  return out;
}

/** Find the statement containing `cursorOffset`. */
export function locateStatement(
  buffer: string,
  cursorOffset: number,
): { text: string; cursorInStatement: number } {
  const stmts = splitStatements(buffer);
  for (const s of stmts) {
    if (cursorOffset >= s.start && cursorOffset <= s.start + s.text.length) {
      return { text: s.text, cursorInStatement: cursorOffset - s.start };
    }
  }
  // Cursor past everything — use the last non-empty statement.
  const last = stmts[stmts.length - 1];
  return last
    ? { text: last.text, cursorInStatement: last.text.length }
    : { text: buffer, cursorInStatement: cursorOffset };
}

// Regex for referenced tables. Handles optional schema qualifier, optional
// backticks on either side of the dot, optional alias (with or without `AS`).
// Examples matched:
//   FROM users
//   FROM shop.users
//   FROM `users`
//   FROM `shop`.`users`
//   FROM users u
//   FROM users AS u
//   JOIN orders AS o
//   UPDATE products p
//   INTO order_items
const TABLE_RE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+`?(\w+)`?(?:\s*\.\s*`?(\w+)`?)?(?:\s+(?:AS\s+)?(\w+))?/gi;

const ALIAS_STOPWORDS: ReadonlySet<string> = new Set([
  'WHERE', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING', 'LIMIT',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'UNION',
  'SET', 'VALUES', 'SELECT', 'AND', 'OR',
]);

export function extractReferencedTables(statement: string): SqlReferencedTable[] {
  const out: SqlReferencedTable[] = [];
  TABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_RE.exec(statement)) !== null) {
    const first = m[1];
    const second = m[2];
    const alias = m[3];
    const table: SqlReferencedTable = second
      ? { schema: first, name: second }
      : { name: first };
    if (alias && !ALIAS_STOPWORDS.has(alias.toUpperCase())) {
      table.alias = alias;
    }
    out.push(table);
  }
  return out;
}

const CLAUSE_KEYWORDS: Array<{ re: RegExp; clause: SqlClause }> = [
  // Multi-word clauses first so we don't misattribute.
  { re: /\bORDER\s+BY\b/gi,   clause: 'order' },
  { re: /\bGROUP\s+BY\b/gi,   clause: 'group' },
  { re: /\bHAVING\b/gi,       clause: 'having' },
  { re: /\bWHERE\b/gi,        clause: 'where' },
  { re: /\bON\b/gi,           clause: 'on' },
  { re: /\bSET\b/gi,          clause: 'set' },
  { re: /\bVALUES\b/gi,       clause: 'values' },
  { re: /\bINTO\b/gi,         clause: 'into' },
  // Joins — specific variants
  { re: /\b(?:LEFT|RIGHT|INNER|OUTER|CROSS)\s+(?:OUTER\s+)?JOIN\b/gi, clause: 'join' },
  { re: /\bJOIN\b/gi,         clause: 'join' },
  { re: /\bFROM\b/gi,         clause: 'from' },
  { re: /\bUPDATE\b/gi,       clause: 'update' },
  { re: /\bSELECT\b/gi,       clause: 'select' },
];

/** Find the clause immediately preceding the cursor. */
export function detectClause(statement: string, cursorInStatement: number): SqlClause {
  const head = statement.slice(0, cursorInStatement);
  let best: { index: number; clause: SqlClause } | null = null;
  for (const entry of CLAUSE_KEYWORDS) {
    entry.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entry.re.exec(head)) !== null) {
      if (!best || m.index > best.index) {
        best = { index: m.index, clause: entry.clause };
      }
    }
  }
  return best?.clause ?? 'unknown';
}

/** Grab the identifier fragment immediately before the cursor. */
export function extractPrefix(statement: string, cursorInStatement: number): {
  prefix: string;
  qualifier?: string;
  quoted: boolean;
} {
  const head = statement.slice(0, cursorInStatement);

  // Unclosed backtick? Count backticks in the head; odd → inside quotes.
  const backticks = (head.match(/`/g) ?? []).length;
  const quoted = backticks % 2 === 1;

  // Walk back from the cursor collecting identifier chars.
  let i = cursorInStatement - 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(statement[i])) i--;
  const prefix = statement.slice(i + 1, cursorInStatement);

  // Trailing `.`? Back up one more identifier to find the qualifier.
  if (i >= 0 && statement[i] === '.') {
    let j = i - 1;
    // allow backtick-wrapped qualifiers: users.`email`
    if (j >= 0 && statement[j] === '`') {
      const close = j;
      let k = close - 1;
      while (k >= 0 && statement[k] !== '`') k--;
      if (k >= 0) {
        return { prefix, qualifier: statement.slice(k + 1, close), quoted };
      }
    }
    while (j >= 0 && /[A-Za-z0-9_]/.test(statement[j])) j--;
    const qualifier = statement.slice(j + 1, i);
    return { prefix, qualifier: qualifier || undefined, quoted };
  }

  return { prefix, quoted };
}

/** Top-level entry point — builds the complete context from buffer + cursor. */
export function analyzeContext(buffer: string, cursorOffset: number): SqlContext {
  const { text: statement, cursorInStatement } = locateStatement(buffer, cursorOffset);
  const clause = detectClause(statement, cursorInStatement);
  const referencedTables = extractReferencedTables(statement);
  const { prefix, qualifier, quoted } = extractPrefix(statement, cursorInStatement);
  return { clause, referencedTables, prefix, qualifier, quoted, statement, cursorInStatement };
}
