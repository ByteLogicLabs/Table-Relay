// Shared editor primitives used by the data grid AND the SQL editor's
// editable-result feature. Keep this file free of React — pure types and
// utilities only — so it imports cheaply from anywhere.

export type EditorKind =
  | { kind: 'text' }
  | { kind: 'number'; integer: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  | { kind: 'set'; options: string[] }
  | { kind: 'date' }
  | { kind: 'datetime' }
  | { kind: 'time' }
  | { kind: 'json' };

// SQL dialects the editor primitives know about. `none` is the signal
// for non-SQL stores (Mongo, Redis); the data-grid still treats it as
// "ANSI-quoting safe fallback" if SQL has to be emitted, but SQL editors
// should be hidden upstream by checking the manifest's sql_dialect.
export type Dialect = 'mysql' | 'postgres' | 'sqlite' | 'generic' | 'none';

import type { Capabilities } from '../../lib/db';

/** Pull the SQL dialect from a resolved adapter manifest's capabilities.
 *  No more per-driver-name switch — adapters declare this in their toml. */
export function dialectFromManifest(caps: Capabilities | undefined | null): Dialect {
  if (!caps) return 'generic';
  switch (caps.sqlDialect) {
    case 'mysql': return 'mysql';
    case 'postgres': return 'postgres';
    case 'sqlite': return 'sqlite';
    case 'generic': return 'generic';
    case 'none': return 'none';
    default: return 'generic';
  }
}

// Column names that almost always represent a boolean flag regardless of
// their declared SQL width. Lowercase — compared against the lowercase name.
const BOOLEAN_NAME_EXACT = new Set([
  'enabled', 'disabled', 'active', 'deleted', 'visible', 'archived',
  'verified', 'confirmed', 'published', 'locked', 'featured', 'approved',
  'hidden', 'pinned', 'starred', 'favorite', 'favourite', 'default',
  'read', 'seen', 'completed', 'done', 'paid', 'cancelled', 'canceled',
]);
const BOOLEAN_NAME_PREFIX = /^(is|has|can|should|was|are|does|allow|use|show|hide|skip|need)_/;

function looksLikeBooleanName(name: string): boolean {
  const n = name.toLowerCase();
  return BOOLEAN_NAME_EXACT.has(n) || BOOLEAN_NAME_PREFIX.test(n);
}

export function classifyColumn(
  dataType: string | undefined,
  columnName?: string,
  dialect: Dialect = 'generic',
): EditorKind {
  if (!dataType) return { kind: 'text' };
  const t = dataType.toLowerCase().trim();
  const nameSaysBool = !!columnName && looksLikeBooleanName(columnName);

  // Boolean — covers MySQL `tinyint(1)`, PG `bool`/`boolean`, SQLite `boolean`
  // (affinity NUMERIC but commonly declared), and the column-name heuristic
  // for narrow integer types that are really flags. PG never emits `bit(1)`;
  // MySQL does. The PG short alias `bool` is canonical.
  const looksLikeTinyint = /^tinyint\b/.test(t);
  if (
    /^tinyint\s*\(\s*1\s*\)/.test(t)
    || t === 'bool'
    || t === 'boolean'
    || /^bit\s*(\(\s*1\s*\))?$/.test(t)
    || (nameSaysBool && looksLikeTinyint)
    || (nameSaysBool && /^(smallint|int2|int|int4|integer|int8|bigint)\b/.test(t))
  ) {
    return { kind: 'boolean' };
  }

  // ENUM / SET — both are MySQL-only on the wire. PG enums come back as the
  // base type with their declared name (e.g. `mood`), so `manifest.column_types`
  // would surface the values; we don't try to recover that here.
  const enumMatch = /^enum\s*\((.+)\)\s*$/i.exec(t);
  if (enumMatch) return { kind: 'enum', options: parseEnumValues(enumMatch[1]) };
  const setMatch = /^set\s*\((.+)\)\s*$/i.exec(t);
  if (setMatch) return { kind: 'set', options: parseEnumValues(setMatch[1]) };

  // Integers — MySQL spelling (tinyint/mediumint/int), PG spelling
  // (int2/int4/int8/serial/bigserial), SQLite spelling (INTEGER, INT).
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|year|int2|int4|int8|serial|bigserial|smallserial)\b/.test(t)) {
    const unsigned = /\bunsigned\b/.test(t); // MySQL only
    return { kind: 'number', integer: true, min: unsigned ? 0 : undefined };
  }

  // Floating point / fixed point — MySQL (float/double/decimal/numeric/real),
  // PG (float4/float8/numeric/real/double precision/money), SQLite (REAL).
  if (/^(decimal|numeric|float|double|real|float4|float8|money)\b/.test(t)
      || /^double\s+precision\b/.test(t)) {
    return { kind: 'number', integer: false };
  }

  // Date / time — order matters. PG: date / time / timetz / timestamp /
  // timestamptz. MySQL: date / datetime / timestamp / time / year (year
  // already captured above). SQLite: stored as text/integer; declared
  // dialects often use these keywords anyway.
  if (t === 'date') return { kind: 'date' };
  if (t.startsWith('timestamp')) return { kind: 'datetime' };
  if (t.startsWith('datetime')) return { kind: 'datetime' };
  if (t === 'time' || t.startsWith('time ') || t === 'timetz' || t.startsWith('time(') || t.startsWith('time with') || t.startsWith('time without')) {
    return { kind: 'time' };
  }

  // JSON — MySQL `json`, PG `json` / `jsonb`. SQLite typically stores text;
  // we treat declared `json` as JSON for ergonomic editing.
  if (t === 'json' || t === 'jsonb') return { kind: 'json' };

  // Defer the unrecognised type back to text. Flagging dialect explicitly
  // here is mostly so future per-dialect tweaks have a hook — the lookup
  // tables above already cover the common cases.
  void dialect;
  return { kind: 'text' };
}

