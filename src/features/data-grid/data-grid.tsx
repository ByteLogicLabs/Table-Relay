import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { open as openFile } from "@tauri-apps/plugin-fs";
import {
  RefreshCw,
  Filter,
  Columns,
  Check,
  X,
  Download,
  Upload,
  ChevronLeft,
  ChevronRight,
  ListTree,
  Table2,
  Waypoints,
  Plus as PlusIcon,
  Trash2,
  Loader2,
  AlertCircle,
  LayoutTemplate,
  Undo2,
  Redo2,
  Calendar as CalendarIcon,
  Clock as ClockIcon,
  Sparkles,
  Radio,
  ChevronUp,
  ChevronDown,
  Copy,
} from "lucide-react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditorNs } from "monaco-editor";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { Calendar } from "../../components/ui/calendar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { toast } from "sonner";
import ExportModal, { type ExportConfig } from "./export-modal";
import { ConnectionProfile, DataViewMode } from "../../types";
import DiagramView from "../diagram/diagram-view";
import SchemaView, { type SchemaViewHandle } from "../schema/schema-view";
import { Checkbox } from "../../components/ui/checkbox";
import { GridSkeleton } from "../../components/skeleton";
import {
  db,
  isDbError,
  type BrowseFilter,
  type BrowseFilterOp,
  type BrowseResult,
  type TableStructure,
} from "../../lib/db";
import {
  classifyColumn,
  coerceForColumn,
  validateEditorValue,
  dialectFromManifest,
  type EditorKind,
} from "./editor-kinds";
import {
  readCachedGrid,
  writeCachedGrid,
  clearCachedGrid,
} from "../../state/tab-data-cache";
import { ensureTableStructure, useConnections } from "../../state/connections";
import {
  useAdapterManifests,
  resolveManifest,
} from "../../state/adapter-manifests";
import { getMonacoThemeId } from "../../lib/monaco-setup";
import { useSettings, type NullDisplay } from "../../lib/settings-store";

type FilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "lt"
  | "is_empty"
  | "is_not_empty";

interface FilterCondition {
  id: string;
  column: string;
  op: FilterOperator;
  value: string;
}

type SortDirection = "asc" | "desc";
type SortState = { column: string; direction: SortDirection } | null;

const OPERATORS: {
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

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function matchCondition(
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
function parseClipboardTable(text: string): string[][] {
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

interface LogQueryOptions {
  source?: "editor" | "grid" | "system";
  durationMs?: number;
  status?: "ok" | "error";
  message?: string;
}

interface DataGridProps {
  connectionId: string;
  schema: string;
  tableName: string;
  /** Stable id for the owning tab — used as a cache key so switching between
   *  open data tabs doesn't refetch from the server. */
  tabId?: string;
  /** True when this is the visible tab. Hidden data tabs stay mounted (to
   *  keep their fetched rows), but should NOT eagerly refetch on a global
   *  `tablerelay:reload` — they mark themselves stale and refetch lazily when
   *  the user switches back. Defaults to true so the grid still works if a
   *  caller doesn't pass it. */
  isActive?: boolean;
  connection: ConnectionProfile;
  viewMode: DataViewMode;
  onViewModeChange: (mode: DataViewMode) => void;
  onLogQuery?: (statement: string, opts?: LogQueryOptions) => void;
  /** Toolbar "Import" action. Handler opens the Import-SQL dialog at the
   *  workspace level with the given connection pre-selected. */
  onImportSql?: (connectionId: string) => void;
  /** Toolbar "Realtime" action. Opens (or refocuses) a realtime tab for
   *  this connection. Gated on `capabilities.realtime`. */
  onOpenRealtime?: (connectionId: string) => void;
}

interface GridRow extends Record<string, unknown> {
  __rowId: string;
}

/** True when a row holds at least one user-entered value — i.e. any column
 *  (other than the internal `__rowId`) is non-null and not an empty string.
 *  Used to tell a "real" draft insert from a blank one created just by
 *  clicking an empty cell. */
function rowHasData(row: GridRow): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (k === "__rowId") continue;
    if (v !== null && v !== undefined && v !== "") return true;
  }
  return false;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

/**
 * Streams export text to disk in chunks so a multi-million-row export never
 * lives in memory as one giant string. Optionally:
 *   - pipes through gzip (`CompressionStream`, native to the webview), and/or
 *   - splits the output into numbered part files once a part crosses a size
 *     threshold (measured on uncompressed bytes, so it's predictable with or
 *     without gzip).
 *
 * Splitting is cooperative: the caller writes at safe boundaries (between SQL
 * statements / CSV rows / JSON elements) and calls `maybeRollover()` there.
 * On rollover the writer finishes the current part, opens the next, and asks
 * the caller (via `onNewPart`) to re-emit any per-file preamble (CSV header,
 * SQL table comment + CREATE, JSON opening bracket) so every part is a valid
 * standalone file. The caller's `onEndPart` runs just before each part closes
 * (e.g. JSON's closing bracket).
 */
class ExportWriter {
  private file: Awaited<ReturnType<typeof openFile>> | null = null;
  private encoder = new TextEncoder();
  private buf: Uint8Array[] = [];
  private bufBytes = 0;
  private readonly flushAt = 256 * 1024;
  private gzWriter: WritableStreamDefaultWriter<BufferSource> | null = null;
  private gzDrain: Promise<void> | null = null;
  // Split bookkeeping.
  private partBytes = 0; // uncompressed bytes written to the current part
  private partIndex = 1;
  private finishingPart = false; // guard so maybeRollover doesn't recurse via onEndPart
  // Hooks supplied by the caller for split-aware preamble/finalizer.
  private onNewPart: (() => Promise<void>) | null = null;
  private onEndPart: (() => Promise<void>) | null = null;

  private constructor(
    private basePath: string,
    private gzip: boolean,
    private splitBytes: number | null,
  ) {}

  /**
   * `basePath` is the user-chosen path (e.g. `/x/name.sql` or `.sql.gz`). When
   * splitting, parts are derived as `name.partNN.sql[.gz]`. Hooks default to
   * no-ops for single-file / non-split exports.
   */
  static async create(
    basePath: string,
    gzip: boolean,
    splitBytes: number | null,
    hooks?: { onNewPart?: () => Promise<void>; onEndPart?: () => Promise<void> },
  ): Promise<ExportWriter> {
    const w = new ExportWriter(basePath, gzip, splitBytes);
    w.onNewPart = hooks?.onNewPart ?? null;
    w.onEndPart = hooks?.onEndPart ?? null;
    await w.openPart();
    return w;
  }

  /** Path for the current part. Single-file exports use `basePath` verbatim. */
  private partPath(): string {
    if (this.splitBytes == null) return this.basePath;
    // Insert `.partNN` before the format extension(s). basePath looks like
    // `/dir/name.sql` or `/dir/name.sql.gz`; split on the first known ext.
    const m = this.basePath.match(/^(.*?)\.(csv|json|sql)(\.gz)?$/i);
    const nn = String(this.partIndex).padStart(2, "0");
    if (!m) return `${this.basePath}.part${nn}`;
    const [, stem, ext, gz = ""] = m;
    return `${stem}.part${nn}.${ext}${gz}`;
  }

  private async openPart(): Promise<void> {
    this.file = await openFile(this.partPath(), {
      write: true,
      create: true,
      truncate: true,
    });
    this.partBytes = 0;
    if (this.gzip) {
      const cs = new CompressionStream("gzip");
      this.gzWriter = cs.writable.getWriter();
      const file = this.file;
      this.gzDrain = (async () => {
        const reader = cs.readable.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) await file.write(value);
        }
      })();
    }
  }

  private async closePart(): Promise<void> {
    await this.flush();
    if (this.gzWriter) {
      await this.gzWriter.close();
      await this.gzDrain;
      this.gzWriter = null;
      this.gzDrain = null;
    }
    await this.file?.close();
    this.file = null;
  }

  /** Queue text; flushed to disk (or gzip) once the buffer crosses the threshold. */
  async write(text: string): Promise<void> {
    if (!text) return;
    const bytes = this.encoder.encode(text);
    this.buf.push(bytes);
    this.bufBytes += bytes.byteLength;
    this.partBytes += bytes.byteLength;
    if (this.bufBytes >= this.flushAt) await this.flush();
  }

  /**
   * Roll over to a new part file if the current one has crossed the split
   * threshold. Call only at a safe boundary (between whole statements/rows).
   * No-op when splitting is off or the current part is still under the limit.
   */
  async maybeRollover(): Promise<void> {
    if (this.splitBytes == null || this.finishingPart) return;
    if (this.partBytes < this.splitBytes) return;
    this.finishingPart = true;
    if (this.onEndPart) await this.onEndPart();
    await this.closePart();
    this.partIndex += 1;
    await this.openPart();
    if (this.onNewPart) await this.onNewPart();
    this.finishingPart = false;
  }

  /** Number of part files written so far. */
  get parts(): number {
    return this.partIndex;
  }

  private async flush(): Promise<void> {
    if (this.bufBytes === 0 || !this.file) return;
    const merged = new Uint8Array(this.bufBytes);
    let off = 0;
    for (const c of this.buf) {
      merged.set(c, off);
      off += c.byteLength;
    }
    this.buf = [];
    this.bufBytes = 0;
    if (this.gzWriter) {
      await this.gzWriter.write(merged);
    } else {
      await this.file.write(merged);
    }
  }

  async close(): Promise<void> {
    await this.closePart();
  }
}

interface GridData {
  cols: string[];
  rows: GridRow[];
}

const EMPTY_DATA: GridData = { cols: [], rows: [] };
// Separator for editedCells keys. Non-printable so it never collides with
// row ids (which may contain `-` for inserts like `new:<uuid>`) or column
// names (which can include `-` via backticked identifiers).
const KEY_SEP = "\x1f";

// Maximum characters we render inside a single cell. Large TEXT/JSON/BLOB
// values have been observed to freeze the grid when the browser tries to
// layout thousands of characters per cell across hundreds of rows — the
// truncation keeps rendering bounded while the full value stays reachable
// via context menu (Copy Value / Copy Row as JSON) and the cell editor,
// both of which read from the underlying row, not the display string.
const CELL_MAX_RENDER_CHARS = 1024;
// BLOB-ish types show a placeholder instead of rendering raw binary.
const BLOB_TYPE_RE = /^(blob|tinyblob|mediumblob|longblob|varbinary|binary)\b/i;

/** Truncate `s` for display. Returns `[display, truncated]`. */
function truncateForCell(s: string): [string, boolean] {
  if (s.length <= CELL_MAX_RENDER_CHARS) return [s, false];
  return [s.slice(0, CELL_MAX_RENDER_CHARS), true];
}

