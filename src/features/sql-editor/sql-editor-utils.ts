import { getMonacoThemeId } from '../../lib/monaco-setup';

export function pickMonacoTheme(): string {
  return getMonacoThemeId(document.documentElement.dataset.theme ?? 'monokai');
}

/** Format elapsed run time: ms under a second, then seconds with one decimal. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Platform-aware modifier glyph for shortcut badges. macOS shows ⌘; everything
// else shows Ctrl. Computed once at module load.
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';
export const RUN_SHORTCUT = `${MOD_KEY}↵`;
export const RUN_ALL_SHORTCUT = IS_MAC ? '⌘⇧↵' : 'Ctrl+Shift+↵';

/** Split a multi-statement SQL string on `;` respecting quotes and comments. */
export function splitSqlStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') { current += '/'; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && sql[i - 1] !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && sql[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (inBack) {
      current += ch;
      if (ch === '`') inBack = false;
      continue;
    }

    if (ch === '-' && next === '-') { inLineComment = true; current += ch; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; current += ch; current += '/'; i++; continue; }
    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }
    if (ch === '`') { inBack = true; current += ch; continue; }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

export function statementAtCursor(source: string, cursorOffset: number): string {
  const chars = Array.from(source);
  let start = 0;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  let activeStart = 0;
  let activeEnd = chars.length;

  const markSegment = (endExclusive: number) => {
    if (cursorOffset >= start && cursorOffset <= endExclusive) {
      activeStart = start;
      activeEnd = endExclusive;
    }
    start = endExclusive + 1;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;

    if (ch === ';' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      markSegment(i);
    }
  }
  if (start <= chars.length) {
    if (cursorOffset >= start && cursorOffset <= chars.length) {
      activeStart = start;
      activeEnd = chars.length;
    }
  }
  return chars.slice(activeStart, activeEnd).join('').trim();
}

export function stripCodeComments(source: string, language: string, commentTags?: string[]): string {
  const fallbackLineTokens = (() => {
    const lang = language.toLowerCase();
    if (lang === 'mongo') return ['//'];
    if (lang === 'shell') return ['#'];
    // SQL-ish (sql/pgsql/...)
    return ['--', '#'];
  })();
  const fallbackBlockPairs: Array<[string, string]> = [['/*', '*/']];
  const configured = (commentTags ?? []).map(t => t.trim()).filter(Boolean);
  const lineTokens = configured
    .filter(t => !t.includes(' '))
    .filter((t, idx, arr) => arr.indexOf(t) === idx);
  const blockPairs = configured
    .filter(t => t.includes(' '))
    .map((t) => {
      const parts = t.split(/\s+/).filter(Boolean);
      return parts.length >= 2 ? [parts[0], parts[1]] as [string, string] : null;
    })
    .filter((v): v is [string, string] => !!v);
  const effectiveLineTokens = lineTokens.length > 0 ? lineTokens : fallbackLineTokens;
  const effectiveBlockPairs = blockPairs.length > 0 ? blockPairs : fallbackBlockPairs;

  const chars = Array.from(source);
  let i = 0;
  let out = '';
  let quote: '\'' | '"' | '`' | null = null;
  let inBlock: [string, string] | null = null;
  let escaped = false;

  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1] ?? '';

    if (inBlock) {
      const [, blockEnd] = inBlock;
      const endChars = Array.from(blockEnd);
      let blockClosed = true;
      for (let k = 0; k < endChars.length; k++) {
        if ((chars[i + k] ?? '') !== endChars[k]) {
          blockClosed = false;
          break;
        }
      }
      if (blockClosed) {
        inBlock = null;
        i += blockEnd.length;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }

    if (quote) {
      out += ch;
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i += 1;
        continue;
      }
      // SQL single-quote escape: '' inside single-quoted string.
      if (quote === '\'' && ch === '\'' && next === '\'') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    let blockCommentMatched = false;
    for (const pair of effectiveBlockPairs) {
      const [blockStart] = pair;
      const startChars = Array.from(blockStart);
      let matches = true;
      for (let k = 0; k < startChars.length; k++) {
        if ((chars[i + k] ?? '') !== startChars[k]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      inBlock = pair;
      i += blockStart.length;
      blockCommentMatched = true;
      break;
    }
    if (blockCommentMatched) continue;

    let lineCommentMatched = false;
    for (const tok of effectiveLineTokens) {
      const a = tok[0];
      const b = tok[1] ?? '';
      if (ch !== a) continue;
      if (b && next !== b) continue;
      // For `--`, mimic SQL behavior: treat as comment only when followed by
      // whitespace (or EOL), so arithmetic like `a--b` is left untouched.
      if (tok === '--') {
        const after = chars[i + 2] ?? '';
        if (after && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r') {
          continue;
        }
      }
      const skip = tok.length;
      i += skip;
      while (i < chars.length && chars[i] !== '\n') i += 1;
      if (i < chars.length && chars[i] === '\n') {
        out += '\n';
        i += 1;
      }
      lineCommentMatched = true;
      break;
    }
    if (lineCommentMatched) continue;

    out += ch;
    i += 1;
  }

  return out;
}