function parseEnumValues(body: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1].replace(/''/g, "'"));
  return out;
}

// Normalize a user-entered string into the canonical form the server
// expects. The boolean literal format comes from the adapter manifest
// (`'1'/'0'` for MySQL/SQLite, `'true'/'false'` for Postgres). All other
// inputs pass through unchanged. Empty / NULL inputs always pass.
import type { BooleanLiteralFormat } from '../../lib/db';

export function coerceForColumn(
  kind: EditorKind,
  value: unknown,
  booleanFormat: BooleanLiteralFormat = 'oneZero',
): unknown {
  if (value === null || value === undefined) return value;
  // The literal `NULL` sentinel means "write SQL NULL" — represent it as a
  // real JS null so the adapter binds an actual NULL, not the 4-char string
  // "NULL". (Postgres rejects the string on a non-text column; MySQL would
  // silently store the text "NULL".) The grid sends this via "Set to NULL".
  if (typeof value === 'string' && value.toUpperCase() === 'NULL') return null;
  // Empty string is "set to empty", not NULL — pass it through verbatim for
  // text columns. For typed columns (number/bool/json) an empty string can't
  // be coerced, so leave it to the caller / validation; we return '' so the
  // existing insert-skip-empty path still works.
  if (value === '') return value;

  // Emit correctly-typed JS values so the backend binds the right SQL type.
  // This matters on Postgres, which (unlike MySQL) will NOT implicitly cast a
  // text bind to int/numeric/bool/jsonb — `column = $1` with a text param
  // throws "column is of type X but expression is of type text". MySQL is
  // unaffected (it casts), so this is strictly safer for both.
  switch (kind.kind) {
    case 'boolean': {
      // Normalise to a canonical boolean, then emit the form each engine's
      // bind path accepts: a native JS boolean for `trueFalse` adapters
      // (Postgres `boolean` — binds as a real bool, which Postgres requires
      // and won't cast from text), and the integer 1/0 for `oneZero`
      // adapters (MySQL `tinyint(1)`/SQLite — accept an int natively). Both
      // are typed values, never the text strings 'true'/'1' that broke
      // Postgres binds.
      let b: boolean | null = null;
      if (typeof value === 'boolean') b = value;
      else {
        const s = String(value).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on', 't'].includes(s)) b = true;
        else if (['0', 'false', 'no', 'off', 'f'].includes(s)) b = false;
      }
      if (b === null) return value; // unrecognised — leave for validation
      return booleanFormat === 'trueFalse' ? b : (b ? 1 : 0);
    }
    case 'number': {
      const n = Number(value);
      // Only coerce when it's actually numeric; otherwise pass through so
      // validation can surface the error rather than binding NaN.
      if (value === '' || !Number.isFinite(n)) return value;
      return n;
    }
    case 'json': {
      // Send parsed JSON so the adapter can bind a real json/jsonb value.
      // If it doesn't parse, pass the raw string through (validation catches
      // it upstream via validateEditorValue).
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    default:
      return value;
  }
}

export function validateEditorValue(kind: EditorKind, value: string): string | null {
  if (value === '' || value.toUpperCase() === 'NULL') return null;
  switch (kind.kind) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return 'Must be a number';
      if (kind.integer && !Number.isInteger(n)) return 'Must be an integer';
      if (kind.min !== undefined && n < kind.min) return `Must be ≥ ${kind.min}`;
      if (kind.max !== undefined && n > kind.max) return `Must be ≤ ${kind.max}`;
      return null;
    }
    case 'boolean': {
      const v = value.toLowerCase();
      if (['0', '1', 'true', 'false'].includes(v)) return null;
      return 'Must be 0/1 or true/false';
    }
    case 'enum': {
      return kind.options.includes(value) ? null : `Must be one of: ${kind.options.join(', ')}`;
    }
    case 'set': {
      const parts = value.split(',').map(s => s.trim()).filter(Boolean);
      const bad = parts.find(p => !kind.options.includes(p));
      return bad ? `Unknown option: ${bad}` : null;
    }
    case 'date': {
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : 'Must be YYYY-MM-DD';
    }
    case 'datetime': {
      return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/.test(value) ? null : 'Must be YYYY-MM-DD HH:MM[:SS]';
    }
    case 'time': {
      return /^\d{2}:\d{2}(:\d{2})?$/.test(value) ? null : 'Must be HH:MM[:SS]';
    }
    case 'json': {
      try { JSON.parse(value); return null; } catch (e) { return `Invalid JSON: ${(e as Error).message}`; }
    }
    default:
      return null;
  }
}
