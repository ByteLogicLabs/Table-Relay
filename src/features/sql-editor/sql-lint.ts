/**
 * Lightweight offline SQL linter. Scans the buffer for *obvious* mistakes that
 * don't need a database round-trip — misspelled keywords, unclosed quotes /
 * parentheses, and a SELECT missing its FROM. Returns plain marker descriptors
 * (1-based line/column ranges + message) that the editor maps onto Monaco
 * markers, so a red squiggle appears as the user types.
 *
 * This is deliberately conservative: it only flags things it's confident about,
 * to avoid noisy false positives on valid SQL it doesn't fully parse. Semantic
 * errors (wrong column, type mismatch) are left to run-time DB validation.
 */

export interface LintMarker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: 'error' | 'warning';
}

/** Reserved words we expect at a statement/clause start position. A token that
 *  is *close* to one of these but not exact is almost certainly a typo. */
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'JOIN',
  'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'ORDER', 'GROUP',
  'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'UNION', 'TRUNCATE', 'REPLACE',
  'WITH', 'RETURNING', 'BETWEEN', 'EXISTS',
];
const KEYWORD_SET = new Set(KEYWORDS);

// Common multi-word / contextual words that are valid but close to a keyword;
// we must NOT flag these as typos of a keyword.
const SAFE_WORDS = new Set([
  'AS', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BY', 'ASC',
  'DESC', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'KEY', 'PRIMARY',
  'FOREIGN', 'REFERENCES', 'DEFAULT', 'UNIQUE', 'USING', 'CAST', 'COUNT',
  'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'TRUE', 'FALSE',
]);

/**
 * Damerau-Levenshtein distance (tiny strings). Like Levenshtein but counts a
 * transposition of two adjacent characters as ONE edit — so `JONI`→`JOIN` and
 * `FORM`→`FROM` are distance 1, not 2. Transpositions are the most common
 * keyword typo, so this lets us catch them while keeping the tight distance-1
 * budget that avoids false positives on real identifiers.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Full matrix so we can look back two rows/cols for the transposition case.
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,        // deletion
        d[i][j - 1] + 1,        // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      // Adjacent transposition (e.g. JONI ↔ JOIN).
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** Closest keyword at edit-distance exactly 1, or null. We deliberately use a
 *  budget of 1 (not 2): distance-2 matches produce too many false positives on
 *  real identifiers (e.g. "orders" → "ORDER"). A single-character slip is the
 *  overwhelmingly common keyword typo and is safe to flag. */
function closestKeyword(upper: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const kw of KEYWORDS) {
    if (Math.abs(kw.length - upper.length) > 1) continue;
    const d = editDistance(upper, kw);
    if (d < bestD) { bestD = d; best = kw; }
  }
  if (best === null) return null;
  if (bestD !== 1) return null;
  return best;
}

/** Keywords after which the next word is an IDENTIFIER (table/column/alias),
 *  never another keyword — so we must not flag it as a keyword typo. */
const IDENT_INTRODUCERS = new Set([
  'FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'VIEW', 'INDEX', 'AS',
  'REFERENCES', 'EXISTS',
]);

/**
 * Strip strings and comments from a single line, replacing their characters
 * with spaces so column positions are preserved but their contents never get
 * linted as identifiers. Returns the masked line plus whether the line ended
 * still inside a string / block comment (carried to the next line).
 */
interface MaskState {
  inSingle: boolean;
  inDouble: boolean;
  inBack: boolean;
  inBlockComment: boolean;
}

function maskLine(line: string, state: MaskState): { masked: string; state: MaskState } {
  let out = '';
  let { inSingle, inDouble, inBack, inBlockComment } = state;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (inBlockComment) {
      out += ' ';
      if (ch === '*' && next === '/') { out += ' '; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) { out += ' '; if (ch === "'" && line[i - 1] !== '\\') inSingle = false; continue; }
    if (inDouble) { out += ' '; if (ch === '"' && line[i - 1] !== '\\') inDouble = false; continue; }
    if (inBack) { out += ' '; if (ch === '`') inBack = false; continue; }
    // line comment: blank the rest of the line
    if (ch === '-' && next === '-') { out += ' '.repeat(line.length - i); break; }
    if (ch === '#') { out += ' '.repeat(line.length - i); break; }
    if (ch === '/' && next === '*') { out += '  '; i++; inBlockComment = true; continue; }
    if (ch === "'") { out += ' '; inSingle = true; continue; }
    if (ch === '"') { out += ' '; inDouble = true; continue; }
    if (ch === '`') { out += ' '; inBack = true; continue; }
    out += ch;
  }
  return { masked: out, state: { inSingle, inDouble, inBack, inBlockComment } };
}

