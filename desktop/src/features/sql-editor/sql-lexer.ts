// Dialect-aware SQL lexing shared by the query editor's comment stripping and
// auto-paging. The backend row cap (src-tauri/adapter-api/src/query_cap.rs)
// implements the same rules in Rust — keep the two in sync.

import type { SqlDialect } from '../../lib/db';

/** Lexical rules that differ between dialects. Getting these wrong shifts what
 *  counts as code — e.g. treating Postgres' `#>` JSON operator as a MySQL `#`
 *  comment hides a real LIMIT that follows it on the same line. */
export interface LexRules {
  /** `--` only starts a comment when followed by whitespace (MySQL), so `5--3` stays arithmetic. */
  dashCommentNeedsSpace: boolean;
  /** A bare `\r` ends a line comment too (Postgres); elsewhere only `\n` does. */
  crEndsLineComment: boolean;
  /** `# …` line comments (MySQL). */
  hashComment: boolean;
  /** Backslash escapes inside `'…'` / `"…"` (MySQL default sql_mode). */
  backslashEscapes: boolean;
  /** `E'…'` strings with backslash escapes (Postgres). */
  eStrings: boolean;
  /** `` `…` `` quoted identifiers (MySQL, SQLite). */
  backticks: boolean;
  /** `[…]` quoted identifiers (SQLite). */
  brackets: boolean;
  /** `$tag$ … $tag$` strings (Postgres). */
  dollarQuotes: boolean;
  /** `/* /* *\/ *\/` nests (Postgres). */
  nestedBlockComments: boolean;
  /** `/*! … *\/` and `/*M! … *\/` bodies are executed as SQL (MySQL/MariaDB). */
  executableComments: boolean;
}

export function lexRules(dialect: SqlDialect): LexRules {
  const ansi: LexRules = {
    dashCommentNeedsSpace: false,
    crEndsLineComment: false,
    hashComment: false,
    backslashEscapes: false,
    eStrings: false,
    backticks: false,
    brackets: false,
    dollarQuotes: false,
    nestedBlockComments: false,
    executableComments: false,
  };
  switch (dialect) {
    case 'mysql':
      return { ...ansi, hashComment: true, dashCommentNeedsSpace: true, backslashEscapes: true, backticks: true, executableComments: true };
    case 'postgres':
      return { ...ansi, crEndsLineComment: true, eStrings: true, dollarQuotes: true, nestedBlockComments: true };
    case 'sqlite':
      return { ...ansi, backticks: true, brackets: true };
    default:
      return { ...ansi, backticks: true };
  }
}

/**
 * A stretch of SQL that isn't plain code; everything between spans is code.
 *   - `literal`: string literal or quoted identifier
 *   - `comment`: line or block comment
 *   - `hint`: `/*+ … *\/` optimizer hint — a comment the server still reads
 *   - `exec-open` / `exec-close`: the `/*!12345` and `*\/` around a MySQL
 *     executable comment, whose body is scanned as code
 */
export interface SqlSpan {
  kind: 'literal' | 'comment' | 'hint' | 'exec-open' | 'exec-close';
  start: number;
  end: number;
}

/** Whitespace as the SQL lexers see it — the same set as the backend's
 *  `is_sql_space`, so both sides trim identically. Non-ASCII spaces count as
 *  word characters on both sides. */
export function isSqlSpace(ch: string | undefined): boolean {
  return ch !== undefined && /[ \t\n\r\f\v]/.test(ch);
}

