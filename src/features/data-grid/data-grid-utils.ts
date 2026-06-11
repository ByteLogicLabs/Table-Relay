// Pure, framework-free helpers and shared types/constants for the data grid.
// Extracted from data-grid.tsx verbatim — no behavior change.

export type FilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "lt"
  | "is_empty"
  | "is_not_empty";

export interface FilterCondition {
  id: string;
  column: string;
  op: FilterOperator;
  value: string;
}

export type SortDirection = "asc" | "desc";
export type SortState = { column: string; direction: SortDirection } | null;

export const OPERATORS: {
  value: FilterOperator;
  label: string;
  valueless?: boolean;
}[] = [
  { value: "eq", label: "= equals" },
  { value: "neq", label: "≠ not equal" },
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "gt", label: "> greater than" },
  { value: "lt", label: "< less than" },
  { value: "is_empty", label: "is empty", valueless: true },
  { value: "is_not_empty", label: "is not empty", valueless: true },
];

export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function matchCondition(
  row: Record<string, unknown>,
  c: FilterCondition,
): boolean {
  const raw = row[c.column];
  const s = cellToString(raw).toLowerCase();
  const v = c.value.toLowerCase();
  switch (c.op) {
    case "eq":
      return s === v;
    case "neq":
      return s !== v;
    case "contains":
      return s.includes(v);
    case "starts_with":
      return s.startsWith(v);
    case "ends_with":
      return s.endsWith(v);
    case "gt": {
      const ln = Number(raw);
      const rn = Number(c.value);
      if (Number.isFinite(ln) && Number.isFinite(rn)) return ln > rn;
      return s > v;
    }
    case "lt": {
      const ln = Number(raw);
      const rn = Number(c.value);
      if (Number.isFinite(ln) && Number.isFinite(rn)) return ln < rn;
      return s < v;
    }
    case "is_empty":
      return s.length === 0;
    case "is_not_empty":
      return s.length > 0;
  }
}

// Spreadsheet-style table parser. Honors RFC-4180 / Excel TSV quoting,
// so a cell that contains a newline (wrapped in `"..."`) stays in one
// cell instead of getting split into multiple grid rows on paste.
//
// Delimiter is auto-detected from the first unquoted occurrence of a
// tab vs comma — TSV when both clipboards we care about (Excel, Sheets,
// Numbers, our own copy handler) emit tab-separated, CSV when the user
// pastes from a saved .csv. A `""` inside a quoted cell escapes a
// literal `"`.
export function parseClipboardTable(text: string): string[][] {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (src.length === 0) return [];

  // Sniff the delimiter: walk until the first unquoted tab or comma.
  let delim: "\t" | "," = "\t";
  {
    let inQ = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"') {
        if (inQ && src[i + 1] === '"') {
          i++;
          continue;
        }
        inQ = !inQ;
        continue;
      }
      if (inQ) continue;
      if (ch === "\t") {
        delim = "\t";
        break;
      }
      if (ch === ",") {
        delim = ",";
        break;
      }
      if (ch === "\n") break;
    }
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (inQuotes && src[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delim) {
      row.push(cur);
      cur = "";
      continue;
    }
    if (!inQuotes && ch === "\n") {
      row.push(cur);
      cur = "";
      // Drop completely-blank rows (trailing newline, or blank lines
      // between blocks — same heuristic as before, but now we can only
      // reach here when the newline is unquoted).
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  // Flush the final cell / row (no trailing newline case).
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export interface GridRow extends Record<string, unknown> {
  __rowId: string;
}

/** True when a row holds at least one user-entered value — i.e. any column
 *  (other than the internal `__rowId`) is non-null and not an empty string.
 *  Used to tell a "real" draft insert from a blank one created just by
 *  clicking an empty cell. */
export function rowHasData(row: GridRow): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (k === "__rowId") continue;
    if (v !== null && v !== undefined && v !== "") return true;
  }
  return false;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export interface GridData {
  cols: string[];
  rows: GridRow[];
}

export const EMPTY_DATA: GridData = { cols: [], rows: [] };

// Separator for editedCells keys. Non-printable so it never collides with
// row ids (which may contain `-` for inserts like `new:<uuid>`) or column
// names (which can include `-` via backticked identifiers).
export const KEY_SEP = "\x1f";

// Maximum characters we render inside a single cell. We only show a short
// preview — long TEXT/JSON/BLOB (e.g. hex-rendered binary) would otherwise
// bloat the DOM and can render blank when the browser struggles to lay out a
// huge single-line string across many rows. The full value stays reachable on
// DOUBLE-CLICK (the cell editor receives the untruncated value) and via the
// context menu (Copy Value / Copy Row as JSON) — both read the underlying row,
// not this display string.
export const CELL_MAX_RENDER_CHARS = 200;
// BLOB-ish types show a placeholder instead of rendering raw binary.
export const BLOB_TYPE_RE = /^(blob|tinyblob|mediumblob|longblob|varbinary|binary)\b/i;

/** Truncate `s` for display. Returns `[display, truncated]`. */
export function truncateForCell(s: string): [string, boolean] {
  if (s.length <= CELL_MAX_RENDER_CHARS) return [s, false];
  return [s.slice(0, CELL_MAX_RENDER_CHARS), true];
}

/**
 * Parse a MySQL-shaped date-ish string into `{ date, h, m, s }`. Accepts
 * `YYYY-MM-DD`, `YYYY-MM-DD HH:mm[:ss]`, or the `T`-separated variant.
 * Returns zeros for missing time parts so the editor has sensible defaults
 * when editing a DATE column.
 */
export function parseDateTimeString(s: string): {
  date: Date | undefined;
  h: number;
  m: number;
  sec: number;
} {
  if (!s) return { date: undefined, h: 0, m: 0, sec: 0 };
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!match) return { date: undefined, h: 0, m: 0, sec: 0 };
  const [, y, mo, d, hh = "0", mm = "0", ss = "0"] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return { date, h: Number(hh), m: Number(mm), sec: Number(ss) };
}

export const pad = (n: number) => String(n).padStart(2, "0");

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(
  date: Date,
  h: number,
  m: number,
  sec: number,
): string {
  return `${formatDate(date)} ${pad(h)}:${pad(m)}:${pad(sec)}`;
}