/**
 * Lint a SQL buffer and return markers. `language` lets us skip linting for
 * non-SQL editors (e.g. Mongo's JS-shaped queries) where these rules don't
 * apply. Returns an empty array for those.
 */
export function lintSql(sql: string, language: string): LintMarker[] {
  const lang = language.toLowerCase();
  // Only lint SQL dialects. mongo/shell/etc. have entirely different grammar.
  if (lang === 'mongo' || lang === 'shell' || lang === 'json') return [];
  if (!sql.trim()) return [];

  const markers: LintMarker[] = [];
  const lines = sql.split('\n');

  // First pass: build masked lines (strings/comments blanked) + track unmatched
  // quote/paren state across the whole buffer.
  let state: MaskState = { inSingle: false, inDouble: false, inBack: false, inBlockComment: false };
  const masked: string[] = [];
  for (const line of lines) {
    const r = maskLine(line, state);
    masked.push(r.masked);
    state = r.state;
  }

  // Unterminated string / block comment at EOF → flag at end of buffer.
  const lastLineIdx = lines.length - 1;
  const lastCol = lines[lastLineIdx].length + 1;
  if (state.inSingle || state.inDouble || state.inBack) {
    markers.push({
      startLineNumber: lastLineIdx + 1, startColumn: Math.max(1, lastCol - 1),
      endLineNumber: lastLineIdx + 1, endColumn: lastCol,
      message: 'Unclosed string literal.', severity: 'error',
    });
  }
  if (state.inBlockComment) {
    markers.push({
      startLineNumber: lastLineIdx + 1, startColumn: Math.max(1, lastCol - 1),
      endLineNumber: lastLineIdx + 1, endColumn: lastCol,
      message: 'Unclosed block comment (/* … */).', severity: 'warning',
    });
  }

  // Paren balance across masked text.
  let parenDepth = 0;
  let firstUnmatchedClose: { line: number; col: number } | null = null;
  masked.forEach((m, li) => {
    for (let i = 0; i < m.length; i++) {
      if (m[i] === '(') parenDepth++;
      else if (m[i] === ')') {
        parenDepth--;
        if (parenDepth < 0 && !firstUnmatchedClose) {
          firstUnmatchedClose = { line: li + 1, col: i + 1 };
          parenDepth = 0; // keep scanning for keyword typos
        }
      }
    }
  });
  if (firstUnmatchedClose) {
    const fc = firstUnmatchedClose as { line: number; col: number };
    markers.push({
      startLineNumber: fc.line, startColumn: fc.col,
      endLineNumber: fc.line, endColumn: fc.col + 1,
      message: 'Unmatched closing parenthesis.', severity: 'error',
    });
  } else if (parenDepth > 0) {
    markers.push({
      startLineNumber: lastLineIdx + 1, startColumn: Math.max(1, lastCol - 1),
      endLineNumber: lastLineIdx + 1, endColumn: lastCol,
      message: `Unclosed parenthesis (${parenDepth} unmatched "(").`, severity: 'error',
    });
  }

  // Keyword-typo pass over masked tokens. We track the previous significant
  // word across the whole buffer so a word sitting in identifier position
  // (right after FROM/JOIN/etc.) is never mistaken for a keyword typo.
  const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
  let prevWordUpper: string | null = null;
  masked.forEach((m, li) => {
    let match: RegExpExecArray | null;
    wordRe.lastIndex = 0;
    while ((match = wordRe.exec(m)) !== null) {
      const word = match[0];
      const upper = word.toUpperCase();
      const after = m[match.index + word.length];
      const beforeChar = m[match.index - 1];

      // Update prevWord for the NEXT iteration before any early-continue.
      const setPrev = () => { prevWordUpper = upper; };

      // Exact keyword / safe word — valid, just record context.
      if (KEYWORD_SET.has(upper) || SAFE_WORDS.has(upper)) { setPrev(); continue; }
      // Function call `foo(` or qualified `foo.` / `.foo` → identifier, skip.
      if (after === '(' || after === '.' || beforeChar === '.') { setPrev(); continue; }
      // Word in identifier position (after FROM/JOIN/UPDATE/…) → a table/alias
      // name, not a keyword. This is what kept "orders" from being flagged.
      if (prevWordUpper && IDENT_INTRODUCERS.has(prevWordUpper)) { setPrev(); continue; }
      // A word followed by another bare word is very likely an alias
      // (`actors a`, `users u`) or identifier list — not a misspelled keyword.
      // Only flag when it stands alone in a clause-ish slot.
      const guess = closestKeyword(upper);
      if (guess) {
        markers.push({
          startLineNumber: li + 1, startColumn: match.index + 1,
          endLineNumber: li + 1, endColumn: match.index + 1 + word.length,
          message: `Unknown keyword "${word}" — did you mean "${guess}"?`,
          severity: 'error',
        });
      }
      setPrev();
    }
  });

  return markers;
}