/** Characters that can continue an unquoted identifier or keyword. */
export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && (/[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

/** Split `sql` into non-code spans (in order) using `rules`. */
export function scanSql(sql: string, rules: LexRules): SqlSpan[] {
  const len = sql.length;
  const spans: SqlSpan[] = [];
  let inExecutableComment = false;
  let i = 0;
  const push = (kind: SqlSpan['kind'], end: number) => {
    spans.push({ kind, start: i, end });
    i = end;
  };

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    const dashComment = ch === '-' && next === '-'
      && (!rules.dashCommentNeedsSpace || i + 2 >= len || sql.charCodeAt(i + 2) <= 32);
    if (dashComment || (ch === '#' && rules.hashComment)) {
      let end = i;
      while (end < len && sql[end] !== '\n' && !(rules.crEndsLineComment && sql[end] === '\r')) end++;
      push('comment', end);
      continue;
    }

    if (ch === '/' && next === '*') {
      const marker = sql[i + 2] === '!' ? 3 : sql[i + 2] === 'M' && sql[i + 3] === '!' ? 4 : 0;
      if (marker && rules.executableComments) {
        let end = i + marker;
        while (end < len && /[0-9]/.test(sql[end])) end++;
        push('exec-open', end);
        inExecutableComment = true;
        continue;
      }

      const kind = sql[i + 2] === '+' ? 'hint' : 'comment';
      let depth = 1;
      let j = i + 2;
      while (j < len && depth > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else if (rules.nestedBlockComments && sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else j++;
      }
      push(kind, j);
      continue;
    }

    if (inExecutableComment && ch === '*' && next === '/') {
      push('exec-close', i + 2);
      inExecutableComment = false;
      continue;
    }

    if (ch === "'" || ch === '"' || (ch === '`' && rules.backticks)) {
      const eString = ch === "'" && rules.eStrings && /[eE]/.test(sql[i - 1] ?? '') && !isWordChar(sql[i - 2]);
      const backslash = (rules.backslashEscapes && ch !== '`') || eString;
      push('literal', scanQuoted(sql, i, ch, backslash));
      continue;
    }

    if (ch === '[' && rules.brackets) {
      const close = sql.indexOf(']', i);
      push('literal', close === -1 ? len : close + 1);
      continue;
    }

    // `$tag$` opens a dollar quote unless the `$` continues an identifier
    // (`a$b`). Tags can't start with a digit, so `$1` stays a parameter.
    if (ch === '$' && rules.dollarQuotes && !isWordChar(sql[i - 1])) {
      let j = i + 1;
      if (isWordChar(sql[j]) && !/[0-9$]/.test(sql[j])) {
        while (j < len && isWordChar(sql[j]) && sql[j] !== '$') j++;
      }
      if (sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        push('literal', close === -1 ? len : close + tag.length);
        continue;
      }
    }

    i++;
  }
  return spans;
}

/** Index just past the closing quote of the literal opening at `start`, or the
 *  end of input when it's unterminated. A doubled quote is an escaped quote. */
function scanQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslashEscapes && ch === '\\') { j += 2; continue; }
    if (ch === quote) {
      if (sql[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

/** Fill for masked literals / quoted identifiers: significant (so a trailing
 *  literal isn't trimmed off) but never part of a word, a paren, or a `;`. */
const LITERAL_FILL = "'";
/** Fill for masked comments: insignificant, exactly like whitespace. */
const COMMENT_FILL = ' ';

/**
 * Replace string literals and quoted identifiers with LITERAL_FILL, comments
 * (and the `/*!12345` executable-comment opener) with COMMENT_FILL, and
 * upper-case the rest. The result has exactly the same length as the input,
 * so indices into it are indices into `sql`.
 */
export function maskLiteralsAndComments(sql: string, dialect: SqlDialect, rules: LexRules = lexRules(dialect)): string {
  let out = '';
  let pos = 0;
  for (const span of scanSql(sql, rules)) {
    // The `*/` closing an executable comment stays visible, so a statement cut
    // after its last significant token keeps it: `/*!50000 SELECT 1 */` must
    // not be cut to an unterminated `/*!50000 SELECT 1`.
    if (span.kind === 'exec-close') continue;
    out += upperAscii(sql.slice(pos, span.start));
    out += (span.kind === 'literal' ? LITERAL_FILL : COMMENT_FILL).repeat(span.end - span.start);
    pos = span.end;
  }
  return out + upperAscii(sql.slice(pos));
}

// ASCII only: some non-ASCII letters change length when upper-cased (ß → SS).
function upperAscii(s: string): string {
  return s.replace(/[a-z]+/g, (m) => m.toUpperCase());
}

export interface SqlWord {
  text: string;
  depth: number;
}

/** Split masked SQL into words, tagging each with its paren depth. */
export function tokenize(masked: string): SqlWord[] {
  const words: SqlWord[] = [];
  let depth = 0;
  let i = 0;
  while (i < masked.length) {
    const ch = masked[i];
    if (isWordChar(ch)) {
      const start = i;
      while (i < masked.length && isWordChar(masked[i])) i++;
      words.push({ text: masked.slice(start, i), depth });
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    i++;
  }
  return words;
}

/** Statement verbs that can follow a `WITH …` clause list. */
const WITH_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE']);

/**
 * Index of the statement's verb in `words`: the first word, or for `WITH …`
 * the verb after the CTE list (`WITH x AS (…) DELETE FROM t` → `DELETE`).
 * -1 when there is none.
 */
export function mainVerbIndex(words: SqlWord[]): number {
  const first = words[0];
  if (!first) return -1;
  if (first.text !== 'WITH') return 0;
  return words.findIndex((w, i) => i > 0 && w.depth === first.depth && WITH_VERBS.has(w.text));
}

/**
 * One statement of a batch: its text is `sql.slice(start, end)`, and `next` is
 * where the following statement starts (just past the delimiter).
 */
export interface StatementRange {
  start: number;
  end: number;
  next: number;
}

/**
 * Split a batch into statement ranges at top-level delimiters, the way the
 * backend's `split_sql_statements` does: a `;` inside a string, quoted
 * identifier, comment or dollar quote never splits; MySQL client
 * `DELIMITER xx` lines switch the delimiter (and belong to no range); a `;`
 * inside a SQLite `CREATE TRIGGER … BEGIN … END` body doesn't split. Ranges
 * holding only whitespace or comments are included — callers decide.
 */
export function splitStatementRanges(sql: string, dialect: SqlDialect, rules: LexRules = lexRules(dialect)): StatementRange[] {
  const masked = maskLiteralsAndComments(sql, dialect, rules);
  const len = masked.length;
  const ranges: StatementRange[] = [];
  let delimiter = ';';
  let start = 0;
  // Statement state since `start`.
  let hasCode = false;
  let head: string[] = [];
  let inTrigger = false;
  let blockDepth = 0;

  let i = 0;
  while (i < len) {
    if (dialect === 'mysql' && !hasCode && (i === 0 || masked[i - 1] === '\n')) {
      const nl = masked.indexOf('\n', i);
      const lineEnd = nl === -1 ? len : nl;
      const command = /^[ \t\r\f\v]*DELIMITER(?=[ \t\r\f\v]|$)/.exec(masked.slice(i, lineEnd));
      if (command) {
        const token = sql.slice(i + command[0].length, lineEnd).trim().split(/[ \t\r\f\v]+/)[0];
        if (token) delimiter = token.toUpperCase();
        i = start = Math.min(lineEnd + 1, len);
        continue;
      }
    }

    if (!(inTrigger && blockDepth > 0) && masked.startsWith(delimiter, i)) {
      ranges.push({ start, end: i, next: i + delimiter.length });
      i = start = i + delimiter.length;
      hasCode = false;
      head = [];
      inTrigger = false;
      blockDepth = 0;
      continue;
    }

    const ch = masked[i];
    if (isWordChar(ch)) {
      const wordStart = i;
      // A word-like delimiter can follow a word with no space: `END$$`.
      while (i < len && isWordChar(masked[i]) && (i === wordStart || !masked.startsWith(delimiter, i))) i++;
      hasCode = true;
      if (dialect === 'sqlite') {
        const word = masked.slice(wordStart, i);
        if (head.length < 3) {
          head.push(word);
          inTrigger = head[0] === 'CREATE'
            && (head[1] === 'TRIGGER' || ((head[1] === 'TEMP' || head[1] === 'TEMPORARY') && head[2] === 'TRIGGER'));
        }
        if (inTrigger) {
          if (word === 'BEGIN' || word === 'CASE') blockDepth++;
          else if (word === 'END') blockDepth = Math.max(0, blockDepth - 1);
        }
      }
      continue;
    }
    if (!isSqlSpace(ch)) hasCode = true;
    i++;
  }
  ranges.push({ start, end: len, next: len });
  return ranges;
}

/**
 * Remove comments from SQL, keeping what the server still reads: optimizer
 * hints (`/*+ … *\/`) and MySQL executable comments (`/*! … *\/`). Line
 * breaks inside removed comments are kept so line numbers in server errors
 * still match the editor; a block comment on one line becomes a single space
 * so `a/*x*\/b` doesn't fuse into `ab`.
 */
export function stripSqlComments(sql: string, rules: LexRules): string {
  let out = '';
  let pos = 0;
  for (const span of scanSql(sql, rules)) {
    if (span.kind !== 'comment') continue;
    out += sql.slice(pos, span.start);
    const body = sql.slice(span.start, span.end);
    const isBlock = body.startsWith('/*');
    out += isBlock ? (body.replace(/[^\n]/g, '') || ' ') : '';
    pos = span.end;
  }
  return out + sql.slice(pos);
}

/**
 * The SQL as the server parses it, for checks that read statement text (the
 * destructive-statement warning, "is there anything left to run?"). Hints are
 * blanked like any other comment, so `/*+ x *\/ DELETE FROM t` still reads as
 * a DELETE, and MySQL executable-comment wrappers are removed so their bodies
 * read as plain statements. Literals and line breaks are kept. Non-SQL stores
 * (`none`) are returned unchanged.
 */
export function codeForChecks(sql: string, dialect: SqlDialect): string {
  if (dialect === 'none') return sql;
  let out = '';
  let pos = 0;
  for (const span of scanSql(sql, lexRules(dialect))) {
    if (span.kind === 'literal') continue;
    out += sql.slice(pos, span.start);
    out += sql.slice(span.start, span.end).replace(/[^\n]/g, '') || ' ';
    pos = span.end;
  }
  return out + sql.slice(pos);
}