export default function DataGrid({
  connectionId,
  schema,
  tableName,
  tabId,
  isActive = true,
  connection,
  viewMode,
  onViewModeChange,
  onLogQuery,
  onImportSql,
  onOpenRealtime,
}: DataGridProps) {
  // Seed from the tab's in-memory cache so switching back to an already-opened
  // tab renders instantly without a round trip. First boot / post-reload the
  // cache is empty (it's not persisted), so behavior matches "fetch fresh".
  const settings = useSettings();
  const connState = useConnections();
  const exportSchemas = useMemo(() => {
    const loaded = connState.schemasById.get(connectionId);
    if (loaded && loaded.length > 0) return loaded;
    return [
      {
        name: schema,
        tables: [{ name: tableName, kind: "table" as const, rowCount: null }],
      },
    ];
  }, [connState.schemasById, connectionId, schema, tableName]);
  const cached = tabId ? readCachedGrid(tabId) : undefined;
  const [data, setData] = useState<GridData>(() =>
    cached ? { cols: cached.cols, rows: cached.rows as GridRow[] } : EMPTY_DATA,
  );
  const [structure, setStructure] = useState<TableStructure | null>(
    cached?.structure ?? null,
  );
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editedCells, setEditedCells] = useState<Record<string, unknown>>({});
  const [activeEdit, setActiveEdit] = useState<{
    rowId: string;
    col: string;
    value: string;
  } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // New tabs use the user's default row limit; an already-adjusted tab keeps
  // its cached value.
  const [limit, setLimit] = useState(
    cached?.limit ?? String(settings.defaultRowLimit),
  );
  // 1-based page index. Bumped by the pager buttons; reset to 1 whenever the
  // limit, filters, or target change (handled in effects below). Surviving
  // tab switches via the grid cache so returning to a tab keeps your spot.
  const [page, setPage] = useState<number>(cached?.page ?? 1);
  // Total row count for the current filter set. null = not known yet (COUNT
  // still in flight, or skipped because of an earlier failure).
  const [totalRows, setTotalRows] = useState<number | null>(
    cached?.totalRows ?? null,
  );
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  // Live export progress. `null` = no export running; otherwise drives the
  // progress toast. `exportCancelRef` lets the Cancel button abort the loop.
  const [exportProgress, setExportProgress] = useState<{
    rows: number;
    total: number | null;
    table: string;
  } | null>(null);
  const exportCancelRef = useRef(false);
  const [draftFilters, setDraftFilters] = useState<FilterCondition[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<FilterCondition[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortState>(null);
  const [executionMs, setExecutionMs] = useState<number | null>(
    cached?.executionMs ?? null,
  );
  // Track the grid viewport height so we can pad the table with empty
  // spreadsheet-style filler rows when the result set is short — otherwise a
  // 2-row table leaves a large blank void below it.
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const headerRowRef = useRef<HTMLTableRowElement | null>(null);
  const [gridViewportH, setGridViewportH] = useState(0);
  // Measured row height — the real height of a rendered header row, so the
  // filler-row count is accurate regardless of theme/font/padding (a guessed
  // constant under- or over-filled and left a gap / scrollbar).
  const [measuredRowH, setMeasuredRowH] = useState(0);
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const measure = () => {
      setGridViewportH(el.clientHeight);
      const h = headerRowRef.current?.offsetHeight ?? 0;
      if (h > 0) setMeasuredRowH(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [schemaDirty, setSchemaDirty] = useState(false);
  const [schemaSaving, setSchemaSaving] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [lastSelectedRowId, setLastSelectedRowId] = useState<string | null>(
    null,
  );
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  // Rows queued for INSERT on commit. Each has a synthetic __rowId prefixed
  // with `new:` so existing edit/select machinery can key off it the same way
  // as fetched rows.
  const [pendingInserts, setPendingInserts] = useState<GridRow[]>([]);
  const [isCommitting, setIsCommitting] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [confirmRefreshOpen, setConfirmRefreshOpen] = useState(false);
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false);
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    rowId: string;
    col: string | null;
  } | null>(null);
  // Slim top progress bar. Value 0–100; `visible=false` lets the bar fade out
  // after hitting 100. Driven by active work signals below (loading, refresh,
  // committing) rather than fetch progress events, since we don't have real
  // byte-level progress from Tauri.
  const [progress, setProgress] = useState(0);
  const [progressVisible, setProgressVisible] = useState(false);
  // Undo/redo stack. Each entry is a full snapshot of pending mutation state.
  // Simple, small memory footprint, handles any kind of change uniformly.
  type HistorySnapshot = {
    edits: Record<string, unknown>;
    deletes: string[];
    inserts: GridRow[];
  };
  const undoStackRef = useRef<HistorySnapshot[]>([]);
  const redoStackRef = useRef<HistorySnapshot[]>([]);
  // Bump whenever we push/pop, so buttons re-render with current enablement.
  const [historyTick, setHistoryTick] = useState(0);
  const [editorTheme, setEditorTheme] = useState<string>(
    getMonacoThemeId(document.documentElement.dataset.theme ?? "monokai"),
  );
  const jsonEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(
    null,
  );
  // Dirty-tracking for the JSON Tree editor. We don't mirror the full text
  // into React state (Monaco owns it) — only the dirty flag and any parse /
  // shape error so the Save button + status pill react.
  const [jsonDirty, setJsonDirty] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonSaving, setJsonSaving] = useState(false);
  // Monaco's `addCommand` captures the handler closure at bind time. The
  // save function depends on state that changes (rowsForView, structure,
  // jsonSaving), so we route through a ref that always points at the latest
  // closure. The Cmd/Ctrl+S binding calls `jsonSaveRef.current()`.
  const jsonSaveRef = useRef<() => void>(() => {});
  const schemaRef = useRef<SchemaViewHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!filterPopoverOpen && !columnsPopoverOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest('[data-grid-toolbar-popover="true"]') ||
        target.closest('[data-slot="select-content"]')
      ) {
        return;
      }
      setFilterPopoverOpen(false);
      setColumnsPopoverOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [columnsPopoverOpen, filterPopoverOpen]);

  const setViewMode = onViewModeChange;

  // Capability flags from the adapter manifest. Default to `true` so the
  // toolbar renders its historic set while manifests are still loading;
  // once the fetch resolves, unsupported actions disappear.
  const manifests = useAdapterManifests();
  const activeManifest = useMemo(
    () => resolveManifest(manifests, connection.driver),
    [manifests, connection.driver],
  );
  const supportsDiagram = activeManifest?.capabilities.diagram ?? true;
  const supportsSchemaView =
    activeManifest?.capabilities.describeSchema ?? true;
  // Safe default: never assume DDL support when manifest is still loading
  // or couldn't be resolved for this connection. The schema editor's Save
  // toolbar is enabled if EITHER full-table DDL is supported (SQL adapters
  // → CREATE/ALTER TABLE path) OR structured index management is exposed
  // (Mongo → `db.modifyIndexes`). The view itself decides what fields are
  // editable based on the same flags.
  const supportsSchemaEdit =
    (activeManifest?.capabilities.alterTable ?? false) ||
    (activeManifest?.capabilities.manageIndexes ?? false);
  // Import is offered when the adapter either declares importable file
  // formats (SQL stores → `import: ["sql", …]`) OR can ingest rows directly
  // (`insert_rows: true`). The latter brings in document stores like Mongo,
  // which can't run SQL dumps but can take CSV/JSON rows one document at a
  // time. Redis (`insert_rows: false`, no import formats) stays excluded.
  const supportsImport =
    (activeManifest?.capabilities.import?.length ?? 1) > 0 ||
    (activeManifest?.capabilities.insertRows ?? false);
  const supportsExport = (activeManifest?.capabilities.export?.length ?? 1) > 0;
  const supportsServerSort = activeManifest?.capabilities.serverSort ?? true;
  // Defaults to false — the Realtime entry should not flash for SQL
  // adapters while manifests load.
  const supportsRealtime = activeManifest?.capabilities.realtime ?? false;

  // Document-store flag derived from the manifest's sql_dialect. The
  // grid uses this to render JSON-tree mode and to hide auto-managed
  // primary-key columns. Replaces the old `connection.driver === 'MongoDB'`
  // check; any future document store ships a manifest with sql_dialect=none.
  const isDocumentStore = activeManifest?.capabilities.sqlDialect === "none";
  // Column to hide in the data grid (Mongo's `_id`); empty string = none.
  const hideColumnInGrid = activeManifest?.capabilities.hideColumnInGrid ?? "";

  // Identifier quoting varies by SQL dialect: MySQL uses backticks,
  // everyone else uses ANSI double quotes. Used when the grid builds raw
  // INSERT/UPDATE/DELETE/SELECT via `run_query`. Adapter-native browse /
  // mutate paths handle their own quoting, so this only fires on the
  // data-grid's compatibility shim for SQL stores.
  const qi = useMemo(() => {
    if (activeManifest?.capabilities.sqlDialect === "mysql") {
      return (s: string) => `\`${s.replace(/`/g, "``")}\``;
    }
    return (s: string) => `"${s.replace(/"/g, '""')}"`;
  }, [activeManifest]);

  const activeFilters = useMemo(
    () =>
      appliedFilters.filter((f) => {
        const op = OPERATORS.find((o) => o.value === f.op);
        return f.column && (op?.valueless || f.value.trim() !== "");
      }),
    [appliedFilters],
  );

  const validDraftFilters = useMemo(
    () =>
      draftFilters.filter((f) => {
        const op = OPERATORS.find((o) => o.value === f.op);
        return f.column && (op?.valueless || f.value.trim() !== "");
      }),
    [draftFilters],
  );

  const filtersDirty = useMemo(
    () => JSON.stringify(draftFilters) !== JSON.stringify(appliedFilters),
    [draftFilters, appliedFilters],
  );

  const filteredRows = useMemo(() => {
    const base =
      activeFilters.length === 0
        ? data.rows
        : data.rows.filter((r) =>
            activeFilters.every((c) =>
              matchCondition(r as Record<string, unknown>, c),
            ),
          );
    // Pending inserts always render (filters shouldn't hide a draft the user
    // is actively building) and come after the persisted rows.
    return pendingInserts.length > 0 ? [...base, ...pendingInserts] : base;
  }, [data.rows, activeFilters, pendingInserts]);

  const rowsForView = useMemo(() => {
    if (supportsServerSort || !sortBy) return filteredRows;
    const dir = sortBy.direction === "asc" ? 1 : -1;
    const sorted = [...filteredRows].sort((a, b) => {
      const av = a[sortBy.column];
      const bv = b[sortBy.column];
      if (av === bv) return 0;
      if (av === null || av === undefined) return -1 * dir;
      if (bv === null || bv === undefined) return 1 * dir;
      if (typeof av === "number" && typeof bv === "number") {
        if (Number.isNaN(av) && Number.isNaN(bv)) return 0;
        if (Number.isNaN(av)) return -1 * dir;
        if (Number.isNaN(bv)) return 1 * dir;
        return (av - bv) * dir;
      }
      if (typeof av === "boolean" && typeof bv === "boolean") {
        return ((av ? 1 : 0) - (bv ? 1 : 0)) * dir;
      }
      return (
        cellToString(av).localeCompare(cellToString(bv), undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    });
    return sorted;
  }, [filteredRows, sortBy, supportsServerSort]);
  // The JSON Tree view is currently Mongo-only and shows the raw documents
  // the user expects — no synthetic grid bookkeeping. We strip `__rowId`
  // (added client-side at fetch time, see ingestBrowseResult) so what shows
  // is exactly what Mongo returned. The save path matches edits back to
  // originals via `_id`, which is Mongo's real document identifier.
  const jsonRowsText = useMemo(() => {
    const cleaned = rowsForView.map(({ __rowId: _ignored, ...rest }) => rest);
    return JSON.stringify(cleaned, null, 2);
  }, [rowsForView]);
  const activeServerSort = supportsServerSort ? sortBy : null;

  const collapseJsonSubtrees = useCallback(
    (editor: MonacoEditorNs.IStandaloneCodeEditor | null) => {
      if (!editor) return;
      requestAnimationFrame(() => {
        // Keep nesting depth <=2 expanded, collapse depth >=3.
        editor.trigger("json-default-fold", "editor.unfoldAll", null);
        editor.trigger("json-default-fold", "editor.foldLevel3", null);
        editor.setPosition({ lineNumber: 1, column: 1 });
      });
    },
    [],
  );

  useEffect(() => {
    const root = document.documentElement;
    const sync = () =>
      setEditorTheme(getMonacoThemeId(root.dataset.theme ?? "monokai"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (viewMode !== "json" || !isDocumentStore) return;
    // Don't refold while the user is mid-edit — would jump the viewport and
    // collapse subtrees they just opened. Refold only happens on initial open
    // and after a successful save (which clears jsonDirty).
    if (jsonDirty) return;
    collapseJsonSubtrees(jsonEditorRef.current);
  }, [
    viewMode,
    isDocumentStore,
    jsonRowsText,
    collapseJsonSubtrees,
    jsonDirty,
  ]);

  // When the underlying data changes (refresh, commit elsewhere) reset the
  // editor dirty state so it tracks the new source of truth.
  useEffect(() => {
    setJsonDirty(false);
    setJsonError(null);
  }, [jsonRowsText]);

  // When the query returned zero rows we still want the table to feel present:
  // render headers from the last query's cols if available, or fall back to
  // describeTable's structure so newly-created / always-empty tables still
  // show their column layout.
  const allDisplayCols = useMemo(() => {
    if (structure?.columns.length) return structure.columns.map((c) => c.name);
    if (data.cols.length > 0) return data.cols;
    return [];
  }, [data.cols, structure]);

  const displayCols = useMemo(
    () => allDisplayCols.filter((col) => !hiddenColumns.has(col)),
    [allDisplayCols, hiddenColumns],
  );

  const queryProjectionCols = useMemo(() => {
    if (hiddenColumns.size === 0 || displayCols.length === 0) return undefined;
    const cols = new Set(displayCols);
    structure?.primaryKey.forEach((pk) => cols.add(pk));
    if (hideColumnInGrid) cols.add(hideColumnInGrid);
    return Array.from(cols).filter((col) => allDisplayCols.includes(col));
  }, [
    allDisplayCols,
    displayCols,
    hiddenColumns.size,
    hideColumnInGrid,
    structure,
  ]);

  const queryProjectionKey = queryProjectionCols
    ? JSON.stringify(queryProjectionCols)
    : "";

  useEffect(() => {
    setHiddenColumns((prev) => {
      const available = new Set(allDisplayCols);
      let changed = false;
      const next = new Set<string>();
      prev.forEach((col) => {
        if (available.has(col)) next.add(col);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [allDisplayCols]);

  // Dialect + boolean format come from the active adapter manifest, not
  // the driver name. New adapter ships a manifest → these flags pick up
  // automatically; no edits to the data grid.
  const dialect = useMemo(
    () => dialectFromManifest(activeManifest?.capabilities),
    [activeManifest],
  );
  const booleanFormat =
    activeManifest?.capabilities.booleanLiteralFormat ?? "oneZero";

  const columnKinds = useMemo<Record<string, EditorKind>>(() => {
    const map: Record<string, EditorKind> = {};
    structure?.columns.forEach((c) => {
      map[c.name] = classifyColumn(c.dataType, c.name, dialect);
    });
    return map;
  }, [structure, dialect]);

  // Raw MySQL type strings per column — needed so DataRow can spot BLOB-ish
  // columns and replace their body with a size summary instead of rendering
  // raw bytes.
  const columnDataTypes = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    structure?.columns.forEach((c) => {
      map[c.name] = c.dataType;
    });
    return map;
  }, [structure]);

  // Columns that MUST be filled on insert: NOT NULL, no server default, and
  // not auto-incremented. Used to highlight empty required cells on draft
  // rows before commit, and to short-circuit commit with a clear message.
  const requiredColumnNames = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    structure?.columns.forEach((c) => {
      const isAuto = !!c.extra && /auto_increment/i.test(c.extra);
      if (!c.nullable && c.default === null && !isAuto) set.add(c.name);
    });
    return set;
  }, [structure]);

  const addFilter = () => {
    if (data.cols.length === 0) return;
    setDraftFilters((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        column: data.cols[0],
        op: "contains",
        value: "",
      },
    ]);
  };

  const updateFilter = (id: string, patch: Partial<FilterCondition>) => {
    setDraftFilters((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
  };

  const removeFilter = (id: string) => {
    setDraftFilters((prev) => prev.filter((f) => f.id !== id));
  };

  const applyFilters = () => {
    setAppliedFilters(validDraftFilters.map((f) => ({ ...f })));
  };

  const clearFilters = () => {
    setDraftFilters([]);
  };

  const resetFilters = () => {
    setDraftFilters(appliedFilters.map((f) => ({ ...f })));
  };

  const toggleColumn = (column: string, visible: boolean) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(column);
      else next.add(column);
      return next;
    });
  };

  const cycleSort = useCallback((column: string) => {
    setSortBy((prev) => {
      if (!prev || prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return null;
    });
  }, []);

  // Focus + select the input once when editing starts. Keying off the
  // (rowId, col) pair means this runs when the editor opens or moves to a
  // different cell, but not on every keystroke — re-selecting on each value
  // change would wipe the user's typing.
  const editTargetKey = activeEdit
    ? `${activeEdit.rowId}::${activeEdit.col}`
    : null;
  useEffect(() => {
    const el = inputRef.current;
    if (!editTargetKey || !el) return;
    el.focus();
    // Only <input>/<textarea> support select() — <select> elements (used for
    // boolean/enum editors) don't, and calling it throws.
    if (typeof (el as HTMLInputElement).select === "function") {
      (el as HTMLInputElement).select();
    }
  }, [editTargetKey]);

  const fetchData = async (opts: { showRefresh?: boolean } = {}) => {
    if (opts.showRefresh) setIsRefreshing(true);
    else setLoading(true);
    setLoadError(null);
    // Invalidate the previous total so the pager renders "N" instead of a
    // stale "N of OLD" while the count fetch is in flight.
    setTotalRows(null);

    try {
      const limitN = Number(limit);
      const pageN = Math.max(1, page);
      // The row fetch and structure are required; the count rides along on
      // the same request — the adapter decides whether to run it in the
      // same round-trip (it does today). Structure is independent.
      const [browseRes, structureRes] = await Promise.all([
        db.browse(connectionId, {
          schema,
          table: tableName,
          columns: queryProjectionCols,
          filters: toBrowseFilters(),
          sort: activeServerSort
            ? [
                {
                  column: activeServerSort.column,
                  direction: activeServerSort.direction,
                },
              ]
            : [],
          page: { number: pageN, size: limitN },
          includeTotal: true,
        }),
        structure
          ? Promise.resolve(structure)
          : ensureTableStructure(connectionId, schema, tableName),
      ]);
      setStructure(structureRes);
      // Ignore stale responses: while we were fetching the user may have
      // paged to a different page. `browseRes.page` is the page the adapter
      // served; if it doesn't match our current `page` state we drop it.
      if (browseRes.page !== pageN) {
        return;
      }
      ingestBrowseResult(browseRes, structureRes);
    } catch (err) {
      setLoadError(isDbError(err) ? err.message : String(err));
    } finally {
      if (opts.showRefresh) setIsRefreshing(false);
      else setLoading(false);
    }
  };

  /** Apply a `db.browse` response to the grid state + tab cache. */
  const ingestBrowseResult = (
    res: BrowseResult,
    structureRes: TableStructure | null,
  ) => {
    const cols = res.columns.map((c) => c.name);
    const rows: GridRow[] = res.rows.map((r, idx) => {
      const obj: GridRow = { __rowId: `r${idx}` };
      cols.forEach((c, i) => {
        obj[c] = r[i];
      });
      return obj;
    });
    setData({ cols, rows });
    setExecutionMs(res.durationMs);
    setTotalRows(res.totalRecords);
    if (tabId) {
      writeCachedGrid(tabId, {
        cols,
        rows,
        structure: structureRes,
        executionMs: res.durationMs,
        limit,
        page,
        totalRows: res.totalRecords,
      });
    }
    onLogQuery?.(buildStatement(), {
      source: "grid",
      durationMs: res.durationMs,
      status: "ok",
    });
  };

  // Identity of the target + params the grid currently holds loaded. A ref so
  // it survives StrictMode's simulated remount — we never double-fetch the
  // same target. `null` = nothing loaded yet for this grid.
  const loadTargetKey = () =>
    `${connectionId}|${schema}|${tableName}|${page}|${limit}|${JSON.stringify(activeFilters)}|${JSON.stringify(activeServerSort)}|${queryProjectionKey}`;
  const loadedTargetRef = useRef<string | null>(null);
  // Seed from cache on first render: if we hydrated from the tab cache, that
  // snapshot already IS the loaded state, so the loader must not refetch it.
  // (Lazy ref init — the React-recommended pattern; runs once.)
  if (loadedTargetRef.current === null && cached) {
    loadedTargetRef.current = loadTargetKey();
  }
  // Reset page to 1 when limit/filters/sort change. Runs on *change*, not
  // mount; the initial value came from cache (or 1).
  const firstRunRef = useRef(true);
  // `isActiveRef` mirrors the `isActive` prop so the reload listener reads the
  // live value without re-subscribing on every tab switch. `isStaleRef` marks
  // that a tab owes a fetch (deferred while hidden, or a reload arrived) — it
  // forces the loader past the loadedTarget short-circuit.
  const isActiveRef = useRef(isActive);
  const isStaleRef = useRef(false);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    setPage(1);
    // activeFilters is a derived memo; its identity is stable until the
    // underlying applied filters change, which is what we actually want to watch.
  }, [limit, activeFilters, activeServerSort]);

  // Reset edit/selection state whenever the TARGET (connection/schema/table)
  // changes — switching to a different table must drop pending edits, undo
  // history, etc. Param changes (page/limit/filter/sort) do NOT wipe; they
  // just refetch via the loader below. Keyed only on the target so it never
  // fires on a tab switch or a param change.
  const prevTargetRef = useRef({ connectionId, schema, tableName });
  useEffect(() => {
    const prev = prevTargetRef.current;
    if (
      prev.connectionId === connectionId &&
      prev.schema === schema &&
      prev.tableName === tableName
    ) {
      return;
    }
    prevTargetRef.current = { connectionId, schema, tableName };
    setStructure(null);
    setData(EMPTY_DATA);
    setEditedCells({});
    setActiveEdit(null);
    setDraftFilters([]);
    setAppliedFilters([]);
    setHiddenColumns(new Set());
    setSortBy(null);
    setSelectedRows(new Set());
    setLastSelectedRowId(null);
    setPendingDeletes(new Set());
    setPendingInserts([]);
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryTick(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, tableName]);

  // THE single fetch authority. A hidden tab browsing is structurally
  // impossible: the loader returns immediately unless THIS grid is the active
  // (visible) one. The previous design split fetching across three effects
  // (mount/target, params, activation) each guarded by a ref snapshot; a
  // params effect leaked because its first-run guard was defeated by
  // StrictMode's double-invoke (same instance, persisting refs) and by
  // `activeFilters` taking a new array identity during the mount cascade — so
  // every hidden grid browsed on reload. This consolidates all of it:
  //
  //   - Not active  → never fetch. Mark stale iff there's nothing cached, so
  //                   the first activation loads it (lazy). Cached-but-hidden
  //                   tabs stay un-stale → instant cache on activation.
  //   - Active      → fetch only if the target+params we hold differ from what
  //                   we last loaded (loadedTargetRef), or a reload marked us
  //                   stale. Idempotent under StrictMode's double-invoke and
  //                   re-activation with nothing changed (no redundant browse).
  //
  // Deps include page/limit/applied filters/sort so a param change on the visible tab
  // still refetches (the key differs) — but a hidden tab's deps changing can't
  // fetch because of the `!isActive` guard.
  useEffect(() => {
    isActiveRef.current = isActive;
    if (!isActive) {
      // Always mark stale when hidden so the next activation refetches.
      // The cache still provides instant display (showRefresh path) while the
      // fresh data loads in the background — this prevents stale/empty results
      // from persisting after switching connections and back.
      isStaleRef.current = true;
      return;
    }
    const key = loadTargetKey();
    if (loadedTargetRef.current === key && !isStaleRef.current) return;
    // Uncommitted edits + a reload-driven refetch → confirm instead of wiping.
    if (isStaleRef.current && hasPendingRef.current) {
      setConfirmRefreshOpen(true);
      return;
    }
    // CRITICAL: claim the target (set loadedTargetRef/clear isStaleRef) INSIDE
    // the microtask, only when the fetch actually runs. Under StrictMode the
    // effect runs setup→cleanup→setup on one instance: if we claimed it here
    // (synchronously) the first setup's fetch gets cancelled by the cleanup,
    // and the second setup would see loadedTargetRef already === key and
    // short-circuit → ZERO fetches (active tab stuck on a skeleton). Deferring
    // the claim means the second setup still sees the old key and re-queues; of
    // the two microtasks only the live one (second) runs and claims.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadedTargetRef.current = key;
      isStaleRef.current = false;
      void fetchData({ showRefresh: data.rows.length > 0 });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isActive,
    connectionId,
    schema,
    tableName,
    page,
    limit,
    activeFilters,
    activeServerSort,
    queryProjectionKey,
  ]);

  // Soft reload (⌘+R) — refetch rows without touching the filter / column
  // state. Scoped to this grid's connection (or global if the event was
  // dispatched without a connection id).
  //
  // Lazy-load: a single ⌘+R (or a post-reconnect refresh) fires this event on
  // EVERY mounted data tab for the connection. Eagerly refetching all of them
  // re-pulls every open table from the server at once — wasteful, and the cost
  // the user is asking us to avoid. So only the VISIBLE tab refetches now;
  // hidden tabs just flag themselves stale and refetch when switched back to
  // (see the `isActive` effect below).
  useEffect(() => {
    const onReload = (e: Event) => {
      const ce = e as CustomEvent<{ connectionId: string | null }>;
      const target = ce.detail?.connectionId;
      if (target && target !== connectionId) return;
      // Hidden tab → defer. Invalidate what we hold + mark stale; the loader
      // refetches once this tab is next shown (its `isActive` effect re-runs).
      if (!isActiveRef.current) {
        loadedTargetRef.current = null;
        isStaleRef.current = true;
        return;
      }
      // Active tab → refetch now. Uncommitted edits route through the same
      // confirmation dialog the toolbar Refresh button uses instead of wiping.
      if (hasPendingRef.current) {
        setConfirmRefreshOpen(true);
        return;
      }
      setEditedCells({});
      setActiveEdit(null);
      loadedTargetRef.current = loadTargetKey();
      void fetchData({ showRefresh: true });
    };
    window.addEventListener("tablerelay:reload", onReload);
    return () => window.removeEventListener("tablerelay:reload", onReload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, tableName]);

  // (The former "activation" effect is gone — the unified loader above owns
  // re-fetching a hidden tab when it becomes visible, gated on `isActive`.)

  // File menu → Export bridge. Workspace-view routes the native "Export…"
  // menu click into a `tablerelay:menu-export` event tagged with the active
  // tab id. Only the matching data-grid opens its export modal so we
  // don't fan out to every hidden tab.
  useEffect(() => {
    if (!tabId) return;
    const onMenuExport = (ev: Event) => {
      const detail = (ev as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId === tabId) setIsExportModalOpen(true);
    };
    window.addEventListener("tablerelay:menu-export", onMenuExport);
    return () =>
      window.removeEventListener("tablerelay:menu-export", onMenuExport);
  }, [tabId]);

  // Live export progress toast with a Cancel action. A single persistent toast
  // (id "data-export") is updated as `exportProgress` changes and dismissed
  // when the export ends.
  useEffect(() => {
    const TOAST_ID = "data-export";
    if (!exportProgress) {
      toast.dismiss(TOAST_ID);
      return;
    }
    const { rows, total, table } = exportProgress;
    const pct = total && total > 0 ? Math.min(100, Math.round((rows / total) * 100)) : null;
    const count = total != null
      ? `${rows.toLocaleString()} / ${total.toLocaleString()} rows`
      : `${rows.toLocaleString()} rows`;
    toast.loading(
      `Exporting ${table} — ${count}${pct != null ? ` (${pct}%)` : ""}`,
      {
        id: TOAST_ID,
        duration: Infinity,
        action: {
          label: "Cancel",
          onClick: () => {
            exportCancelRef.current = true;
          },
        },
      },
    );
  }, [exportProgress]);

  // Top progress bar driver. When any async work is active we creep from 0 to
  // 90 with an easing curve (fast at first, slow near the top) so long queries
  // still show movement without falsely claiming completion. When the work
  // finishes we snap to 100, then fade the bar out after a short delay.
  const isBusy = loading || isRefreshing || isCommitting;
  useEffect(() => {
    if (isBusy) {
      setProgressVisible(true);
      setProgress((p) => (p > 0 && p < 100 ? p : 8));
      let raf = 0;
      const step = () => {
        setProgress((prev) => {
          if (prev >= 90) return prev;
          // Gap to the ceiling shrinks as we approach it → natural ease.
          const gap = 90 - prev;
          const next = prev + Math.max(0.3, gap * 0.04);
          return next > 90 ? 90 : next;
        });
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }
    // Not busy any more — complete the bar, then hide it.
    setProgress(100);
    const t = setTimeout(() => {
      setProgressVisible(false);
      setProgress(0);
    }, 250);
    return () => clearTimeout(t);
  }, [isBusy]);

  const hasEdits = Object.keys(editedCells).length > 0;
  // A draft insert only counts as "pending" once it actually holds data. Just
  // clicking a blank filler cell creates an all-null draft (so the editor can
  // open there) — that alone must NOT pop the Save/Discard bar. We treat a
  // draft as real when any column has a non-null, non-empty value.
  const nonEmptyInserts = pendingInserts.filter(rowHasData);
  const hasPending =
    hasEdits || pendingDeletes.size > 0 || nonEmptyInserts.length > 0;
  // Refs let the keyboard handler read current values without re-subscribing
  // on every edit stroke.
  const activeEditRef = useRef(activeEdit);
  activeEditRef.current = activeEdit;
  const hasPendingRef = useRef(hasPending);
  hasPendingRef.current = hasPending;
  const isCommittingRef = useRef(isCommitting);
  isCommittingRef.current = isCommitting;
  const columnKindsRef = useRef(columnKinds);
  columnKindsRef.current = columnKinds;

  // Browser-level unload guard — asks the user to confirm before navigating
  // away / reloading the window when there are uncommitted changes. The
  // custom message is ignored by modern browsers (they show a generic one)
  // but setting returnValue is still required to trigger the prompt.
  useEffect(() => {
    if (!hasPending) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasPending]);

  const pendingSummary = (() => {
    const parts: string[] = [];
    // Count only drafts with real data — blank drafts (from clicking an empty
    // cell) aren't "pending" and shouldn't inflate the summary.
    if (nonEmptyInserts.length > 0) {
      parts.push(
        `${nonEmptyInserts.length} new row${nonEmptyInserts.length === 1 ? "" : "s"}`,
      );
    }
    if (hasEdits) {
      const n = Object.keys(editedCells).length;
      parts.push(`${n} cell edit${n === 1 ? "" : "s"}`);
    }
    if (pendingDeletes.size > 0) {
      parts.push(
        `${pendingDeletes.size} row${pendingDeletes.size === 1 ? "" : "s"} marked for deletion`,
      );
    }
    return parts.join(", ");
  })();

  const copySelectedRows = useCallback(async () => {
    if (selectedRows.size === 0) return;
    const cols = displayCols;
    if (cols.length === 0) return;

    // Copy rows in their current rendered order.
    const picked = rowsForView.filter((r) => selectedRows.has(r.__rowId));
    if (picked.length === 0) return;

    // Spreadsheet-style TSV: any cell containing a tab, newline, or
    // double-quote must be wrapped in `"..."` with internal quotes
    // doubled. Without this, multi-line text fields turn a single row
    // into multiple paste rows in Excel / Google Sheets / Numbers.
    const escapeCell = (s: string): string => {
      if (s === "") return "";
      if (/[\t\n\r"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const cellOf = (row: GridRow, col: string): string => {
      const isDraft = row.__rowId.startsWith("new:");
      const key = `${row.__rowId}${KEY_SEP}${col}`;
      const raw = isDraft
        ? row[col]
        : editedCells[key] !== undefined
          ? editedCells[key]
          : row[col];
      if (raw === null || raw === undefined) return "";
      if (typeof raw === "object") return JSON.stringify(raw);
      return String(raw);
    };

    // Single-row copy: emit just the row, no header. A header makes
    // sense for batch copy (preserves name mapping on paste) but turns
    // a single-row copy into a 2-row paste in spreadsheets.
    const lines: string[] = [];
    if (picked.length > 1) lines.push(cols.map(escapeCell).join("\t"));
    for (const row of picked) {
      lines.push(cols.map((c) => escapeCell(cellOf(row, c))).join("\t"));
    }

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success(
        `Copied ${picked.length} row${picked.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(`Copy failed: ${String(e)}`);
    }
  }, [selectedRows, displayCols, rowsForView, editedCells]);

  // Keyboard shortcuts: Delete/Backspace queues selected rows for deletion,
  // Escape clears the selection, ⌘/Ctrl+S commits pending changes,
  // ⌘/Ctrl+Z undoes, ⌘/Ctrl+Shift+Z (or ⌘Y on non-Mac) redoes. Skip while
  // the user is typing in an input or editing a cell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inEditable =
        tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        if (viewMode !== "table") return;
        if (isCommitting) return;
        e.preventDefault();
        // If the user is mid-edit, flush that cell first — but only if its
        // value is valid for the column type. Matches the button path where
        // the editor's onBlur validator drops invalid edits silently.
        const ae = activeEditRef.current;
        if (ae) {
          const kind = columnKindsRef.current[ae.col] ?? { kind: "text" };
          if (validateEditorValue(kind, ae.value) === null) {
            commitActiveEdit();
          } else {
            // Invalid active edit — cancel it so it doesn't poison the commit.
            cancelActiveEdit();
            toast.error(`Skipped invalid edit in ${ae.col}`);
          }
          setTimeout(() => {
            if (hasPendingRef.current && !isCommittingRef.current)
              void handleCommit();
          }, 0);
          return;
        }
        if (!hasPending) return;
        void handleCommit();
        return;
      }
      if (mod && !e.shiftKey && key === "z") {
        if (viewMode !== "table") return;
        if (undoStackRef.current.length === 0) return;
        e.preventDefault();
        undo();
        return;
      }
      if (mod && ((e.shiftKey && key === "z") || key === "y")) {
        if (viewMode !== "table") return;
        if (redoStackRef.current.length === 0) return;
        e.preventDefault();
        redo();
        return;
      }
      if (inEditable) return;
      if (viewMode !== "table") return;
      if (mod && key === "c" && selectedRows.size > 0) {
        e.preventDefault();
        void copySelectedRows();
        return;
      }
      if (e.key === "Escape" && selectedRows.size > 0) {
        setSelectedRows(new Set());
        setLastSelectedRowId(null);
        return;
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedRows.size > 0
      ) {
        e.preventDefault();
        queueDeleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedRows,
    viewMode,
    structure,
    data.rows,
    hasPending,
    isCommitting,
    copySelectedRows,
  ]);

  /**
   * Translate the grid's `FilterCondition` set into adapter-intent filters.
   * Ops map 1:1 except for `is_empty` / `is_not_empty` — the adapter trait
   * speaks in NULL semantics; an empty-string row won't match `is_null`.
   * That's a minor behavior change from the old SQL-building path and we
   * accept it: the adapter is the right layer to grow richer emptiness
   * semantics per database.
   */
  const toBrowseFilters = (): BrowseFilter[] => {
    return activeFilters.map((f) => {
      const op: BrowseFilterOp = (() => {
        switch (f.op) {
          case "eq":
            return "eq";
          case "neq":
            return "not_eq";
          case "contains":
            return "contains";
          case "starts_with":
            return "starts_with";
          case "ends_with":
            return "ends_with";
          case "gt":
            return "gt";
          case "lt":
            return "lt";
          case "is_empty":
            return "is_null";
          case "is_not_empty":
            return "is_not_null";
        }
      })();
      if (op === "is_null" || op === "is_not_null") {
        return { column: f.column, op };
      }
      // For gt/lt coerce numeric-looking strings to numbers so the adapter
      // binds them as numbers, not strings (MySQL's implicit-cast behavior
      // is fine but explicit is friendlier for non-MySQL adapters).
      const n = Number(f.value);
      const value =
        (op === "gt" || op === "lt") && f.value !== "" && Number.isFinite(n)
          ? n
          : f.value;
      return { column: f.column, op, value };
    });
  };

  const buildStatement = (): string => {
    if (isDocumentStore) {
      const filterObj: Record<string, unknown> = {};
      activeFilters.forEach((f) => {
        const key = f.column;
        switch (f.op) {
          case "eq":
            filterObj[key] = f.value;
            break;
          case "neq":
            filterObj[key] = { $ne: f.value };
            break;
          case "contains":
            filterObj[key] = { $regex: f.value, $options: "i" };
            break;
          case "starts_with":
            filterObj[key] = { $regex: `^${f.value}`, $options: "i" };
            break;
          case "ends_with":
            filterObj[key] = { $regex: `${f.value}$`, $options: "i" };
            break;
          case "gt":
            filterObj[key] = {
              $gt: isNaN(Number(f.value)) ? f.value : Number(f.value),
            };
            break;
          case "lt":
            filterObj[key] = {
              $lt: isNaN(Number(f.value)) ? f.value : Number(f.value),
            };
            break;
          case "is_empty":
            filterObj[key] = { $in: [null, ""] };
            break;
          case "is_not_empty":
            filterObj[key] = { $nin: [null, ""] };
            break;
        }
      });
      const sortObj: Record<string, 1 | -1> = {};
      if (activeServerSort) {
        sortObj[activeServerSort.column] =
          activeServerSort.direction === "desc" ? -1 : 1;
      }
      const offset = Math.max(0, (page - 1) * Number(limit));
      const scopedCollection = tableName
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'");
      const sortClause =
        Object.keys(sortObj).length > 0
          ? `.sort(${JSON.stringify(sortObj)})`
          : "";
      const skipClause = offset > 0 ? `.skip(${offset})` : "";
      return `db.getCollection('${scopedCollection}').find(${JSON.stringify(filterObj)})${sortClause}${skipClause}.limit(${limit});`;
    }

    // Adapters whose query editor speaks shell-style commands (Redis)
    // build a SCAN preview here. Match on the manifest's editor language
    // rather than the driver name so a new shell-style adapter just
    // works.
    if (activeManifest?.queryEditor?.language === "shell") {
      const patt = tableName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      return `SCAN 0 MATCH '${patt}*' COUNT ${limit}`;
    }

    const qualified = schema ? `${qi(schema)}.${qi(tableName)}` : qi(tableName);
    const projection =
      queryProjectionCols && queryProjectionCols.length > 0
        ? queryProjectionCols.map((col) => qi(col)).join(", ")
        : "*";
    const where = activeFilters
      .map((f) => {
        const col = qi(f.column);
        const v = f.value.replace(/'/g, "''");
        switch (f.op) {
          case "eq":
            return `${col} = '${v}'`;
          case "neq":
            return `${col} <> '${v}'`;
          case "contains":
            return `${col} LIKE '%${v}%'`;
          case "starts_with":
            return `${col} LIKE '${v}%'`;
          case "ends_with":
            return `${col} LIKE '%${v}'`;
          case "gt":
            return `${col} > ${isNaN(Number(f.value)) ? `'${v}'` : f.value}`;
          case "lt":
            return `${col} < ${isNaN(Number(f.value)) ? `'${v}'` : f.value}`;
          case "is_empty":
            return `(${col} IS NULL OR ${col} = '')`;
          case "is_not_empty":
            return `(${col} IS NOT NULL AND ${col} <> '')`;
        }
      })
      .join(" AND ");
    const orderBy = activeServerSort
      ? ` ORDER BY ${qi(activeServerSort.column)} ${activeServerSort.direction === "desc" ? "DESC" : "ASC"}`
      : "";
    const offset = Math.max(0, (page - 1) * Number(limit));
    const offsetClause = offset > 0 ? ` OFFSET ${offset}` : "";
    return `SELECT ${projection} FROM ${qualified}${where ? ` WHERE ${where}` : ""}${orderBy} LIMIT ${limit}${offsetClause};`;
  };

  const runRefresh = () => {
    setEditedCells({});
    setActiveEdit(null);
    setPendingDeletes(new Set());
    setPendingInserts([]);
    setSelectedRows(new Set());
    setLastSelectedRowId(null);
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryTick((t) => t + 1);
    // Explicit refresh invalidates the tab cache — next mount won't short
    // circuit. The fetch below will repopulate it with fresh rows.
    if (tabId) clearCachedGrid(tabId);
    void fetchData({ showRefresh: true });
  };

  const handleRefresh = () => {
    if (hasPending) {
      setConfirmRefreshOpen(true);
      return;
    }
    runRefresh();
  };

  const snapshot = (): HistorySnapshot => ({
    edits: { ...editedCells },
    deletes: Array.from(pendingDeletes),
    inserts: pendingInserts.map((r) => ({ ...r })),
  });

  const pushHistory = () => {
    undoStackRef.current.push(snapshot());
    // Any new mutation invalidates the redo stack, like every text editor.
    redoStackRef.current = [];
    // Cap history at a reasonable depth so we don't grow unbounded on heavy sessions.
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    setHistoryTick((t) => t + 1);
  };

  const applySnapshot = (s: HistorySnapshot) => {
    setEditedCells(s.edits);
    setPendingDeletes(new Set(s.deletes));
    setPendingInserts(s.inserts.map((r) => ({ ...r })));
  };

  const undo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(snapshot());
    applySnapshot(prev);
    setHistoryTick((t) => t + 1);
  };

  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(snapshot());
    applySnapshot(next);
    setHistoryTick((t) => t + 1);
  };

  const handleCellEdit = (rowId: string, col: string, value: string) => {
    // Edits to draft rows (pendingInserts) are stored on the insert record
    // itself — we don't diff against a persisted row value.
    if (rowId.startsWith("new:")) {
      pushHistory();
      setPendingInserts((prev) =>
        prev.map((r) => (r.__rowId === rowId ? { ...r, [col]: value } : r)),
      );
      return;
    }
    const originalValue = data.rows.find((r) => r.__rowId === rowId)?.[col];
    pushHistory();
    if (String(originalValue) === value) {
      const newEdits = { ...editedCells };
      delete newEdits[`${rowId}${KEY_SEP}${col}`];
      setEditedCells(newEdits);
    } else {
      setEditedCells((prev) => ({
        ...prev,
        [`${rowId}${KEY_SEP}${col}`]: value,
      }));
    }
  };

  // Queue the selected rows for deletion. Nothing hits the DB until commit.
  // Pending-insert rows are just dropped from the draft list — there's no
  // row in the DB to queue a delete for.
  const queueDeleteSelected = () => {
    if (selectedRows.size === 0) return;
    pushHistory();
    const draftIds = new Set<string>();
    const persistedIds = new Set<string>();
    for (const id of selectedRows) {
      if (id.startsWith("new:")) draftIds.add(id);
      else persistedIds.add(id);
    }
    if (persistedIds.size > 0) {
      setPendingDeletes((prev) => {
        const next = new Set(prev);
        for (const id of persistedIds) next.add(id);
        return next;
      });
    }
    if (draftIds.size > 0) {
      setPendingInserts((prev) => prev.filter((r) => !draftIds.has(r.__rowId)));
      setEditedCells((prev) => {
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(prev)) {
          const sep = k.indexOf(KEY_SEP);
          const rid = k.slice(0, sep);
          if (!draftIds.has(rid)) next[k] = v;
        }
        return next;
      });
    }
    setSelectedRows(new Set());
    setLastSelectedRowId(null);
  };

  const undoRowDelete = (rowId: string) => {
    pushHistory();
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
  };

  // Append a blank row at the bottom of the grid. It lives in pendingInserts
  // until commit flushes it as an INSERT. The user edits its cells the normal
  // way — activeEdit / editedCells treats it like any fetched row.
  const addNewRow = () => {
    pushHistory();
    const id = `new:${crypto.randomUUID()}`;
    const blank: GridRow = { __rowId: id };
    if (structure) for (const c of structure.columns) blank[c.name] = null;
    else for (const c of data.cols) blank[c] = null;
    setPendingInserts((prev) => [...prev, blank]);
    setSelectedRows(new Set([id]));
    setLastSelectedRowId(id);
    // Wait a frame for React to paint the new <tr>, then scroll it into
    // view. `rAF` guarantees layout is up to date before we look up the
    // DOM node — otherwise we'd query before it's in the table.
    requestAnimationFrame(() => {
      const el = document.querySelector(`tr[data-row-id="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  // Spreadsheet-style insert: clicking any blank filler cell starts a NEW row
  // and opens the clicked column for editing immediately. Same draft machinery
  // as the "Add row" button (a `new:` row in pendingInserts, flushed as an
  // INSERT on commit) — the draft appears at the top of the blank zone.
  const beginInsertAt = (col: string) => {
    if (!structure && data.cols.length === 0) return; // no columns yet → nothing to insert into
    pushHistory();
    const id = `new:${crypto.randomUUID()}`;
    const blank: GridRow = { __rowId: id };
    if (structure) for (const c of structure.columns) blank[c.name] = null;
    else for (const c of data.cols) blank[c] = null;
    setPendingInserts((prev) => [...prev, blank]);
    setSelectedRows(new Set([id]));
    setLastSelectedRowId(id);
    // Open the clicked column for editing right away (setActiveEdit directly —
    // beginEdit is declared later in the component).
    setActiveEdit({ rowId: id, col, value: "" });
  };

  // Paste TSV/CSV rows as draft inserts. We map by header names when the first
  // row looks like column labels; otherwise map positionally from column 1.
  const pasteRows = useCallback(
    (raw: string) => {
      if (viewMode !== "table" || !structure || isCommitting) return;
      const parsed = parseClipboardTable(raw);
      if (parsed.length === 0) return;

      const tableCols = structure.columns.map((c) => c.name);
      if (tableCols.length === 0) return;

      const lowerToCol = new Map(tableCols.map((c) => [c.toLowerCase(), c]));
      const first = parsed[0].map((c) => c.trim().toLowerCase());
      const headerHits = first.filter((c) => lowerToCol.has(c)).length;
      const looksLikeHeader =
        headerHits >=
        Math.max(1, Math.ceil(Math.min(first.length, tableCols.length) * 0.6));
      const body = looksLikeHeader ? parsed.slice(1) : parsed;
      if (body.length === 0) return;

      pushHistory();
      const createdIds: string[] = [];
      const drafts: GridRow[] = body.map((row) => {
        const id = `new:${crypto.randomUUID()}`;
        createdIds.push(id);
        const draft: GridRow = { __rowId: id };
        for (const c of structure.columns) draft[c.name] = null;

        if (looksLikeHeader) {
          parsed[0].forEach((h, idx) => {
            const col = lowerToCol.get(h.trim().toLowerCase());
            if (!col || idx >= row.length) return;
            draft[col] = row[idx];
          });
        } else {
          for (let i = 0; i < Math.min(tableCols.length, row.length); i++) {
            draft[tableCols[i]] = row[i];
          }
        }
        return draft;
      });

      setPendingInserts((prev) => [...prev, ...drafts]);
      setSelectedRows(new Set(createdIds));
      setLastSelectedRowId(createdIds[createdIds.length - 1] ?? null);
      toast.success(
        `Pasted ${drafts.length} row${drafts.length === 1 ? "" : "s"} as draft`,
      );
    },
    [viewMode, structure, isCommitting, pushHistory],
  );

  // Global paste capture for table view. If the focus is inside a cell editor
  // we do nothing so regular text paste works as expected there.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (viewMode !== "table") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        !!target?.isContentEditable ||
        !!target?.closest('input, textarea, select, [contenteditable="true"]');
      if (inEditable) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      e.preventDefault();
      pasteRows(text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [viewMode, pasteRows]);

  // Auto-remove a draft insert IFF it still holds no data. Called when the
  // user opens a blank draft (by clicking an empty cell) then leaves without
  // typing — keeps phantom empty rows out of `pendingInserts` so the
  // Save/Discard bar doesn't appear for a no-op click. Not an undo step.
  const discardEmptyDraft = (rowId: string) => {
    setPendingInserts((prev) => {
      const draft = prev.find((r) => r.__rowId === rowId);
      if (!draft || rowHasData(draft)) return prev; // real data → keep it
      return prev.filter((r) => r.__rowId !== rowId);
    });
    setSelectedRows((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
    setLastSelectedRowId((prev) => (prev === rowId ? null : prev));
  };

  const discardInsert = (rowId: string) => {
    pushHistory();
    setPendingInserts((prev) => prev.filter((r) => r.__rowId !== rowId));
    // Purge any edits that were queued against the removed draft row.
    setEditedCells((prev) => {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(`${rowId}${KEY_SEP}`)) next[k] = v;
      }
      return next;
    });
  };

  const discardAll = () => {
    // Treat Discard as a single-step history event so it's reversible via undo.
    pushHistory();
    setEditedCells({});
    setActiveEdit(null);
    setPendingDeletes(new Set());
    setPendingInserts([]);
  };

  const handleCommit = async () => {
    if (!structure) {
      toast.error("Cannot commit: table structure unavailable");
      return;
    }
    if (structure.primaryKey.length === 0) {
      toast.error("Cannot commit: table has no primary key");
      return;
    }
    const edits = Object.entries(editedCells).filter(([key]) => {
      // Skip edits for rows already queued for deletion — the delete wins.
      const sep = key.indexOf(KEY_SEP);
      const rowId = key.slice(0, sep);
      return !pendingDeletes.has(rowId);
    });
    const deletes = Array.from(pendingDeletes)
      .map((id) => data.rows.find((r) => r.__rowId === id))
      .filter((r): r is GridRow => !!r);
    // Only commit drafts that actually hold data. Blank drafts (from clicking
    // an empty cell without typing) are dropped here so they neither trip the
    // required-field check nor INSERT an empty row.
    const inserts = pendingInserts.filter(rowHasData);
    if (edits.length === 0 && deletes.length === 0 && inserts.length === 0)
      return;

    // Group edits by row. Skip any column that isn't in the base table's
    // schema — for example, a SELECT alias or a view column that doesn't map
    // back to the underlying table would otherwise produce
    // "Unknown column '…' in 'field list'" at the server.
    const realCols = new Set(structure.columns.map((c) => c.name));
    const byRow = new Map<string, Record<string, unknown>>();
    const skipped: string[] = [];
    for (const [key, value] of edits) {
      const sep = key.indexOf(KEY_SEP);
      const rowId = key.slice(0, sep);
      const col = key.slice(sep + 1);
      if (!realCols.has(col)) {
        skipped.push(col);
        continue;
      }
      const bucket = byRow.get(rowId) ?? {};
      bucket[col] = coerceForColumn(
        columnKinds[col] ?? { kind: "text" },
        value,
        booleanFormat,
      );
      byRow.set(rowId, bucket);
    }
    if (skipped.length > 0) {
      const unique = Array.from(new Set(skipped));
      toast.error(
        `Skipped edits for column${unique.length === 1 ? "" : "s"} not in ${structure.name}: ${unique.join(", ")}`,
      );
    }

    setIsCommitting(true);
    try {
      // Apply updates first so a delete of an updated row still makes sense.
      for (const [rowId, changes] of byRow) {
        const row = data.rows.find((r) => r.__rowId === rowId);
        if (!row) continue;
        const primaryKey = structure.primaryKey.map((col) => ({
          column: col,
          value: row[col],
        }));
        await db.updateRows(connectionId, {
          schema: structure.schema,
          table: structure.name,
          primaryKey,
          changes,
        });
      }

      // Flush deletes through the structured mutate API — one call per row.
      // Going through the SQL text protocol would force us to synthesize
      // dialect-specific DELETE statements on the frontend, which doesn't
      // work for non-SQL adapters like Redis. The adapter side translates
      // each call into its native delete primitive (DEL / DELETE FROM / …).
      if (deletes.length > 0) {
        const started = performance.now();
        let affected = 0;
        try {
          for (const row of deletes) {
            const primaryKey = structure.primaryKey.map((col) => ({
              column: col,
              value: row[col],
            }));
            const res = await db.deleteRows(connectionId, {
              schema: structure.schema,
              table: structure.name,
              primaryKey,
            });
            affected += res.rowsAffected;
          }
        } catch (err) {
          const msg = isDbError(err) ? err.message : String(err);
          onLogQuery?.(
            `delete ${deletes.length} row${deletes.length === 1 ? "" : "s"}`,
            {
              source: "grid",
              status: "error",
              message: msg,
              durationMs: performance.now() - started,
            },
          );
          toast.error(`Delete failed: ${msg}`);
          return;
        }
        const elapsed = performance.now() - started;
        onLogQuery?.(
          `delete ${deletes.length} row${deletes.length === 1 ? "" : "s"}`,
          {
            source: "grid",
            status: "ok",
            durationMs: elapsed,
            message: `${affected} row${affected === 1 ? "" : "s"} deleted`,
          },
        );
      }

      // Finally flush inserts. Each draft becomes one INSERT, batched through
      // the text protocol so all statements share a round trip. Columns with
      // `null` values are omitted so DEFAULT / AUTO_INCREMENT can take over
      // — the user explicitly clearing a cell to `NULL` still emits NULL via
      // the string `"NULL"` (same convention as the Set-to-NULL menu item).
      let insertCount = 0;
      if (inserts.length > 0) {
        // NOT-NULL columns without a server-side default must be filled by
        // the user (or via AUTO_INCREMENT) before we can send the INSERT.
        // Catch this here with a clear message instead of letting the server
        // reject the whole batch with "Field 'X' doesn't have a default".
        const isAutoIncrement = (extra?: string) =>
          !!extra && /auto_increment/i.test(extra);
        const requiredCols = structure.columns.filter(
          (c) =>
            // Skip the auto-managed primary-key column declared in the
            // manifest (e.g. Mongo's `_id`) — adapters that auto-generate
            // it shouldn't force the user to provide it in draft rows.
            c.name !== hideColumnInGrid &&
            !c.nullable &&
            c.default === null &&
            !isAutoIncrement(c.extra),
        );
        const missing: { rowIndex: number; cols: string[] }[] = [];
        inserts.forEach((draft, i) => {
          const gaps: string[] = [];
          for (const c of requiredCols) {
            const v = draft[c.name];
            if (v === undefined || v === null || v === "") gaps.push(c.name);
          }
          if (gaps.length) missing.push({ rowIndex: i + 1, cols: gaps });
        });
        if (missing.length > 0) {
          const first = missing[0];
          toast.error(
            `New row ${first.rowIndex} is missing required field${first.cols.length === 1 ? "" : "s"}: ${first.cols.join(", ")}`,
            {
              description:
                missing.length > 1
                  ? `${missing.length} draft rows need attention`
                  : undefined,
            },
          );
          return;
        }

        const started = performance.now();
        try {
          for (const draft of inserts) {
            const values: Record<string, unknown> = {};
            for (const c of structure.columns) {
              const raw = draft[c.name];
              // Omit empty values so adapter/backend can apply defaults and
              // auto-generated keys where supported.
              if (raw === undefined || raw === null || raw === "") continue;
              values[c.name] = coerceForColumn(
                columnKinds[c.name] ?? { kind: "text" },
                raw,
                booleanFormat,
              );
            }
            await db.insertRows(connectionId, {
              schema: structure.schema,
              table: structure.name,
              values,
            });
          }
        } catch (err) {
          const msg = isDbError(err) ? err.message : String(err);
          onLogQuery?.(
            `insert ${inserts.length} row${inserts.length === 1 ? "" : "s"} into ${structure.schema}.${structure.name}`,
            {
              source: "grid",
              status: "error",
              message: msg,
              durationMs: performance.now() - started,
            },
          );
          toast.error(`Insert failed: ${msg}`);
          return;
        }
        insertCount = inserts.length;
        const elapsed = performance.now() - started;
        onLogQuery?.(
          `insert ${insertCount} row${insertCount === 1 ? "" : "s"} into ${structure.schema}.${structure.name}`,
          {
            source: "grid",
            status: "ok",
            durationMs: elapsed,
            message: `${insertCount} row${insertCount === 1 ? "" : "s"} inserted`,
          },
        );
      }

      const parts: string[] = [];
      if (insertCount > 0)
        parts.push(
          `${insertCount} row${insertCount === 1 ? "" : "s"} inserted`,
        );
      if (edits.length > 0)
        parts.push(
          `${edits.length} cell${edits.length === 1 ? "" : "s"} updated`,
        );
      if (deletes.length > 0)
        parts.push(
          `${deletes.length} row${deletes.length === 1 ? "" : "s"} deleted`,
        );
      toast.success(`Committed — ${parts.join(", ")}`);
      setEditedCells({});
      setPendingDeletes(new Set());
      setPendingInserts([]);
      await fetchData({ showRefresh: true });
    } catch (err) {
      toast.error(isDbError(err) ? err.message : String(err));
    } finally {
      setIsCommitting(false);
    }
  };

  // Persist edits the user made directly in the JSON Tree editor. The view
  // is currently Mongo-only and shows raw documents (no synthetic
  // `__rowId`), so we match each edited entry back to its original by
  // Mongo's `_id` — the actual document identifier and the collection's
  // primary key. Only fields that actually changed are sent: we deep-diff
  // each parsed document against the original and put only the differing
  // keys into the `changes` payload. `_id` itself is never written back
  // (immutable in Mongo), and any field not declared in `structure.columns`
  // is silently dropped with a one-shot notice.
  const handleSaveJsonEdits = async () => {
    const editor = jsonEditorRef.current;
    if (!editor) return;
    if (!structure) {
      toast.error("Cannot save: collection structure unavailable");
      return;
    }
    if (structure.primaryKey.length === 0) {
      toast.error("Cannot save: collection has no primary key");
      return;
    }
    // Validation errors surface via the inline error strip — single source
    // of truth, no duplicate toast.
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.getValue());
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!Array.isArray(parsed)) {
      setJsonError("Top-level value must be an array of document objects.");
      return;
    }
    // Build an _id → original lookup so the user can reorder rows freely
    // — what binds an edit to a document is its identity, not its position.
    const pkCols = structure.primaryKey;
    const idCol = pkCols[0]; // For Mongo this is "_id".
    const idKey = (rec: Record<string, unknown>) => JSON.stringify(rec[idCol]);
    const originalsById = new Map<string, GridRow>();
    for (const row of rowsForView) {
      originalsById.set(idKey(row), row);
    }
    const realCols = new Set(structure.columns.map((c) => c.name));
    const pkColSet = new Set(pkCols);
    type Patch = {
      primaryKey: Array<{ column: string; value: unknown }>;
      changes: Record<string, unknown>;
    };
    const patches: Patch[] = [];
    const skippedCols = new Set<string>();
    const seenIds = new Set<string>();
    for (let i = 0; i < parsed.length; i++) {
      const edited = parsed[i];
      if (!edited || typeof edited !== "object" || Array.isArray(edited)) {
        setJsonError(`Document at position ${i} is not an object.`);
        return;
      }
      const editedRec = edited as Record<string, unknown>;
      const editedId = editedRec[idCol];
      if (editedId === undefined) {
        setJsonError(
          `Document at position ${i} is missing "${idCol}". ` +
            `Each document needs its "${idCol}" so edits can be matched back to the original.`,
        );
        return;
      }
      const lookup = idKey(editedRec);
      if (seenIds.has(lookup)) {
        setJsonError(
          `Duplicate "${idCol}" ${String(editedId)} appears more than once.`,
        );
        return;
      }
      seenIds.add(lookup);
      const original = originalsById.get(lookup);
      if (!original) {
        setJsonError(
          `Document with "${idCol}" ${String(editedId)} is not in the original result set. ` +
            `Adding new documents from the JSON view isn't supported — use the table view's insert flow.`,
        );
        return;
      }
      const changes: Record<string, unknown> = {};
      // Deep-diff via JSON comparison — fine for `browse` output (plain JSON,
      // no Date/Map/etc.) and matches what the user sees in the editor.
      const keys = new Set<string>([
        ...Object.keys(original),
        ...Object.keys(editedRec),
      ]);
      for (const key of keys) {
        if (key === "__rowId") continue; // Stripped from the view; ignore if user re-added it.
        if (pkColSet.has(key)) {
          // _id is immutable in Mongo; we never write it back.
          if (
            JSON.stringify(editedRec[key]) !== JSON.stringify(original[key])
          ) {
            setJsonError(
              `Document ${String(editedId)}: "${key}" was changed. ` +
                `Mongo's "${key}" is immutable — delete the document and insert a new one with the new value.`,
            );
            return;
          }
          continue;
        }
        if (!realCols.has(key)) {
          if (
            JSON.stringify(editedRec[key]) !== JSON.stringify(original[key])
          ) {
            skippedCols.add(key);
          }
          continue;
        }
        if (JSON.stringify(editedRec[key]) !== JSON.stringify(original[key])) {
          changes[key] = coerceForColumn(
            columnKinds[key] ?? { kind: "text" },
            editedRec[key],
            booleanFormat,
          );
        }
      }
      if (Object.keys(changes).length === 0) continue;
      const primaryKey = pkCols.map((col) => ({
        column: col,
        value: original[col],
      }));
      patches.push({ primaryKey, changes });
    }
    // Detect deletes: any original whose _id no longer appears in the parsed
    // array. Reject — deletes go through the table view's delete flow, which
    // confirms before issuing.
    if (seenIds.size < originalsById.size) {
      const missing = [...originalsById.keys()].filter((k) => !seenIds.has(k));
      setJsonError(
        `${missing.length} document${missing.length === 1 ? "" : "s"} removed from the JSON view. ` +
          `Deleting from here isn't supported — use the table view's delete flow.`,
      );
      return;
    }
    if (skippedCols.size > 0) {
      toast.message(
        `Skipped column${skippedCols.size === 1 ? "" : "s"} not in ${structure.name}: ${Array.from(skippedCols).join(", ")}`,
      );
    }
    if (patches.length === 0) {
      toast.message("No changes to save");
      setJsonDirty(false);
      setJsonError(null);
      return;
    }
    setJsonSaving(true);
    const started = performance.now();
    try {
      let totalCells = 0;
      for (const patch of patches) {
        await db.updateRows(connectionId, {
          schema: structure.schema,
          table: structure.name,
          primaryKey: patch.primaryKey,
          changes: patch.changes,
        });
        totalCells += Object.keys(patch.changes).length;
      }
      const elapsed = performance.now() - started;
      onLogQuery?.(
        `update ${patches.length} row${patches.length === 1 ? "" : "s"} in ${structure.schema}.${structure.name}`,
        {
          source: "grid",
          status: "ok",
          durationMs: elapsed,
          message: `${totalCells} cell${totalCells === 1 ? "" : "s"} across ${patches.length} row${patches.length === 1 ? "" : "s"}`,
        },
      );
      toast.success(
        `Saved ${totalCells} cell${totalCells === 1 ? "" : "s"} across ${patches.length} row${patches.length === 1 ? "" : "s"}`,
      );
      setJsonDirty(false);
      setJsonError(null);
      await fetchData({ showRefresh: true });
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      onLogQuery?.(
        `update ${patches.length} row${patches.length === 1 ? "" : "s"} in ${structure.schema}.${structure.name}`,
        {
          source: "grid",
          status: "error",
          message: msg,
          durationMs: performance.now() - started,
        },
      );
      toast.error(`Save failed: ${msg}`);
    } finally {
      setJsonSaving(false);
    }
  };

  // Keep the Cmd/Ctrl+S keybinding pointing at the current save closure.
  // Monaco's `addCommand` captures its handler at bind time, so we route
  // through this ref — the ref body re-evaluates each render with fresh
  // state, while the bound command stays the same.
  jsonSaveRef.current = () => {
    if (jsonSaving || jsonError || !jsonDirty) return;
    void handleSaveJsonEdits();
  };

  const handleExport = async (config: ExportConfig) => {
    const ext = config.format + (config.gzip ? ".gz" : "");
    const first = config.targets[0];
    const safeTarget =
      config.targets.length === 1
        ? `${first.schema}_${first.table}`.replace(/[^\w.-]+/g, "_")
        : `${first.schema}_export`.replace(/[^\w.-]+/g, "_");
    const baseFilter =
      config.format === "json"
        ? { name: "JSON", extensions: config.gzip ? ["json.gz"] : ["json"] }
        : config.format === "sql"
          ? { name: "SQL", extensions: config.gzip ? ["sql.gz"] : ["sql"] }
          : { name: "CSV", extensions: config.gzip ? ["csv.gz"] : ["csv"] };
    const path = await saveDialog({
      title: "Export data",
      defaultPath: `${safeTarget}.${ext}`,
      filters: [baseFilter],
    });
    if (!path) return;

    exportCancelRef.current = false;
    setExportProgress({ rows: 0, total: null, table: first.table });
    const splitBytes = config.splitMb != null ? config.splitMb * 1024 * 1024 : null;
    try {
      const parts = await streamExport(config, path, splitBytes);
      if (exportCancelRef.current) {
        toast.message("Export canceled — partial file(s) written.");
      } else {
        const what = `${config.targets.length.toLocaleString()} ${config.targets.length === 1 ? "table" : "tables"}`;
        const extras = [
          config.gzip ? "gzip" : null,
          parts > 1 ? `${parts} parts` : null,
        ].filter(Boolean);
        toast.success(`Exported ${what}${extras.length ? ` (${extras.join(", ")})` : ""}`);
      }
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      toast.error(`Export failed: ${msg}`);
      throw err;
    } finally {
      setExportProgress(null);
    }
  };

  // Streams the export page-by-page so memory stays flat regardless of table
  // size. Splits into part files when `splitBytes` is set; each part is a valid
  // standalone file (CSV re-emits the header, SQL re-emits the table comment +
  // CREATE, JSON parts are independent arrays). Returns the number of parts.
  const streamExport = async (
    config: ExportConfig,
    path: string,
    splitBytes: number | null,
  ): Promise<number> => {
    if (config.format === "csv") {
      // CSV: single table (enforced by the modal). Re-emit the header at the
      // top of every part so each file opens cleanly in a spreadsheet.
      const target = config.targets[0];
      let header: string | null = null;
      const writer = await ExportWriter.create(path, config.gzip, splitBytes, {
        onNewPart: async () => {
          if (config.includeHeader && header) await writer.write(header + "\n");
        },
      });
      try {
        await streamRowsForExport(target.schema, target.table, async (cols, rows, isFirstPage) => {
          if (isFirstPage) {
            header = cols.map(csvCell).join(",");
            if (config.includeHeader) await writer.write(header + "\n");
          }
          for (const row of rows) {
            await writer.write(cols.map((c) => csvCell(row[c])).join(",") + "\n");
            await writer.maybeRollover();
          }
        });
        return writer.parts;
      } finally {
        await writer.close();
      }
    }

    if (config.format === "json") {
      // Each part is its own standalone JSON array; rollover only happens
      // between top-level elements so files never split mid-object. The
      // bracket bookkeeping lives in `arrayOpen`/`arrayHasItems` so the
      // rollover hooks and the per-table transitions stay in sync — `onEndPart`
      // closes the array only if one is currently open, and `onNewPart` opens a
      // fresh one for the rows that continue in the next part.
      let arrayOpen = false;
      let arrayHasItems = false;
      const openArray = async () => {
        await writer.write("[");
        arrayOpen = true;
        arrayHasItems = false;
      };
      const closeArray = async () => {
        if (!arrayOpen) return;
        await writer.write(arrayHasItems ? "\n]\n" : "]\n");
        arrayOpen = false;
      };
      const writer = await ExportWriter.create(path, config.gzip, splitBytes, {
        onEndPart: closeArray,
        onNewPart: openArray,
      });
      try {
        for (const target of config.targets) {
          if (exportCancelRef.current) break;
          // Close the previous table's array (if any) and roll if oversized,
          // then open this table's array. Each table is its own JSON array.
          await closeArray();
          await writer.maybeRollover();
          await openArray();
          await streamRowsForExport(target.schema, target.table, async (cols, rows) => {
            for (const row of rows) {
              const obj: Record<string, unknown> = {};
              cols.forEach((c) => { obj[c] = row[c] ?? null; });
              await writer.write((arrayHasItems ? "," : "") + "\n  " + JSON.stringify(obj));
              arrayHasItems = true;
              await writer.maybeRollover();
            }
          });
        }
        await closeArray();
        return writer.parts;
      } finally {
        await writer.close();
      }
    }

    // SQL. On each new part, re-emit the current table's comment + CREATE so the
    // part runs standalone. We track the "current table preamble" in a ref the
    // onNewPart hook reads.
    let currentPreamble = "";
    const writer = await ExportWriter.create(path, config.gzip, splitBytes, {
      onNewPart: async () => { if (currentPreamble) await writer.write(currentPreamble); },
    });
    try {
      for (const target of config.targets) {
        if (exportCancelRef.current) break;
        const qualified = qualifiedTableName(target.schema, target.table);
        // Build this table's standalone preamble (comment + optional CREATE).
        let preamble = `-- ${target.schema}.${target.table}\n`;
        if (target.includeSchema) {
          const structure = await ensureTableStructure(connectionId, target.schema, target.table);
          preamble += buildCreateTableSql(structure) + "\n";
        }
        currentPreamble = preamble;
        await writer.write(`-- ${target.schema}.${target.table}\n`);
        if (target.dropIfExists) {
          await writer.write(`DROP TABLE IF EXISTS ${qualified};\n`);
        }
        if (target.includeSchema) {
          const structure = await ensureTableStructure(connectionId, target.schema, target.table);
          await writer.write(buildCreateTableSql(structure) + "\n");
        }
        if (target.includeData) {
          const structure = target.updateIfExists
            ? await ensureTableStructure(connectionId, target.schema, target.table)
            : null;
          await streamRowsForExport(target.schema, target.table, async (cols, rows) => {
            const sql = buildInsertSql(qualified, cols, rows, target.updateIfExists ? structure : null);
            if (sql) await writer.write(sql + "\n");
            await writer.maybeRollover();
          });
        }
        await writer.write("\n");
      }
      return writer.parts;
    } finally {
      await writer.close();
    }
  };

  const qualifiedTableName = (targetSchema: string, targetTable: string) =>
    targetSchema ? `${qi(targetSchema)}.${qi(targetTable)}` : qi(targetTable);

  const buildCreateTableSql = (table: TableStructure) => {
    const defs = table.columns.map((col) => {
      const parts = [qi(col.name), col.dataType || "TEXT"];
      if (!col.nullable) parts.push("NOT NULL");
      if (col.default !== null && col.default !== undefined) {
        parts.push(`DEFAULT ${col.default}`);
      }
      return `  ${parts.join(" ")}`;
    });
    if (table.primaryKey.length > 0) {
      defs.push(`  PRIMARY KEY (${table.primaryKey.map(qi).join(", ")})`);
    }
    return `CREATE TABLE ${qualifiedTableName(table.schema, table.name)} (\n${defs.join(",\n")}\n);`;
  };

  // Batched multi-row INSERTs: groups up to INSERT_BATCH rows into a single
  // `INSERT INTO t (...) VALUES (...),(...),...;` statement. Far smaller files
  // and dramatically faster to re-import than one statement per row. The upsert
  // clause (when requested) is appended once per batched statement.
  const INSERT_BATCH = 500;
  const buildInsertSql = (
    qualified: string,
    cols: string[],
    rows: Record<string, unknown>[],
    table: TableStructure | null,
  ) => {
    if (rows.length === 0 || cols.length === 0) return "";
    const colList = cols.map(qi).join(", ");
    const upsert = table ? buildUpsertClause(cols, table.primaryKey) : "";
    const out: string[] = [];
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const slice = rows.slice(i, i + INSERT_BATCH);
      const tuples = slice
        .map((row) => `(${cols.map((col) => sqlLiteral(row[col])).join(", ")})`)
        .join(",\n  ");
      out.push(`INSERT INTO ${qualified} (${colList}) VALUES\n  ${tuples}${upsert};`);
    }
    return out.join("\n");
  };

  const buildUpsertClause = (cols: string[], primaryKey: string[]) => {
    const updateCols =
      primaryKey.length > 0
        ? cols.filter((col) => !primaryKey.includes(col))
        : cols;
    if (updateCols.length === 0) return "";

    switch (dialect) {
      case "mysql":
        return ` ON DUPLICATE KEY UPDATE ${updateCols
          .map((col) => `${qi(col)} = VALUES(${qi(col)})`)
          .join(", ")}`;
      case "postgres":
        if (primaryKey.length === 0) return "";
        return ` ON CONFLICT (${primaryKey.map(qi).join(", ")}) DO UPDATE SET ${updateCols
          .map((col) => `${qi(col)} = EXCLUDED.${qi(col)}`)
          .join(", ")}`;
      case "sqlite":
        if (primaryKey.length === 0) return "";
        return ` ON CONFLICT (${primaryKey.map(qi).join(", ")}) DO UPDATE SET ${updateCols
          .map((col) => `${qi(col)} = excluded.${qi(col)}`)
          .join(", ")}`;
      default:
        return "";
    }
  };

  const sqlLiteral = (value: unknown): string => {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `'${raw.replace(/'/g, "''")}'`;
  };

  // Streams a table page-by-page, invoking `onPage` for each batch instead of
  // accumulating every row in memory. Updates the progress toast and stops
  // early if the user cancels. `onPage(cols, rows, isFirstPage)`.
  const streamRowsForExport = async (
    targetSchema: string,
    targetTable: string,
    onPage: (
      cols: string[],
      rows: Record<string, unknown>[],
      isFirstPage: boolean,
    ) => Promise<void>,
  ) => {
    const pageSize = 1000;
    let pageNumber = 1;
    let cols: string[] = [];
    let total: number | null = null;
    let fetched = 0;

    for (;;) {
      if (exportCancelRef.current) return;
      const res = await db.browse(connectionId, {
        schema: targetSchema,
        table: targetTable,
        page: { number: pageNumber, size: pageSize },
        includeTotal: pageNumber === 1,
      });
      if (cols.length === 0) cols = res.columns.map((c) => c.name);
      total = total ?? res.totalRecords;
      const batch = res.rows.map((row) => {
        const out: Record<string, unknown> = {};
        cols.forEach((col, index) => {
          out[col] = row[index] ?? null;
        });
        return out;
      });
      await onPage(cols, batch, pageNumber === 1);
      fetched += batch.length;
      setExportProgress({ rows: fetched, total, table: targetTable });
      if (batch.length < pageSize) break;
      if (total !== null && fetched >= total) break;
      pageNumber += 1;
    }
  };

  // Keep rendered rows in a ref so the stable selection callback can read the
  // current list without changing identity on every render.
  const filteredRowsRef = useRef(rowsForView);
  filteredRowsRef.current = rowsForView;

  // Keep lastSelectedRowId behind a ref so this callback stays stable. Rebuilding
  // it on every selection change would invalidate DataRow's memoization and
  // re-render every row — which caused focus/keystroke jank during editing.
  const lastSelectedRowIdRef = useRef(lastSelectedRowId);
  lastSelectedRowIdRef.current = lastSelectedRowId;

  const handleRowSelect = useCallback((rowId: string, e: React.MouseEvent) => {
    // Clicks inside an active cell editor (input / select / textarea) must not
    // re-select the row — caret positioning, text selection and drags inside
    // the editor would otherwise keep triggering row-selection side effects.
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    const isRange = e.shiftKey;
    const isToggle = e.metaKey || e.ctrlKey;
    setSelectedRows((prev) => {
      if (isRange && lastSelectedRowIdRef.current) {
        const rows = filteredRowsRef.current;
        const anchor = rows.findIndex(
          (r) => r.__rowId === lastSelectedRowIdRef.current,
        );
        const targetIdx = rows.findIndex((r) => r.__rowId === rowId);
        if (anchor === -1 || targetIdx === -1) return prev;
        const [lo, hi] =
          anchor < targetIdx ? [anchor, targetIdx] : [targetIdx, anchor];
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(rows[i].__rowId);
        return next;
      }
      if (isToggle) {
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      }
      // If already the sole selected row, keep the same Set identity so
      // selectedRows doesn't churn on repeated clicks.
      if (prev.size === 1 && prev.has(rowId)) return prev;
      return new Set([rowId]);
    });
    if (!isRange) setLastSelectedRowId(rowId);
  }, []);

  const openMenu = useCallback(
    (e: React.MouseEvent, rowId: string, col: string | null) => {
      e.preventDefault();
      setMenuState({ x: e.clientX, y: e.clientY, rowId, col });
    },
    [],
  );

  const beginEdit = useCallback((rowId: string, col: string, value: string) => {
    setActiveEdit({ rowId, col, value });
  }, []);

  const setActiveEditValue = useCallback((v: string) => {
    setActiveEdit((prev) => (prev ? { ...prev, value: v } : prev));
  }, []);

  const commitActiveEdit = useCallback(() => {
    setActiveEdit((prev) => {
      if (prev) {
        handleCellEdit(prev.rowId, prev.col, prev.value);
        // If the user committed a blank value into a brand-new draft row and
        // that leaves the whole draft empty, drop the draft — clicking a blank
        // cell and tabbing away shouldn't leave a phantom pending insert.
        if (
          prev.rowId.startsWith("new:") &&
          (prev.value === "" || prev.value == null)
        ) {
          discardEmptyDraft(prev.rowId);
        }
      }
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedCells, pendingDeletes]);

  const cancelActiveEdit = useCallback(() => {
    // Cancelling the edit on a still-empty draft (opened by clicking a blank
    // cell) should remove that draft so it doesn't count as a pending insert.
    const ae = activeEditRef.current;
    if (ae?.rowId.startsWith("new:")) discardEmptyDraft(ae.rowId);
    setActiveEdit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeMenu = useCallback(() => setMenuState(null), []);

  return (
    <div className="flex flex-col h-full min-w-0 relative">
      {/* Top progress bar — absolute so it overlays without nudging layout. */}
      <div
        aria-hidden
        className={`absolute top-0 left-0 right-0 h-0.5 z-30 pointer-events-none transition-opacity duration-200 ${
          progressVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div
          className="h-full bg-primary shadow-[0_0_8px_var(--color-primary)]"
          style={{
            width: `${progress}%`,
            transition:
              progress === 100 ? "width 150ms ease-out" : "width 200ms linear",
          }}
        />
      </div>
      {/* Toolbar */}
      <div className="h-12 shrink-0 border-b border-border flex items-center justify-between gap-3 px-4 bg-muted/10 min-w-0">
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto no-scrollbar">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>

          {/* Save / Discard for schema edits — enabled whenever the SchemaView
              reports unsaved drafts. */}
          {viewMode === "schema" && supportsSchemaEdit && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!schemaDirty || schemaSaving}
                onClick={async () => {
                  setSchemaSaving(true);
                  try {
                    await schemaRef.current?.save();
                  } finally {
                    setSchemaSaving(false);
                  }
                }}
              >
                <Check className="w-4 h-4 mr-2" />
                {schemaSaving ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!schemaDirty || schemaSaving}
                onClick={() => schemaRef.current?.discard()}
              >
                <X className="w-4 h-4 mr-2" />
                Discard
              </Button>
            </>
          )}

          {/* Filter / Columns only make sense for the tabular row view —
              hide them while browsing schema or diagram. */}
          {viewMode === "table" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={addNewRow}
                disabled={isCommitting || !structure}
                title="Add a new row (commits as INSERT)"
              >
                <PlusIcon className="w-4 h-4 mr-2" />
                Add row
              </Button>

              <div data-grid-toolbar-popover="true">
                <Popover
                  open={filterPopoverOpen}
                  onOpenChange={(open) => {
                    setFilterPopoverOpen(open);
                    if (open) setColumnsPopoverOpen(false);
                  }}
                >
                <PopoverTrigger
                  render={(props) => (
                    <Button
                      {...props}
                      variant={activeFilters.length > 0 ? "secondary" : "ghost"}
                      size="sm"
                    >
                      <Filter className="w-4 h-4 mr-2" />
                      Filter
                      {activeFilters.length > 0 && (
                        <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                          {activeFilters.length}
                        </span>
                      )}
                    </Button>
                  )}
                />
                <PopoverContent
                  data-grid-toolbar-popover="true"
                  className="w-105 p-0"
                  align="start"
                >
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium text-sm">Filter Builder</h4>
                      <span className="text-[11px] text-muted-foreground">
                        {activeFilters.length === 0
                          ? "No filters applied"
                          : `${filteredRows.length} of ${data.rows.length} rows match`}
                      </span>
                    </div>
                    {draftFilters.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={clearFilters}
                      >
                        Clear all
                      </Button>
                    )}
                  </div>

                  <div className="max-h-80 overflow-auto">
                    {draftFilters.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        No conditions yet. Add one below.
                      </div>
                    ) : (
                      <div className="p-2 space-y-1.5">
                        {draftFilters.map((f, idx) => {
                          const op = OPERATORS.find((o) => o.value === f.op);
                          return (
                            <div
                              key={f.id}
                              className="flex items-center gap-1.5"
                            >
                              <span className="w-7 shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide text-center">
                                {idx === 0 ? "where" : "and"}
                              </span>
                              <Select
                                value={f.column}
                                onValueChange={(v) =>
                                  updateFilter(f.id, { column: v })
                                }
                              >
                                <SelectTrigger className="h-7 w-28 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {data.cols.map((c) => (
                                    <SelectItem
                                      key={c}
                                      value={c}
                                      className="text-xs"
                                    >
                                      {c}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Select
                                value={f.op}
                                onValueChange={(v) =>
                                  updateFilter(f.id, {
                                    op: v as FilterOperator,
                                  })
                                }
                              >
                                <SelectTrigger className="h-7 w-32 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {OPERATORS.map((o) => (
                                    <SelectItem
                                      key={o.value}
                                      value={o.value}
                                      className="text-xs"
                                    >
                                      {o.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Input
                                placeholder={op?.valueless ? "" : "value"}
                                disabled={op?.valueless}
                                className="h-7 flex-1 min-w-0 text-xs"
                                value={f.value}
                                onChange={(e) =>
                                  updateFilter(f.id, { value: e.target.value })
                                }
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={() => removeFilter(f.id)}
                                aria-label="Remove condition"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="px-2 py-2 border-t border-border/60 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 flex-1"
                      onClick={addFilter}
                      disabled={data.cols.length === 0}
                    >
                      <PlusIcon className="w-3.5 h-3.5 mr-1.5" /> Add condition
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      disabled={!filtersDirty}
                      onClick={resetFilters}
                    >
                      Reset
                    </Button>
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={
                        !filtersDirty &&
                        validDraftFilters.length === activeFilters.length
                      }
                      onClick={applyFilters}
                    >
                      Apply
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              </div>

              <div data-grid-toolbar-popover="true">
                <Popover
                  open={columnsPopoverOpen}
                  onOpenChange={(open) => {
                    setColumnsPopoverOpen(open);
                    if (open) setFilterPopoverOpen(false);
                  }}
                >
                <PopoverTrigger
                  render={(props) => (
                    <Button {...props} variant="ghost" size="sm">
                      <Columns className="w-4 h-4 mr-2" />
                      Columns
                    </Button>
                  )}
                />
                <PopoverContent
                  data-grid-toolbar-popover="true"
                  className="w-48 p-2"
                  align="start"
                >
                  <div className="space-y-1">
                    {allDisplayCols.map((col) => {
                      const visible = !hiddenColumns.has(col);
                      const visibleCount =
                        allDisplayCols.length - hiddenColumns.size;
                      return (
                        <label
                          key={col}
                          className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded-md cursor-pointer"
                        >
                          <Checkbox
                            checked={visible}
                            disabled={visible && visibleCount <= 1}
                            onCheckedChange={(checked) =>
                              toggleColumn(col, checked === true)
                            }
                          />
                          <span className="text-sm">{col}</span>
                        </label>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center bg-muted/50 p-0.5 rounded-md border border-border">
            {supportsSchemaView && (
              <Button
                size="sm"
                variant={viewMode === "schema" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => setViewMode("schema")}
              >
                <LayoutTemplate className="w-4 h-4 mr-1.5" /> Schema
              </Button>
            )}
            <Button
              size="sm"
              variant={viewMode === "table" ? "secondary" : "ghost"}
              className="h-7 px-2"
              onClick={() => setViewMode("table")}
            >
              <Table2 className="w-4 h-4 mr-1.5" /> Data
            </Button>
            {isDocumentStore && (
              <Button
                size="sm"
                variant={viewMode === "json" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => setViewMode("json")}
              >
                <ListTree className="w-4 h-4 mr-1.5" /> JSON Tree
              </Button>
            )}
            {supportsDiagram && (
              <Button
                size="sm"
                variant={viewMode === "diagram" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => setViewMode("diagram")}
              >
                <Waypoints className="w-4 h-4 mr-1.5" /> Diagram
              </Button>
            )}
            {supportsRealtime && onOpenRealtime && (
              // Not a `viewMode` — opens a separate top-level tab so the
              // grid stays put and events stream independently of which
              // table the user was looking at.
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => onOpenRealtime(connectionId)}
                title="Open realtime subscription in a new tab"
              >
                <Radio className="w-4 h-4 mr-1.5" /> Realtime
              </Button>
            )}
          </div>
          {viewMode === "table" && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={undoStackRef.current.length === 0 || isCommitting}
                onClick={undo}
                title="Undo (⌘Z)"
                aria-label="Undo"
              >
                <Undo2 className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={redoStackRef.current.length === 0 || isCommitting}
                onClick={redo}
                title="Redo (⌘⇧Z)"
                aria-label="Redo"
              >
                <Redo2 className="w-4 h-4" />
              </Button>
            </>
          )}
          {hasPending && (
            <>
              <Button
                size="sm"
                variant="default"
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={isCommitting}
                onClick={() => void handleCommit()}
                title="Commit pending changes (⌘S)"
              >
                <Check className="w-4 h-4 mr-2" />
                {isCommitting ? "Committing…" : "Commit"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={isCommitting}
                onClick={() => setConfirmDiscardOpen(true)}
              >
                <X className="w-4 h-4 mr-2" />
                Discard
              </Button>
            </>
          )}
          {/* reference historyTick so undo/redo button enablement re-evaluates */}
          <span className="sr-only" aria-hidden>
            {historyTick}
          </span>

          {viewMode === "table" && (
            <>
              {onImportSql && supportsImport && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onImportSql(connectionId)}
                  title="Import SQL, CSV, or JSON into this connection"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Import
                </Button>
              )}
              {supportsExport && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsExportModalOpen(true)}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export
                </Button>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("tablerelay:toggle-chat"))
            }
            title="AI Chat"
          >
            <Sparkles className="w-4 h-4 mr-2" />
            Chat
          </Button>
        </div>
      </div>

      {/* Grid Area */}
      <div
        ref={gridScrollRef}
        className="flex-1 min-h-0 overflow-auto bg-background relative"
        style={{ maxWidth: "var(--content-max-w, calc(100vw - 328px))" }}
      >
        {/* First load (no rows yet) → skeleton grid so the pane looks like a
            table materializing rather than a spinner on an empty page.
            Refreshes (rows already on screen) keep the lighter translucent
            spinner so the existing data stays visible underneath. */}
        {loading && rowsForView.length === 0 && !loadError && <GridSkeleton />}
        {loading && rowsForView.length > 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-sm text-muted-foreground text-xs gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {loadError && !loading && (
          <div className="m-4 p-3 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium">Query failed</div>
              <div className="opacity-80 wrap-break-word">{loadError}</div>
            </div>
          </div>
        )}
        {/* Empty-result message — a centered overlay over the (filler-filled)
            sheet, so an empty table still reads as a full grid with a clear
            label rather than a void. pointer-events-none so it never blocks
            the toolbar / scrolling. */}
        {viewMode === "table" &&
          rowsForView.length === 0 &&
          !loading &&
          !loadError && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <span className="text-sm text-muted-foreground bg-background/80 rounded px-3 py-1.5">
                {activeFilters.length > 0
                  ? isDocumentStore
                    ? "No documents match the current filters."
                    : "No rows match the current filters."
                  : isDocumentStore
                    ? "No documents."
                    : "Table is empty."}
              </span>
            </div>
          )}
        {viewMode === "table" && (
          <table
            className="text-sm text-left border-collapse"
            style={{ width: "max-content", minWidth: "100%" }}
          >
            <thead className="text-xs text-muted-foreground bg-muted sticky top-0 z-10 shadow-sm">
              <tr ref={headerRowRef}>
                <th className="w-12 px-4 py-2 border-b border-r border-border font-medium text-center whitespace-nowrap">
                  #
                </th>
                {displayCols.map((col) => (
                  <th
                    key={col}
                    onClick={() => cycleSort(col)}
                    aria-sort={
                      sortBy?.column === col
                        ? sortBy.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="px-4 py-2 border-b border-r border-border font-medium cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap min-w-40 select-none"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{col}</span>
                      {sortBy?.column === col &&
                        (sortBy.direction === "asc" ? (
                          <ChevronUp className="w-3.5 h-3.5 opacity-80" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 opacity-80" />
                        ))}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsForView.map((row, rowIndex) => (
                <DataRow
                  key={row.__rowId}
                  row={row}
                  rowIndex={rowIndex}
                  cols={displayCols}
                  columnKinds={columnKinds}
                  columnDataTypes={columnDataTypes}
                  requiredColumnNames={requiredColumnNames}
                  editedCells={editedCells}
                  activeEdit={activeEdit}
                  isSelected={selectedRows.has(row.__rowId)}
                  isPendingDelete={pendingDeletes.has(row.__rowId)}
                  nullDisplay={settings.nullDisplay}
                  onRowClick={handleRowSelect}
                  onOpenMenu={openMenu}
                  onBeginEdit={beginEdit}
                  onCommitEdit={commitActiveEdit}
                  onCancelEdit={cancelActiveEdit}
                  onActiveEditChange={setActiveEditValue}
                  inputRef={inputRef}
                />
              ))}
              {/* Spreadsheet-style filler rows — pad the table to the full
                  viewport height when the result set is short (or empty) so
                  the grid reads as a continuous sheet instead of a small block
                  of rows (or a lone "empty" message) floating over a big black
                  void. Empty, non-interactive, only the subtle grid lines
                  show. Capped so a giant viewport can't render thousands. The
                  "Table is empty" message renders as a centered overlay on top
                  of these (see below) rather than as a tall table row. */}
              {(() => {
                // Real row height, measured from the rendered header (falls
                // back to a sane default until the first measurement lands).
                const ROW_H = measuredRowH > 0 ? measuredRowH : 37;
                if (loading || loadError || gridViewportH === 0) return null;
                const usable = gridViewportH - ROW_H; // minus the sticky header
                // Ceil so the last filler row reaches the bottom edge (a tiny
                // overshoot just scrolls 1px; flooring left a visible gap).
                const fit = Math.ceil(usable / ROW_H);
                const fillerCount = Math.min(
                  500,
                  Math.max(0, fit - rowsForView.length),
                );
                if (fillerCount === 0) return null;
                return Array.from({ length: fillerCount }).map((_, i) => (
                  <tr key={`filler-${i}`} className="group/filler">
                    {/* # cell — a faint "+" on the first blank row hints that
                        clicking starts a new row (insert). */}
                    <td
                      className="w-12 border-b border-r border-border/40 text-center align-middle text-muted-foreground/30 select-none"
                      style={{ height: ROW_H }}
                    >
                      {i === 0 ? "+" : ""}
                    </td>
                    {displayCols.map((col) => (
                      // Clicking a blank cell inserts a new row and edits this
                      // column — spreadsheet style. Hover highlight + text
                      // cursor signal it's editable.
                      <td
                        key={col}
                        onClick={() => beginInsertAt(col)}
                        className="border-b border-r border-border/40 px-4 cursor-text hover:bg-accent/30"
                        title="Click to add a new row"
                      />
                    ))}
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        )}
        {viewMode === "json" && isDocumentStore && (
          <div className="bg-muted/10 h-full flex flex-col min-h-0 relative">
            {/* Action bar only renders when there's something to surface —
                an error or unsaved changes. When the buffer is clean and
                valid the editor sits flush, full width, with a small
                floating Copy button bottom-right (kept always so the user
                can grab the JSON without dirtying the buffer). */}
            {(jsonError || jsonDirty) && (
              <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background/40 text-xs">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {jsonError ? (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30 font-medium">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      Invalid JSON
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                      Unsaved changes
                    </span>
                  )}
                </div>
                {jsonDirty && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      disabled={jsonSaving}
                      onClick={() => {
                        // Reset by re-applying the source text. Monaco's
                        // `value` prop is controlled-ish — pushing the same
                        // string back through state isn't enough (React
                        // skips it), so we write directly into the editor
                        // model.
                        const editor = jsonEditorRef.current;
                        if (editor) editor.setValue(jsonRowsText);
                        setJsonDirty(false);
                        setJsonError(null);
                      }}
                      title="Discard edits and revert to server state"
                    >
                      <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Discard
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7"
                      onClick={() => {
                        void handleSaveJsonEdits();
                      }}
                      disabled={jsonSaving || !!jsonError}
                      title={
                        jsonError
                          ? "Fix JSON errors before saving"
                          : "Save edited fields to the database"
                      }
                    >
                      {jsonSaving ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5 mr-1.5" />
                      )}
                      {jsonSaving ? "Saving…" : "Save"}
                    </Button>
                  </>
                )}
              </div>
            )}
            {/* Error detail strip — sits between the action bar and the
                editor so the full message is readable (multi-line) without
                truncation, and the user can dismiss it. */}
            {jsonError && (
              <div className="shrink-0 px-3 py-2 border-b border-red-500/30 bg-red-500/5 text-xs text-red-600 dark:text-red-400 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <pre className="whitespace-pre-wrap break-words font-mono leading-snug flex-1 min-w-0">
                  {jsonError}
                </pre>
                <button
                  type="button"
                  className="shrink-0 text-red-600/70 dark:text-red-400/70 hover:text-red-600 dark:hover:text-red-400 -mr-1 p-0.5"
                  onClick={() => setJsonError(null)}
                  title="Dismiss"
                  aria-label="Dismiss error"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <div className="flex-1 min-h-0">
              <Editor
                value={jsonRowsText}
                language="json"
                theme={editorTheme}
                onMount={(editor, monaco) => {
                  jsonEditorRef.current = editor;
                  collapseJsonSubtrees(editor);
                  // Cmd/Ctrl+S → Save. Bound on the editor instance so it
                  // only fires when the JSON editor has focus; doesn't
                  // intercept the browser save shortcut elsewhere in the
                  // app. The handler dispatches through `jsonSaveRef` to
                  // see live state on every keystroke.
                  editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                    () => {
                      jsonSaveRef.current();
                    },
                  );
                }}
                onChange={(next) => {
                  const dirty = (next ?? "") !== jsonRowsText;
                  setJsonDirty(dirty);
                  if (!dirty) {
                    setJsonError(null);
                    return;
                  }
                  try {
                    JSON.parse(next ?? "");
                    setJsonError(null);
                  } catch (e) {
                    setJsonError(e instanceof Error ? e.message : String(e));
                  }
                }}
                options={{
                  readOnly: jsonSaving,
                  minimap: { enabled: false },
                  fontFamily:
                    '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 13,
                  lineHeight: 20,
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  automaticLayout: true,
                  wordWrap: "on",
                  padding: { top: 10, bottom: 10 },
                  lineNumbers: "on",
                  glyphMargin: false,
                  folding: true,
                  foldingStrategy: "auto",
                  showFoldingControls: "always",
                }}
              />
            </div>
            <Button
              variant="secondary"
              size="icon"
              className="absolute bottom-3 right-3 z-10 h-8 w-8 rounded-full shadow-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    jsonEditorRef.current?.getValue() ?? jsonRowsText,
                  );
                  toast.success("JSON copied");
                } catch (e) {
                  toast.error(
                    `Copy failed: ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }}
              title="Copy JSON"
              aria-label="Copy JSON"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>
        )}
        {viewMode === "diagram" && (
          <DiagramView
            scope="table"
            connectionId={connectionId}
            schemaName={schema}
            tableName={tableName}
          />
        )}
        {viewMode === "schema" && (
          <SchemaView
            ref={schemaRef}
            tableName={tableName}
            connection={connection}
            schema={schema}
            onDirtyChange={setSchemaDirty}
            onLogQuery={onLogQuery}
          />
        )}
      </div>

      {/* Footer */}
      <div className="h-10 shrink-0 border-t border-border flex items-center justify-between px-4 bg-muted/10 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>
            {activeFilters.length > 0
              ? `${filteredRows.length} of ${data.rows.length} rows`
              : totalRows != null
                ? `${data.rows.length} of ${totalRows.toLocaleString()} rows`
                : `${data.rows.length} rows`}
            {selectedRows.size > 0 && ` · ${selectedRows.size} selected`}
          </span>
          <span>
            Execution:{" "}
            {executionMs !== null ? `${executionMs.toFixed(1)}ms` : "—"}
          </span>
          {hasPending && (
            <span className="text-yellow-600 dark:text-yellow-400 font-medium">
              Unsaved: {pendingSummary}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span>Limit:</span>
            <Select value={limit} onValueChange={setLimit}>
              <SelectTrigger className="h-6 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Always include the current limit so a custom default (e.g.
                    from settings) has a matching option to render. */}
                {Array.from(
                  new Set([limit, "25", "50", "100", "250", "500", "1000"]),
                )
                  .sort((a, b) => Number(a) - Number(b))
                  .map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1">
            {(() => {
              const pageSize = Number(limit);
              // If we know the total, compute pages exactly. Otherwise fall
              // back to "assume there's a next page iff the current result
              // set filled the limit" — the next-click will reveal if it
              // was actually the end.
              const totalPages =
                totalRows != null
                  ? Math.max(1, Math.ceil(totalRows / pageSize))
                  : null;
              const canPrev = page > 1;
              const canNext =
                totalPages != null
                  ? page < totalPages
                  : data.rows.length >= pageSize;
              return (
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-6 w-6"
                    disabled={!canPrev || loading || isRefreshing}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    title="Previous page"
                  >
                    <ChevronLeft className="w-3 h-3" />
                  </Button>
                  <span className="px-2">
                    {totalPages != null
                      ? `${page} of ${totalPages}`
                      : `Page ${page}`}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-6 w-6"
                    disabled={!canNext || loading || isRefreshing}
                    onClick={() => setPage((p) => p + 1)}
                    title="Next page"
                  >
                    <ChevronRight className="w-3 h-3" />
                  </Button>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        schemas={exportSchemas}
        initialSchema={schema}
        initialTable={tableName}
        supportsUpdateIfExists={["mysql", "postgres", "sqlite"].includes(dialect)}
        supportsSql={!isDocumentStore}
        onExport={handleExport}
      />

      <Dialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have {pendingSummary}. Discarding will throw them away and
              this action can't be undone. Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDiscardOpen(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                discardAll();
                setConfirmDiscardOpen(false);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRefreshOpen} onOpenChange={setConfirmRefreshOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reload and lose changes?</DialogTitle>
            <DialogDescription>
              Refreshing will reload rows from the database and drop your
              unsaved {pendingSummary}. Commit first with ⌘S if you want to keep
              them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmRefreshOpen(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRefreshOpen(false);
                runRefresh();
              }}
            >
              Discard and reload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SharedContextMenu
        state={menuState}
        onClose={closeMenu}
        rows={[...data.rows, ...pendingInserts]}
        pendingDeletes={pendingDeletes}
        editedCells={editedCells}
        onBeginEdit={beginEdit}
        onUndoRowDelete={undoRowDelete}
        onDiscardInsert={discardInsert}
        onSetNull={(rowId, col) => handleCellEdit(rowId, col, "NULL")}
      />
    </div>
  );
}

/* ---------- Memoized row ---------- */

interface DataRowProps {
  row: GridRow;
  rowIndex: number;
  cols: string[];
  columnKinds: Record<string, EditorKind>;
  columnDataTypes: Record<string, string>;
  requiredColumnNames: Set<string>;
  editedCells: Record<string, unknown>;
  activeEdit: { rowId: string; col: string; value: string } | null;
  isSelected: boolean;
  isPendingDelete: boolean;
  nullDisplay: NullDisplay;
  onRowClick: (rowId: string, e: React.MouseEvent) => void;
  onOpenMenu: (e: React.MouseEvent, rowId: string, col: string | null) => void;
  onBeginEdit: (rowId: string, col: string, value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onActiveEditChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const DataRow = memo(function DataRow({
  row,
  rowIndex,
  cols,
  columnKinds,
  columnDataTypes,
  requiredColumnNames,
  editedCells,
  activeEdit,
  isSelected,
  isPendingDelete,
  nullDisplay,
  onRowClick,
  onOpenMenu,
  onBeginEdit,
  onCommitEdit,
  onCancelEdit,
  onActiveEditChange,
  inputRef,
}: DataRowProps) {
  const isDraft = row.__rowId.startsWith("new:");
  const rowBg = isPendingDelete
    ? "bg-destructive/15 hover:bg-destructive/20 line-through"
    : isDraft
      ? isSelected
        ? "bg-emerald-500/25 hover:bg-emerald-500/30"
        : "bg-emerald-500/10 hover:bg-emerald-500/15"
      : isSelected
        ? "bg-primary/15 hover:bg-primary/20"
        : "hover:bg-muted/20";
  const indexBg = isPendingDelete
    ? "bg-destructive/25 text-destructive font-medium"
    : isDraft
      ? "bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 font-medium"
      : isSelected
        ? "bg-primary/25 text-primary font-medium"
        : "text-muted-foreground bg-muted/10 group-hover:bg-muted/30";
  const indexLabel = isDraft ? "＋" : rowIndex + 1;

  return (
    <tr
      data-row-id={row.__rowId}
      className={`border-b border-border group cursor-pointer ${rowBg}`}
      onClick={(e) => onRowClick(row.__rowId, e)}
      onContextMenu={(e) => onOpenMenu(e, row.__rowId, null)}
    >
      <td
        className={`p-0 border-r border-border text-center whitespace-nowrap select-none ${indexBg}`}
      >
        <div className="block px-4 py-1.5 w-full h-full">{indexLabel}</div>
      </td>
      {cols.map((col) => {
        // Draft rows (pendingInserts) keep their values on the row object
        // itself. Persisted rows carry queued edits in the editedCells map.
        const isDraft = row.__rowId.startsWith("new:");
        const cellKey = `${row.__rowId}${KEY_SEP}${col}`;
        const isEdited = !isDraft && editedCells[cellKey] !== undefined;
        const rawValue = isDraft
          ? row[col]
          : isEdited
            ? editedCells[cellKey]
            : row[col];
        const isNull = rawValue === null || rawValue === undefined;
        // Real cell value is always '' for NULL (edit/length/blob logic keys off
        // an empty string); the NULL marker is purely a display concern.
        const fullValue = isNull
          ? ""
          : typeof rawValue === "object"
            ? JSON.stringify(rawValue)
            : String(rawValue);
        // Display-only marker for NULL cells, per the user's nullDisplay setting.
        const nullMarker =
          isNull && nullDisplay === "null-text"
            ? "NULL"
            : isNull && nullDisplay === "symbol"
              ? "∅"
              : "";
        // BLOB-ish columns decode as long byte strings; showing them raw is
        // useless and slow. Replace with a size summary. Context-menu copy
        // actions still hand out the real bytes.
        const colType = columnDataTypes[col] ?? "";
        const isBlobCol = BLOB_TYPE_RE.test(colType);
        const [truncated, didTruncate] = truncateForCell(fullValue);
        const value =
          isBlobCol && fullValue.length > 0
            ? `[${colType.toUpperCase()} · ${fullValue.length.toLocaleString()} bytes]`
            : truncated;
        const isCurrentlyEditing =
          activeEdit?.rowId === row.__rowId && activeEdit?.col === col;
        const kind: EditorKind = columnKinds[col] ?? { kind: "text" };
        const error = isCurrentlyEditing
          ? validateEditorValue(kind, activeEdit.value)
          : null;
        // On draft rows, mark empty required columns in red so the user can
        // see exactly which fields are still blocking commit.
        const missingRequired =
          isDraft &&
          requiredColumnNames.has(col) &&
          value === "" &&
          !isCurrentlyEditing;
        const cellBg = isEdited
          ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
          : missingRequired
            ? "bg-destructive/15 ring-1 ring-inset ring-destructive/40"
            : "";
        const tooltip = missingRequired
          ? "Required — this column has no default value"
          : isBlobCol
            ? `${colType.toUpperCase()} · ${fullValue.length.toLocaleString()} bytes (use Copy Value to retrieve)`
            : didTruncate
              ? `Truncated for display · ${fullValue.length.toLocaleString()} chars (use Copy Value to see full)`
              : value;
        return (
          <td
            key={col}
            className={`p-0 border-r border-border font-mono text-xs align-top min-w-40 max-w-100 ${cellBg}`}
            onDoubleClick={() => {
              // Editing a BLOB in a tiny text box would corrupt it — bail.
              if (isBlobCol && fullValue.length > 0) return;
              // Huge text values open the editor fine, but we pass the full
              // value so the user can actually edit what's there, not the
              // truncated display string.
              onBeginEdit(row.__rowId, col, fullValue);
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              onOpenMenu(e, row.__rowId, col);
            }}
            title={tooltip}
          >
            {isCurrentlyEditing ? (
              <CellEditor
                kind={kind}
                value={activeEdit.value}
                inputRef={inputRef}
                error={error}
                onChange={onActiveEditChange}
                onCommit={() => {
                  if (validateEditorValue(kind, activeEdit.value) !== null)
                    return;
                  onCommitEdit();
                }}
                onCancel={onCancelEdit}
              />
            ) : (
              <div
                className={`px-4 py-1.5 truncate ${isBlobCol && fullValue.length > 0 ? "italic text-muted-foreground" : ""} ${isNull && nullMarker ? "italic text-muted-foreground/60" : ""}`}
              >
                {isNull && nullMarker ? nullMarker : value}
                {didTruncate && !isBlobCol && (
                  <span className="ml-2 text-[10px] text-muted-foreground/70 not-italic">
                    +
                    {(
                      fullValue.length - CELL_MAX_RENDER_CHARS
                    ).toLocaleString()}{" "}
                    more
                  </span>
                )}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
});

/* ---------- Type-aware cell editor ---------- */

interface CellEditorProps {
  kind: EditorKind;
  value: string;
  error: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function CellEditor({
  kind,
  value,
  error,
  inputRef,
  onChange,
  onCommit,
  onCancel,
}: CellEditorProps) {
  const baseCls = `w-full h-full px-4 py-1.5 bg-background text-foreground outline-none border-2 ${
    error ? "border-destructive" : "border-primary"
  }`;
  const keyHandler = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onCommit();
    else if (e.key === "Escape") onCancel();
  };

  const wrap = (node: React.ReactNode) => (
    <div className="relative" title={error ?? undefined}>
      {node}
      {error && (
        <div className="absolute left-0 right-0 top-full z-30 px-2 py-1 text-[11px] bg-destructive text-destructive-foreground shadow-md">
          {error}
        </div>
      )}
    </div>
  );

  // boolean + enum use a self-contained inline dropdown (SelectCellEditor).
  // It renders its option list in-tree (no portal) so picking a value can't
  // race with the grid's outside-click/blur commit logic — the failure mode
  // the portaled Base UI <Select> hit, which made the dropdown feel dead.
  if (kind.kind === "boolean") {
    // Normalize any truthy/falsy string the data pipeline may have produced
    // (e.g. JS booleans get stringified as "true"/"false") into the canonical
    // MySQL values "1" / "0" for display in the select.
    const normalized = /^(1|true|yes|on)$/i.test(value)
      ? "1"
      : /^(0|false|no|off)$/i.test(value)
        ? "0"
        : value === ""
          ? ""
          : value;
    return wrap(
      <SelectCellEditor
        value={normalized}
        options={[
          { value: "1", label: "true (1)" },
          { value: "0", label: "false (0)" },
        ]}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
        error={error}
      />,
    );
  }

  if (kind.kind === "enum") {
    return wrap(
      <SelectCellEditor
        value={value}
        options={kind.options.map((o) => ({ value: o, label: o }))}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
        error={error}
      />,
    );
  }

  if (kind.kind === "number") {
    return wrap(
      <input
        ref={inputRef}
        type="number"
        step={kind.integer ? 1 : "any"}
        min={kind.min}
        max={kind.max}
        className={baseCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={keyHandler}
      />,
    );
  }

  if (kind.kind === "date" || kind.kind === "datetime") {
    return wrap(
      <DateTimeCellEditor
        mode={kind.kind}
        value={value}
        error={error}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
  }

  if (kind.kind === "time") {
    return wrap(
      <TimeCellEditor
        value={value}
        error={error}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
  }

  // text / set / json fall through to plain text input. SET could be richer
  // later but a comma-separated text field is predictable.
  return wrap(
    <input
      ref={inputRef}
      type="text"
      className={baseCls}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={keyHandler}
    />,
  );
}

/* ---------- Boolean / enum dropdown backed by the project Select ---------- */

interface SelectCellEditorProps {
  value: string;
  options: { value: string; label: string }[];
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function SelectCellEditor({
  value,
  options,
  error,
  onChange,
  onCommit,
  onCancel,
}: SelectCellEditorProps) {
  // A self-contained custom dropdown rendered INSIDE the cell editor (no
  // portal). The Base UI <Select> portals its popup to document.body, which
  // lands outside the cell's DOM — so the grid's outside-click / blur commit
  // logic treats picking an option as a click-outside and cancels the edit
  // before the value lands. Keeping the menu in-tree (absolute, inside the
  // editor's relative wrapper) sidesteps that race entirely.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Highlight starts on the current value (or the first option) so keyboard
  // nav and the visual cursor agree from the first keypress.
  const initialIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [highlight, setHighlight] = useState(initialIndex);

  const pick = (v: string) => {
    onChange(v);
    // Commit on the next tick so the parent's onChange has flushed first and
    // the commit reads the freshly-picked value (matching the prior behavior).
    setTimeout(onCommit, 0);
  };

  // Close-on-outside-click. Anything outside this editor cancels the edit,
  // mirroring the plain text input's blur/Escape behavior.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      onCancel();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onCancel]);

  // Focus the list on mount so arrow keys / Enter / Escape work immediately
  // without a second click — the cell editor opens "already focused" like a
  // native <select> popup.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[highlight];
      if (opt) pick(opt.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Tab") {
      // Commit the highlighted option on Tab so editing flows like a form.
      const opt = options[highlight];
      if (opt) pick(opt.value);
    }
  };

  const borderCls = error ? "border-destructive" : "border-primary";
  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className="relative w-full h-full">
      {/* Trigger row showing the current value, styled like the other editors. */}
      <div
        className={`w-full h-full flex items-center justify-between px-4 py-1.5 bg-background text-foreground outline-none border-2 ${borderCls}`}
      >
        <span className={current ? "" : "text-muted-foreground"}>
          {current ? current.label : "(unset)"}
        </span>
        <ChevronDown className="size-4 text-muted-foreground shrink-0" />
      </div>
      {/* Inline option list. min-w matches the cell; max-h keeps long enums
          scrollable. Rendered in-tree, no portal. */}
      <div
        ref={listRef}
        role="listbox"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="absolute left-0 top-full z-40 mt-1 min-w-full max-h-60 overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 p-1 outline-none"
      >
        {options.map((o, i) => {
          const selected = o.value === value;
          const active = i === highlight;
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={selected}
              // mousedown (not click) so the pick fires before the window
              // mousedown outside-handler can ever see it as a blur.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.value);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`relative flex w-full items-center justify-between gap-2 rounded-md py-1.5 pl-2.5 pr-8 text-left text-xs cursor-pointer select-none ${
                active ? "bg-accent text-accent-foreground" : ""
              }`}
            >
              <span className="truncate">{o.label}</span>
              {selected && (
                <Check className="absolute right-2 size-4 shrink-0" />
              )}
            </button>
          );
        })}
        {options.length === 0 && (
          <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
            No options
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Date / datetime editor ---------- */

/**
 * Parse a MySQL-shaped date-ish string into `{ date, h, m, s }`. Accepts
 * `YYYY-MM-DD`, `YYYY-MM-DD HH:mm[:ss]`, or the `T`-separated variant.
 * Returns zeros for missing time parts so the editor has sensible defaults
 * when editing a DATE column.
 */
function parseDateTimeString(s: string): {
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

const pad = (n: number) => String(n).padStart(2, "0");

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(date: Date, h: number, m: number, sec: number): string {
  return `${formatDate(date)} ${pad(h)}:${pad(m)}:${pad(sec)}`;
}

interface DateTimeCellEditorProps {
  mode: "date" | "datetime";
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function DateTimeCellEditor({
  mode,
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: DateTimeCellEditorProps) {
  const parsed = parseDateTimeString(value);
  const [open, setOpen] = useState(true);

  const triggerCls = `w-full h-full flex items-center gap-2 px-4 py-1.5 bg-background text-foreground outline-none border-2 ${
    error ? "border-destructive" : "border-primary"
  }`;

  const applyDate = (d: Date | undefined) => {
    if (!d) return;
    if (mode === "date") {
      onChange(formatDate(d));
      setTimeout(() => {
        onCommit();
        setOpen(false);
      }, 0);
    } else {
      onChange(formatDateTime(d, parsed.h, parsed.m, parsed.sec));
    }
  };

  const applyTimePart = (h: number, m: number, sec: number) => {
    if (!parsed.date) {
      // No date selected yet — default to today so the time value is usable.
      const now = new Date();
      onChange(formatDateTime(now, h, m, sec));
    } else {
      onChange(formatDateTime(parsed.date, h, m, sec));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // Dismissing without picking commits whatever the user typed/chose.
          setTimeout(onCommit, 0);
        }
      }}
    >
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            className={triggerCls}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onCancel();
                setOpen(false);
              }
            }}
          >
            <CalendarIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">
              {value || (
                <span className="text-muted-foreground">
                  (pick a {mode === "date" ? "date" : "date & time"})
                </span>
              )}
            </span>
          </button>
        )}
      />
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={parsed.date}
          onSelect={applyDate}
          defaultMonth={parsed.date}
          autoFocus
        />
        {mode === "datetime" && (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <ClockIcon className="w-3.5 h-3.5 text-muted-foreground" />
            <TimeFields
              h={parsed.h}
              m={parsed.m}
              s={parsed.sec}
              onChange={applyTimePart}
            />
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              // "Now" fills in the current local clock — commits immediately
              // for date columns, leaves the popover open for datetime so the
              // user can still nudge the time if they want.
              const now = new Date();
              if (mode === "date") {
                onChange(formatDate(now));
                setTimeout(() => {
                  onCommit();
                  setOpen(false);
                }, 0);
              } else {
                onChange(
                  formatDateTime(
                    now,
                    now.getHours(),
                    now.getMinutes(),
                    now.getSeconds(),
                  ),
                );
              }
            }}
          >
            Now
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              onChange("");
              setTimeout(() => {
                onCommit();
                setOpen(false);
              }, 0);
            }}
          >
            Clear
          </Button>
          {mode === "datetime" && (
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                onCommit();
                setOpen(false);
              }}
            >
              Done
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------- Time editor (standalone TIME column) ---------- */

interface TimeCellEditorProps {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function TimeCellEditor({
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: TimeCellEditorProps) {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(value) ?? [
    "",
    "0",
    "0",
    "0",
  ];
  const [open, setOpen] = useState(true);
  const h = Number(match[1]) || 0;
  const m = Number(match[2]) || 0;
  const s = Number(match[3]) || 0;

  const triggerCls = `w-full h-full flex items-center gap-2 px-4 py-1.5 bg-background text-foreground outline-none border-2 ${
    error ? "border-destructive" : "border-primary"
  }`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTimeout(onCommit, 0);
      }}
    >
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            className={triggerCls}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onCancel();
                setOpen(false);
              }
            }}
          >
            <ClockIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">
              {value || (
                <span className="text-muted-foreground">(pick a time)</span>
              )}
            </span>
          </button>
        )}
      />
      <PopoverContent align="start" className="w-auto">
        <div className="flex items-center gap-2">
          <TimeFields
            h={h}
            m={m}
            s={s}
            onChange={(nh, nm, ns) =>
              onChange(`${pad(nh)}:${pad(nm)}:${pad(ns)}`)
            }
          />
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const now = new Date();
              onChange(
                `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
              );
            }}
          >
            Now
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              onChange("");
              setTimeout(() => {
                onCommit();
                setOpen(false);
              }, 0);
            }}
          >
            Clear
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              onCommit();
              setOpen(false);
            }}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------- H / M / S spinner row used by both editors ---------- */

function TimeFields({
  h,
  m,
  s,
  onChange,
}: {
  h: number;
  m: number;
  s: number;
  onChange: (h: number, m: number, s: number) => void;
}) {
  const spinnerCls =
    "w-14 h-7 rounded border border-input bg-background px-2 text-sm tabular-nums text-center outline-none focus:border-primary";
  const clamp = (n: number, max: number) =>
    Math.max(0, Math.min(max, Number.isFinite(n) ? n : 0));
  return (
    <div className="flex items-center gap-1 font-mono">
      <input
        type="number"
        min={0}
        max={23}
        className={spinnerCls}
        value={h}
        onChange={(e) => onChange(clamp(Number(e.target.value), 23), m, s)}
      />
      <span className="text-muted-foreground">:</span>
      <input
        type="number"
        min={0}
        max={59}
        className={spinnerCls}
        value={m}
        onChange={(e) => onChange(h, clamp(Number(e.target.value), 59), s)}
      />
      <span className="text-muted-foreground">:</span>
      <input
        type="number"
        min={0}
        max={59}
        className={spinnerCls}
        value={s}
        onChange={(e) => onChange(h, m, clamp(Number(e.target.value), 59))}
      />
    </div>
  );
}

/* ---------- Shared context menu ---------- */

interface SharedMenuProps {
  state: { x: number; y: number; rowId: string; col: string | null } | null;
  onClose: () => void;
  rows: GridRow[];
  pendingDeletes: Set<string>;
  editedCells: Record<string, unknown>;
  onBeginEdit: (rowId: string, col: string, value: string) => void;
  onUndoRowDelete: (rowId: string) => void;
  onDiscardInsert: (rowId: string) => void;
  onSetNull: (rowId: string, col: string) => void;
}

function SharedContextMenu({
  state,
  onClose,
  rows,
  pendingDeletes,
  editedCells,
  onBeginEdit,
  onUndoRowDelete,
  onDiscardInsert,
  onSetNull,
}: SharedMenuProps) {
  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-shared-menu]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

  if (!state) return null;
  const row = rows.find((r) => r.__rowId === state.rowId);
  if (!row) return null;
  const isPendingDelete = pendingDeletes.has(state.rowId);
  const isDraft = state.rowId.startsWith("new:");
  const cellKey = state.col ? `${state.rowId}${KEY_SEP}${state.col}` : null;
  const cellRaw = state.col
    ? isDraft
      ? row[state.col]
      : cellKey && editedCells[cellKey] !== undefined
        ? editedCells[cellKey]
        : row[state.col]
    : null;
  const cellValue =
    cellRaw == null
      ? ""
      : typeof cellRaw === "object"
        ? JSON.stringify(cellRaw)
        : String(cellRaw);

  const act = (fn: () => void) => {
    fn();
    onClose();
  };

  // Clamp menu position so it doesn't overflow the viewport.
  const MENU_W = 200;
  const MENU_H_EST = 220;
  const x = Math.min(state.x, window.innerWidth - MENU_W - 4);
  const y = Math.min(state.y, window.innerHeight - MENU_H_EST - 4);

  const itemCls =
    "w-full text-left px-3 py-1.5 text-sm rounded-sm hover:bg-accent hover:text-accent-foreground cursor-pointer select-none";
  const sepCls = "my-1 h-px bg-border";

  return (
    <div
      data-shared-menu
      className="fixed z-50 min-w-50 rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 p-1"
      style={{ left: x, top: y }}
    >
      {state.col ? (
        <>
          <button
            className={itemCls}
            onClick={() =>
              act(() => onBeginEdit(state.rowId, state.col!, cellValue))
            }
          >
            Edit Cell
          </button>
          <button
            className={itemCls}
            onClick={() =>
              act(() => {
                void navigator.clipboard.writeText(cellValue);
              })
            }
          >
            Copy Value
          </button>
          <div className={sepCls} />
          <button
            className={itemCls}
            onClick={() => act(() => onSetNull(state.rowId, state.col!))}
          >
            Set to NULL
          </button>
          <button
            className={itemCls}
            onClick={() =>
              act(() => {
                void navigator.clipboard.writeText(
                  JSON.stringify(row, null, 2),
                );
              })
            }
          >
            Copy Row as JSON
          </button>
        </>
      ) : (
        <>
          {isDraft ? (
            <button
              className={itemCls}
              onClick={() => act(() => onDiscardInsert(state.rowId))}
            >
              Discard new row
            </button>
          ) : isPendingDelete ? (
            <button
              className={itemCls}
              onClick={() => act(() => onUndoRowDelete(state.rowId))}
            >
              Undo delete
            </button>
          ) : (
            <button className={itemCls} onClick={onClose}>
              View Record
            </button>
          )}
          <div className={sepCls} />
          <button
            className={itemCls}
            onClick={() =>
              act(() => {
                void navigator.clipboard.writeText(
                  JSON.stringify(row, null, 2),
                );
              })
            }
          >
            Copy Row as JSON
          </button>
        </>
      )}
    </div>
  );
}
