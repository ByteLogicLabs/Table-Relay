// Lightweight analyzer for Mongo shell expressions in the query editor.
// Mirrors `analyze-select.ts` for the SQL side: decides whether the active
// statement's results map back to a single collection so the user can edit
// cells in place. The bar is intentionally narrow:
//
//   db.<coll>.find(...)
//   db.getCollection("<coll>").find(...)
//   db.getSiblingDB("<db>").<coll>.find(...)
//   db.getSiblingDB("<db>").getCollection("<coll>").find(...)
//   (with optional .limit(N) / .skip(N) / .sort({...}) tails, in any order)
//   db.<coll>           — bare collection ref (the adapter defaults this to find)
//
// Anything else — aggregate, distinct, mapReduce, runCommand, multiple
// statements, etc. — is rejected. The result row identity is `_id`, which
// `find()` always returns unless the user wrote a projection that excludes
// it (we don't try to detect that here; if `_id` is missing from the result
// columns the SQL-editor side falls back to "missing primary-key column").

export type MongoAnalysis =
  | {
      editable: true;
      schema: string | null;   // database name from getSiblingDB(...) or null
      collection: string;
    }
  | {
      editable: false;
      reason: string;
    };

function stripJsLineComments(s: string): string {
  return s.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// Strip a single quoted-string call argument: getCollection("users") → "users".
// Returns the unquoted argument and the rest of the string after the closing
// paren, or null if the shape doesn't match.
function parseQuotedCall(s: string, fnName: string): { arg: string; rest: string } | null {
  if (!s.startsWith(fnName + '(')) return null;
  let i = fnName.length + 1;
  // Skip leading whitespace.
  while (i < s.length && /\s/.test(s[i])) i++;
  const quote = s[i];
  if (quote !== '"' && quote !== "'") return null;
  i++;
  let arg = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      arg += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) break;
    arg += ch;
    i++;
  }
  if (s[i] !== quote) return null;
  i++;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== ')') return null;
  i++;
  return { arg, rest: s.slice(i) };
}

// Pull a bare identifier off the front: `users.find(...)` → ('users', '.find(...)').
function parseBareIdent(s: string): { ident: string; rest: string } | null {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(s);
  if (!m) return null;
  return { ident: m[1], rest: s.slice(m[0].length) };
}

// Skip a balanced parenthesised expression starting at index 0. Returns the
// length consumed (including the parens) or -1 if unbalanced. Honors quoted
// strings so `"(" → ")"` literal sequences don't confuse depth tracking.
function skipBalancedParens(s: string): number {
  if (s[0] !== '(') return -1;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inDouble && !inBack && ch === "'" && s[i - 1] !== '\\') inSingle = !inSingle;
    else if (!inSingle && !inBack && ch === '"' && s[i - 1] !== '\\') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === '`') inBack = !inBack;
    else if (!inSingle && !inDouble && !inBack) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
  }
  return -1;
}

// After we've consumed `db.[getSiblingDB(...)?.]<coll>.find(...)`, the only
// allowed trailing chain is .limit(N) / .skip(N) / .sort({...}) in any order.
// Anything else (.toArray, .pretty, .count, .aggregate fallback, .map, ...)
// blocks editing.
const ALLOWED_TAIL_METHODS = new Set(['limit', 'skip', 'sort']);

function validateTail(tail: string): string | null {
  let t = tail.trim();
  // The adapter accepts a trailing semicolon — strip it before walking.
  if (t.endsWith(';')) t = t.slice(0, -1).trim();
  while (t.length > 0) {
    if (!t.startsWith('.')) return `Unexpected trailing token: ${t.slice(0, 30)}`;
    t = t.slice(1);
    const idMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(t);
    if (!idMatch) return `Unexpected trailing token: ${t.slice(0, 30)}`;
    const method = idMatch[1];
    t = t.slice(method.length).trimStart();
    if (!t.startsWith('(')) return `Trailing chain method "${method}" needs ()`;
    const consumed = skipBalancedParens(t);
    if (consumed === -1) return 'Unbalanced parentheses in trailing chain';
    if (!ALLOWED_TAIL_METHODS.has(method)) {
      return `Editing not supported when query uses .${method}()`;
    }
    t = t.slice(consumed).trimStart();
    // Allow a trailing semicolon after the final call.
    if (t === ';') t = '';
  }
  return null;
}

export function analyzeMongoFind(rawSrc: string): MongoAnalysis {
  if (!rawSrc || rawSrc.trim().length === 0) {
    return { editable: false, reason: 'No statement to edit.' };
  }
  let s = stripJsLineComments(rawSrc).trim();
  if (s.endsWith(';')) s = s.slice(0, -1).trim();
  if (s.length === 0) return { editable: false, reason: 'No statement to edit.' };
  // Reject obvious multi-statement (`;` not at the end). The adapter tolerates
  // multiple statements, but we can only edit results from the *active* one,
  // and from this side we don't know which ran last.
  if (s.slice(0, -1).includes(';')) {
    return { editable: false, reason: 'Editing not supported for multi-statement scripts.' };
  }
  if (!s.startsWith('db.')) {
    return { editable: false, reason: 'Only `db.<collection>.find(...)` results are editable.' };
  }
  let rest = s.slice(3);

  // Optional getSiblingDB("name").
  let schema: string | null = null;
  if (rest.startsWith('getSiblingDB(')) {
    const parsed = parseQuotedCall(rest, 'getSiblingDB');
    if (!parsed) return { editable: false, reason: 'Could not parse getSiblingDB(...) — needs a single quoted name.' };
    schema = parsed.arg;
    rest = parsed.rest;
    if (!rest.startsWith('.')) return { editable: false, reason: 'Expected `.` after getSiblingDB(...).' };
    rest = rest.slice(1);
  }

  // Collection: getCollection("name") OR bare identifier.
  let collection: string;
  if (rest.startsWith('getCollection(')) {
    const parsed = parseQuotedCall(rest, 'getCollection');
    if (!parsed) return { editable: false, reason: 'Could not parse getCollection(...) — needs a single quoted name.' };
    collection = parsed.arg;
    rest = parsed.rest;
  } else {
    const parsed = parseBareIdent(rest);
    if (!parsed) return { editable: false, reason: 'Expected a collection name after `db.`.' };
    collection = parsed.ident;
    rest = parsed.rest;
  }

  // Bare collection ref (no method) — the adapter defaults to find({}).
  if (rest.trim().length === 0) {
    return { editable: true, schema, collection };
  }

  if (!rest.startsWith('.')) return { editable: false, reason: 'Expected `.find(...)` after the collection.' };
  rest = rest.slice(1);

  // The first method call MUST be find(). Any other op (aggregate,
  // findOne, distinct, …) means the result either isn't tabular or
  // doesn't map row-for-row to documents.
  const opMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest);
  if (!opMatch) return { editable: false, reason: 'Expected a method call after the collection.' };
  const op = opMatch[1];
  if (op !== 'find') {
    return { editable: false, reason: `Editing not supported for .${op}() — only .find() results are editable.` };
  }
  rest = rest.slice(op.length).trimStart();
  if (!rest.startsWith('(')) return { editable: false, reason: '.find needs ()' };
  const consumed = skipBalancedParens(rest);
  if (consumed === -1) return { editable: false, reason: 'Unbalanced parentheses in find(...)' };
  rest = rest.slice(consumed);

  const tailErr = validateTail(rest);
  if (tailErr) return { editable: false, reason: tailErr };
  return { editable: true, schema, collection };
}
