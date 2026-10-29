import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
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
  Sparkles,
  Radio,
  ChevronUp,
  ChevronDown,
  Copy,
  SquarePen,
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
import { runExport, type ExportDialect } from "./export-data";
import ProgressDialog, {
  type ProgressState,
  type ProgressLogLine,
} from "../../components/ui/progress-dialog";
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
  patchCachedGridDraft,
  clearCachedGrid,
} from "../../state/tab-data-cache";
import {
  ensureTableStructure,
  refreshTableStructure,
  useConnections,
} from "../../state/connections";
import {
  useAdapterManifests,
  resolveManifest,
} from "../../state/adapter-manifests";
import RoutineView from "../routine/routine-view";
import { getMonacoThemeId } from "../../lib/monaco-setup";
import { useSettings, type NullDisplay } from "../../lib/settings-store";
import {
  type FilterOperator,
  type FilterCondition,
  type SortState,
  OPERATORS,
  cellToString,
  matchCondition,
  parseClipboardTable,
  type GridRow,
  rowHasData,
  type GridData,
  EMPTY_DATA,
  KEY_SEP,
  pad,
} from "./data-grid-utils";
import { copyText } from "../../lib/clipboard";
import { DataRow, SharedContextMenu } from "./data-row";
import { useColumnWidths, ColumnResizeHandle } from "../../components/column-resize";
import { rowHasPreview } from "./preview-marker";

/** A broken/invalid SQL view (MySQL 1356, Postgres "relation does not exist"
 *  inside a view, etc.): the definition references dropped objects or the
 *  view's definer lacks rights. Surfaced with a clear message so it doesn't
 *  read as an app bug. */
function isBrokenViewError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("references invalid table") ||
    (m.includes("definer") && m.includes("view")) ||
    m.includes("view's definer")
  );
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
  /** Reports unsaved edit state to the owning tab (drives the unsaved dot). */
  onDirtyChange?: (dirty: boolean) => void;
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
  onDirtyChange,
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
  // A view is not a real table: its toolbar swaps the Schema/Diagram toggles
  // for an "Edit" button that opens the CREATE script. Detect it from the
  // loaded schema list (views carry kind === "view").
  const isView = useMemo(() => {
    const schemas = connState.schemasById.get(connectionId);
    if (!schemas) return false;
    const sch = schemas.find((s) => s.name === schema) ?? schemas[0];
    return sch?.tables.find((t) => t.name === tableName)?.kind === "view";
  }, [connState.schemasById, connectionId, schema, tableName]);
  const cached = tabId ? readCachedGrid(tabId) : undefined;
  // A cache entry is only "loaded" if it carries a real fetch result (a
  // structure, or at least columns). A draft-only skeleton — created when the
  // user starts adding a row before the first fetch lands, see
  // `patchCachedGridDraft` — has neither, and must NOT suppress the structure
  // fetch (otherwise commit later fails with "table structure unavailable").
  const hasLoadedCache =
    !!cached && (cached.structure != null || cached.cols.length > 0);
  const [data, setData] = useState<GridData>(() =>
    cached ? { cols: cached.cols, rows: cached.rows as GridRow[] } : EMPTY_DATA,
  );
  const [structure, setStructure] = useState<TableStructure | null>(
    cached?.structure ?? null,
  );
  // Mirror of `structure` so async handlers (handleCommit) can read the latest
  // value and load it on demand without a stale closure.
  const structureRef = useRef(structure);
  structureRef.current = structure;
  const [loading, setLoading] = useState(!hasLoadedCache);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editedCells, setEditedCells] = useState<Record<string, unknown>>(
    () => cached?.editedCells ?? {},
  );
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
  // ProgressDialog (a real 0-100% bar). `exportCancelRef` aborts the loop.
  const [exportProgress, setExportProgress] = useState<ProgressState | null>(null);
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
  // Unsaved edits in a view's "Edit" (definition) mode. Folded into the tab's
  // unsaved dot alongside pending grid edits.
  const [definitionDirty, setDefinitionDirty] = useState(false);
  // Once the user opens "Edit", keep the definition editor mounted (just hidden
  // on Data) so the in-progress script, cursor, and undo history survive
  // toggling back and forth — same as how query tabs stay mounted. Lazy so a
  // view tab the user only browses never pays the editor's mount cost.
  const [definitionMounted, setDefinitionMounted] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [lastSelectedRowId, setLastSelectedRowId] = useState<string | null>(
    null,
  );
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(
    () => new Set(cached?.pendingDeletes ?? []),
  );
  // Rows queued for INSERT on commit. Each has a synthetic __rowId prefixed
  // with `new:` so existing edit/select machinery can key off it the same way
  // as fetched rows.
  const [pendingInserts, setPendingInserts] = useState<GridRow[]>(
    () => (cached?.pendingInserts as GridRow[]) ?? [],
  );
  const [isCommitting, setIsCommitting] = useState(false);

  // Persist unsaved work (draft inserts, cell edits, queued deletes) into the
  // tab cache whenever it changes, so it survives the grid unmounting on a
  // connection switch — e.g. the user starts adding a row, switches to another
  // connection to copy something, and comes back to find their draft intact.
  // Cleared automatically: committing/discarding empties these and this effect
  // writes the empty state through.
  useEffect(() => {
    if (!tabId) return;
    patchCachedGridDraft(tabId, {
      pendingInserts,
      editedCells,
      pendingDeletes: Array.from(pendingDeletes),
    });
  }, [tabId, pendingInserts, editedCells, pendingDeletes]);
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

  // Keep the tab in a mode its toolbar actually offers. Views hide the
  // Schema/Diagram toggles (and add Edit/"definition"); tables don't have a
  // definition mode. If a restored session or a stale toggle lands a tab in a
  // mode with no visible toggle, fall back to the data grid.
  useEffect(() => {
    if (isView && (viewMode === "schema" || viewMode === "diagram")) {
      setViewMode("table");
    } else if (!isView && viewMode === "definition") {
      setViewMode("table");
    }
  }, [isView, viewMode, setViewMode]);

  useEffect(() => {
    if (viewMode === "definition") setDefinitionMounted(true);
  }, [viewMode]);

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

  // Lazy-hydrate oversized documents when the user opens the JSON view.
  //
  // For document stores (Mongo), `browse` ships size-capped previews of huge
  // field values to keep the page small (see preview-marker.ts). The table
  // view renders those as read-only stubs, but the JSON view shows AND edits
  // the raw documents — a stub there would both mislead the user and, worse,
  // get written back verbatim on save, corrupting the document. So before the
  // JSON view is usable we fetch the full record for every row that carries a
  // preview marker (by `_id`) and splice the complete values into grid state.
  const hydratingRef = useRef(false);
  useEffect(() => {
    if (viewMode !== "json" || !isDocumentStore) return;
    if (jsonDirty || hydratingRef.current) return;
    const idCol = structure?.primaryKey[0];
    if (!idCol) return;
    const stubRows = data.rows.filter((r) => rowHasPreview(r));
    if (stubRows.length === 0) return;

    hydratingRef.current = true;
    void (async () => {
      try {
        const full = await Promise.all(
          stubRows.map(async (r) => {
            const id = r[idCol];
            const rec = (await db.getRecord(
              connectionId,
              schema,
              tableName,
              id,
            )) as Record<string, unknown> | null;
            return { rowId: r.__rowId, rec };
          }),
        );
        const byRowId = new Map(
          full
            .filter((f) => f.rec !== null)
            .map((f) => [f.rowId, f.rec as Record<string, unknown>]),
        );
        if (byRowId.size === 0) return;
        setData((prev) => ({
          cols: prev.cols,
          // Merge the full field values over the stub row, preserving the
          // synthetic __rowId so selection / edit bookkeeping still lines up.
          rows: prev.rows.map((r) => {
            const rec = byRowId.get(r.__rowId);
            return rec ? { ...r, ...rec, __rowId: r.__rowId } : r;
          }),
        }));
      } catch (e) {
        toast.error(
          `Failed to load full document${stubRows.length > 1 ? "s" : ""}: ${
            isDbError(e) ? e.message : String(e)
          }`,
        );
      } finally {
        hydratingRef.current = false;
      }
    })();
  }, [
    viewMode,
    isDocumentStore,
    jsonDirty,
    data.rows,
    structure,
    connectionId,
    schema,
    tableName,
  ]);

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

  // Resizable columns. Seeded from the natural auto-layout widths, then driven
  // through a <colgroup> under `table-layout: fixed` (the leading col is the #
  // gutter). See components/column-resize.
  const { widths: colWidths, setWidth: setColWidth, allMeasured: colsMeasured } =
    useColumnWidths(displayCols, headerRowRef, 1);
  const makeColResize = useCallback(
    (col: string) => (w: number) => setColWidth(col, w),
    [setColWidth],
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

  const fetchData = async (
    opts: { showRefresh?: boolean; refetchStructure?: boolean } = {},
  ) => {
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
      // `refetchStructure` forces a fresh describe even when we hold one (after
      // a reload / Postgres database switch the held structure may be stale).
      const reuse = opts.refetchStructure ? null : structureRef.current;
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
        reuse
          ? Promise.resolve(reuse)
          : (opts.refetchStructure
              ? refreshTableStructure(connectionId, schema, tableName)
              : ensureTableStructure(connectionId, schema, tableName)),
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
  // Seed from cache on first render: if we hydrated a REAL fetch result from
  // the tab cache, that snapshot already IS the loaded state, so the loader
  // must not refetch it. A draft-only skeleton doesn't count — we still need to
  // fetch the structure/rows. (Lazy ref init — runs once.)
  if (loadedTargetRef.current === null && hasLoadedCache) {
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
      // Do NOT blanket-mark stale on hide. A plain tab switch doesn't make the
      // data stale, and re-fetching on every reactivation was the cause of
      // tab-switch lag (a DB round-trip each time). Genuine staleness — an
      // external mutation or a reconnect — is already handled by the
      // `tablerelay:reload` listener, which nulls loadedTargetRef + sets
      // isStaleRef for hidden tabs so they refetch on next show. When nothing
      // changed, the key check below short-circuits and we show cached rows
      // instantly with no fetch.
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
      // Force a fresh describe: a reload can follow an ALTER, or a Postgres
      // database switch where this same `(schema, table)` now resolves to a
      // different table — reusing the held structure would render the new rows
      // with the old columns.
      loadedTargetRef.current = loadTargetKey();
      void fetchData({ showRefresh: true, refetchStructure: true });
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

  // Export progress is rendered as a ProgressDialog (a real 0-100% bar), driven
  // by `exportProgress` — see handleExport + the ProgressDialog at the bottom.
  const handleExportCancel = useCallback(() => {
    exportCancelRef.current = true;
    setExportProgress((p) =>
      p && p.phase === "running"
        ? { ...p, step: "Cancelling… (finishing current page)" }
        : p,
    );
  }, []);
  const handleExportProgressClose = useCallback(() => {
    setExportProgress((p) => (p && p.phase === "running" ? p : null));
  }, []);

  // Top progress bar driver. When any async work is active we creep from 0 to
  // 90 with an easing curve (fast at first, slow near the top) so long queries
  // still show movement without falsely claiming completion. When the work
  // finishes we snap to 100, then fade the bar out after a short delay.
  const isBusy = loading || isRefreshing || isCommitting;
  // The row-oriented views (grid + JSON) are the only ones that should surface
  // the data fetch's skeleton / spinner / error. Schema, definition (view DDL)
  // and diagram render their own content and loading states, so a background
  // `fetchData` (which still runs to keep the grid warm) must not paint the
  // grid placeholder over them.
  const isDataView = viewMode === "table" || viewMode === "json";
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

  // Report unsaved edit state to the owning tab (drives the unsaved dot).
  // Skip the initial mount fire so the dot never flickers on when opening.
  const dirtyMountedRef = useRef(false);
  useEffect(() => {
    if (!dirtyMountedRef.current) { dirtyMountedRef.current = true; return; }
    onDirtyChange?.(hasPending || definitionDirty);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPending, definitionDirty]);

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

    await copyText(
      lines.join("\n"),
      `Copied ${picked.length} row${picked.length === 1 ? "" : "s"}`,
    );
  }, [selectedRows, displayCols, rowsForView, editedCells]);

  // Duplicate one or more existing/draft rows as new draft inserts. Copies
  // EVERY column value verbatim — including the primary key — plus any
  // uncommitted edits on the source row, so the duplicate is a true copy the
  // user can tweak before committing. (If the PK collides on commit, the DB
  // returns a clear duplicate-key error and the user edits it.) This is the
  // reliable path for "duplicate a row"; Ctrl+C → Ctrl+V does the same via the
  // clipboard. Selects + scrolls to the new drafts so they're visible.
  const duplicateRows = useCallback(
    (rowIds: string[]) => {
      if (viewMode !== "table" || !structure || isCommitting) return;
      const source = [...data.rows, ...pendingInserts];
      const createdIds: string[] = [];
      const drafts: GridRow[] = [];
      for (const rid of rowIds) {
        const src = source.find((r) => r.__rowId === rid);
        if (!src) continue;
        const id = `new:${crypto.randomUUID()}`;
        const draft: GridRow = { __rowId: id };
        for (const c of structure.columns) {
          // Prefer any pending edit on the source row over its fetched value.
          const editKey = `${rid}${KEY_SEP}${c.name}`;
          draft[c.name] =
            editedCells[editKey] !== undefined
              ? editedCells[editKey]
              : (src[c.name] ?? null);
        }
        createdIds.push(id);
        drafts.push(draft);
      }
      if (drafts.length === 0) return;
      pushHistory();
      setPendingInserts((prev) => [...prev, ...drafts]);
      setSelectedRows(new Set(createdIds));
      const lastId = createdIds[createdIds.length - 1] ?? null;
      setLastSelectedRowId(lastId);
      if (lastId) {
        requestAnimationFrame(() => {
          const el = document.querySelector(
            `tr[data-row-id="${CSS.escape(lastId)}"]`,
          );
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
      toast.success(
        `Duplicated ${drafts.length} row${drafts.length === 1 ? "" : "s"} as draft`,
      );
    },
    // `pushHistory` is declared below; it's only invoked at call time (never
    // during render), so it's safe to omit from the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewMode, structure, isCommitting, data.rows, pendingInserts, editedCells],
  );

  // Keyboard shortcuts: Delete/Backspace queues selected rows for deletion,
  // Escape clears the selection, ⌘/Ctrl+S commits pending changes,
  // ⌘/Ctrl+Z undoes, ⌘/Ctrl+Shift+Z (or ⌘Y on non-Mac) redoes. Skip while
  // the user is typing in an input or editing a cell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the visible grid reacts — grids on inactive tabs stay mounted and
      // would otherwise all fire on the same keypress (and now ⌘S would clash
      // with the active query tab's Save).
      if (!isActive) return;
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
        // Flush any mid-edit cell, then commit — shared with the Commit button.
        commitWithFlush();
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
      if (mod && key === "f") {
        if (viewMode !== "table") return;
        e.preventDefault();
        setFilterPopoverOpen((prev) => !prev);
        setColumnsPopoverOpen(false);
        return;
      }
      if (inEditable) return;
      if (viewMode !== "table") return;
      if (mod && key === "c" && selectedRows.size > 0) {
        e.preventDefault();
        void copySelectedRows();
        return;
      }
      if (mod && key === "d" && selectedRows.size > 0) {
        e.preventDefault();
        duplicateRows(Array.from(selectedRows));
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
    isActive,
    selectedRows,
    viewMode,
    structure,
    data.rows,
    hasPending,
    isCommitting,
    copySelectedRows,
    duplicateRows,
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
      if (f.op === "in" || f.op === "not_in") {
        const isNumericColumn =
          (columnKinds[f.column]?.kind ?? "text") === "number";
        const parts = f.value.split(",").map((p) => p.trim());
        const value = parts.map((part) => {
          if (isNumericColumn) {
            const n = Number(part);
            return Number.isFinite(n) ? n : part;
          }
          return part;
        });
        return { column: f.column, op: f.op, value };
      }
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
      // Coerce to a number only when the COLUMN is numeric. Postgres rejects
      // `int_col = $1` when `$1` is a text param ("operator does not exist:
      // integer = text"); MySQL casts implicitly but explicit is correct for
      // both. Keying off the column kind (not just "looks numeric") avoids the
      // inverse bug — binding a number against a text column would fail PG with
      // "text = integer". Applies to every comparison op; previously only
      // gt/lt were coerced, which broke equality filters on numeric columns.
      const isNumericColumn =
        (columnKinds[f.column]?.kind ?? "text") === "number";
      const n = Number(f.value);
      const value =
        isNumericColumn && f.value !== "" && Number.isFinite(n) ? n : f.value;
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
          case "in": {
            const parts = f.value.split(",").map((p) => p.trim());
            const parsedParts = parts.map((part) => isNaN(Number(part)) ? part : Number(part));
            filterObj[key] = { $in: parsedParts };
            break;
          }
          case "not_in": {
            const parts = f.value.split(",").map((p) => p.trim());
            const parsedParts = parts.map((part) => isNaN(Number(part)) ? part : Number(part));
            filterObj[key] = { $nin: parsedParts };
            break;
          }
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
          case "in": {
            const list = f.value
              .split(",")
              .map((val) => {
                const trimmed = val.trim();
                const escaped = trimmed.replace(/'/g, "''");
                return isNaN(Number(trimmed)) ? `'${escaped}'` : trimmed;
              })
              .join(", ");
            return `${col} IN (${list})`;
          }
          case "not_in": {
            const list = f.value
              .split(",")
              .map((val) => {
                const trimmed = val.trim();
                const escaped = trimmed.replace(/'/g, "''");
                return isNaN(Number(trimmed)) ? `'${escaped}'` : trimmed;
              })
              .join(", ");
            return `${col} NOT IN (${list})`;
          }
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
    // The embedded SchemaView keeps its own copy of the structure (columns,
    // indexes, FKs) that it only reads once on mount, so Refresh has to tell
    // it to re-describe explicitly — otherwise the index/column list stays
    // stale. `refetchStructure` likewise forces the grid's held structure to
    // re-fetch so column headers/types reflect any on-disk change.
    if (viewMode === "schema") void schemaRef.current?.reload();
    void fetchData({ showRefresh: true, refetchStructure: true });
  };

  const handleRefresh = () => {
    // Refresh re-describes the table, which resets the SchemaView's draft
    // editors — so an in-progress schema edit needs the same "you'll lose
    // changes" confirmation that pending grid edits get.
    if (hasPending || (viewMode === "schema" && schemaDirty)) {
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
    // NULL/undefined render as an empty editor, so committing an untouched NULL
    // cell hands back "". Treat null/undefined ↔ "" as no change — otherwise an
    // accidental open+commit marks an empty cell as edited (and drops its NULL).
    const isNoChange =
      originalValue === null || originalValue === undefined
        ? value === ""
        : String(originalValue) === value;
    if (isNoChange) {
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

      // Positional paste maps against the VISIBLE columns in display order,
      // because that is exactly what copy emits (displayCols, no header for a
      // single row). Using the full schema-ordered list here misaligned every
      // value whenever a column was hidden or reordered, so an internal
      // copy→paste round-trip "did nothing useful". Fall back to all columns
      // when nothing is visible.
      const posCols = displayCols.length > 0 ? displayCols : tableCols;

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
          for (let i = 0; i < Math.min(posCols.length, row.length); i++) {
            draft[posCols[i]] = row[i];
          }
        }
        return draft;
      });

      setPendingInserts((prev) => [...prev, ...drafts]);
      setSelectedRows(new Set(createdIds));
      const lastId = createdIds[createdIds.length - 1] ?? null;
      setLastSelectedRowId(lastId);
      // Pasted drafts are appended after the (possibly filtered) rows, so they
      // land at the bottom — off-screen if the view is full. Scroll the last
      // one into view so the user sees them, matching the "Add row" behavior.
      if (lastId) {
        requestAnimationFrame(() => {
          const el = document.querySelector(
            `tr[data-row-id="${CSS.escape(lastId)}"]`,
          );
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
      toast.success(
        `Pasted ${drafts.length} row${drafts.length === 1 ? "" : "s"} as draft`,
      );
    },
    [viewMode, structure, isCommitting, pushHistory, displayCols],
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
    // Resolve the table structure into a local so the rest of this handler is
    // guaranteed a non-null value. If it isn't loaded yet (a restored draft
    // mounted before the fetch landed, or the user committed mid-load), fetch
    // it on demand instead of refusing — `structure` below now binds to this
    // local, not the component state.
    let structure = structureRef.current;
    if (!structure) {
      try {
        structure = await ensureTableStructure(connectionId, schema, tableName);
        setStructure(structure);
      } catch {
        // fall through to the unavailable error below
      }
    }
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

  // Always-fresh handle to `handleCommit`. `commitWithFlush` is memoized and
  // would otherwise capture a STALE `handleCommit` whose closure predates the
  // just-flushed cell edit (editedCells doesn't change while a cell is being
  // typed, so the memo isn't invalidated), making Commit silently no-op after
  // an inline edit. Calling through this ref runs the latest closure.
  const handleCommitRef = useRef(handleCommit);
  handleCommitRef.current = handleCommit;

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
    // Safety net: a row still holding a preview stub means its full document
    // never loaded (fetch failed, or the doc was deleted under us). Diffing /
    // writing against a stub would corrupt the document, so refuse the save
    // and tell the user to refresh.
    if (rowsForView.some((r) => rowHasPreview(r))) {
      setJsonError(
        "Some documents are too large and haven't fully loaded yet. " +
          "Refresh the grid and reopen the JSON view before saving.",
      );
      return;
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
    // Filename: single table → schema_table; otherwise (multi-table or
    // objects-only) → schema_export.
    const base = first
      ? config.targets.length === 1
        ? `${first.schema}_${first.table}`
        : `${first.schema}_export`
      : `${config.schema || "export"}_export`;
    const safeTarget = base.replace(/[^\w.-]+/g, "_");
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

    // Hand off from the export modal to the progress dialog.
    setIsExportModalOpen(false);
    exportCancelRef.current = false;
    const log: ProgressLogLine[] = [];
    let lastLabel = "";
    setExportProgress({ step: "Starting export…", fraction: 0, phase: "running", log: [] });
    const splitBytes = config.splitMb != null ? config.splitMb * 1024 * 1024 : null;
    // Map the grid's richer Dialect to the export-layer's dialect (generic /
    // none have no SQL output, so they become null).
    const exportDialect: ExportDialect =
      dialect === "mysql" || dialect === "postgres" || dialect === "sqlite"
        ? dialect
        : null;
    try {
      const parts = await runExport({
        connectionId,
        dialect: exportDialect,
        config,
        path,
        splitBytes,
        cancelRef: exportCancelRef,
        // One overall 0-100% bar across every table + object.
        onProgress: ({ fraction, label, detail }) => {
          if (label !== lastLabel) {
            lastLabel = label;
            log.push({ text: `→ ${label}` });
          }
          setExportProgress({
            step: exportCancelRef.current ? "Cancelling… (finishing current page)" : label,
            fraction,
            detail,
            phase: "running",
            log: [...log],
          });
        },
      });
      const objects =
        config.views.length + config.routines.length + config.triggers.length;
      const bits = [
        config.targets.length
          ? `${config.targets.length} ${config.targets.length === 1 ? "table" : "tables"}`
          : null,
        objects ? `${objects} object${objects === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      const extras = [
        config.gzip ? "gzip" : null,
        parts > 1 ? `${parts} parts` : null,
      ].filter(Boolean);
      const what = `${bits.join(" + ") || "data"}${extras.length ? ` (${extras.join(", ")})` : ""}`;
      if (exportCancelRef.current) {
        log.push({ text: "Cancelled — partial file(s) written.", kind: "error" });
        setExportProgress({ step: "Cancelled", fraction: null, phase: "cancelled", log: [...log] });
      } else {
        log.push({ text: `Done — exported ${what}`, kind: "success" });
        setExportProgress({ step: "Export complete", fraction: 1, phase: "done", log: [...log] });
        toast.success(`Exported ${what}`);
      }
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      log.push({ text: `Error: ${msg}`, kind: "error" });
      setExportProgress({ step: "Export failed", fraction: null, phase: "error", log: [...log] });
      toast.error(`Export failed: ${msg}`);
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

  // Flush any in-progress cell edit into the draft/edited state BEFORE
  // committing, then run the commit on the next tick so the flushed value is
  // visible in state. Without this, clicking Commit (or ⌘S) while a cell editor
  // still holds a typed-but-unblurred value validates against a STALE draft and
  // falsely reports a just-filled required field as "missing". Used by both the
  // Commit button and the ⌘S shortcut so they behave identically.
  const commitWithFlush = useCallback(() => {
    if (isCommittingRef.current) return;
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
          void handleCommitRef.current();
      }, 0);
      return;
    }
    if (!hasPendingRef.current) return;
    void handleCommitRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitActiveEdit, cancelActiveEdit]);

  const closeMenu = useCallback(() => setMenuState(null), []);

  const handleSchemaSave = useCallback(async () => {
    setSchemaSaving(true);
    try {
      await schemaRef.current?.save();
    } finally {
      setSchemaSaving(false);
    }
  }, []);

  const handleSchemaDiscard = useCallback(() => schemaRef.current?.discard(), []);

  const handleFilterPopoverChange = useCallback((open: boolean) => {
    setFilterPopoverOpen(open);
    if (open) setColumnsPopoverOpen(false);
  }, []);

  const handleColumnsPopoverChange = useCallback((open: boolean) => {
    setColumnsPopoverOpen(open);
    if (open) setFilterPopoverOpen(false);
  }, []);

  const makeFilterColumnChange = useCallback(
    (id: string) => (v: string) => updateFilter(id, { column: v }),
    // updateFilter only sets state via setter; stable enough to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const makeFilterOpChange = useCallback(
    (id: string) => (v: string) => updateFilter(id, { op: v as FilterOperator }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const makeFilterValueChange = useCallback(
    (id: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
      updateFilter(id, { value: e.target.value }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const makeRemoveFilter = useCallback(
    (id: string) => () => removeFilter(id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const makeToggleColumn = useCallback(
    (col: string) => (checked: boolean | "indeterminate") =>
      toggleColumn(col, checked === true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleShowSchema = useCallback(() => setViewMode("schema"), [setViewMode]);
  const handleShowTable = useCallback(() => setViewMode("table"), [setViewMode]);
  const handleShowJson = useCallback(() => setViewMode("json"), [setViewMode]);
  const handleShowDiagram = useCallback(
    () => setViewMode("diagram"),
    [setViewMode],
  );
  const handleOpenRealtime = useCallback(
    () => onOpenRealtime?.(connectionId),
    [onOpenRealtime, connectionId],
  );
  // "Edit" on a view: an in-tab mode (not a separate tab) that swaps the grid
  // for the view's CREATE script in a SQL editor. A view has no table structure
  // to edit, so this replaces the Schema toggle. Toggling back to Data keeps
  // the same tab.
  const handleShowDefinition = useCallback(
    () => setViewMode("definition"),
    [setViewMode],
  );

  const handleOpenDiscardConfirm = useCallback(
    () => setConfirmDiscardOpen(true),
    [],
  );
  const handleImportSql = useCallback(
    () => onImportSql?.(connectionId),
    [onImportSql, connectionId],
  );
  const handleOpenExport = useCallback(() => setIsExportModalOpen(true), []);
  const handleToggleChat = useCallback(
    () => window.dispatchEvent(new CustomEvent("tablerelay:toggle-chat")),
    [],
  );

  const makeCycleSort = useCallback(
    (col: string) => () => cycleSort(col),
    [cycleSort],
  );
  const makeBeginInsertAt = useCallback(
    (col: string) => () => beginInsertAt(col),
    // beginInsertAt is recreated each render and reads current structure/data,
    // so it must be a dependency or the handler captures stale (empty) state.
    [beginInsertAt],
  );

  const handleJsonDiscard = useCallback(() => {
    // Reset by re-applying the source text. Monaco's
    // `value` prop is controlled-ish — pushing the same
    // string back through state isn't enough (React
    // skips it), so we write directly into the editor
    // model.
    const editor = jsonEditorRef.current;
    if (editor) editor.setValue(jsonRowsText);
    setJsonDirty(false);
    setJsonError(null);
  }, [jsonRowsText]);

  const handleJsonSaveClick = useCallback(() => {
    void handleSaveJsonEdits();
    // handleSaveJsonEdits is recreated each render and reads current structure/
    // data, so it must be a dependency to avoid saving with stale (null) state.
  }, [handleSaveJsonEdits]);

  const handleDismissJsonError = useCallback(() => setJsonError(null), []);

  const handleEditorMount = useCallback(
    (
      editor: MonacoEditorNs.IStandaloneCodeEditor,
      monaco: typeof import("monaco-editor"),
    ) => {
      jsonEditorRef.current = editor;
      collapseJsonSubtrees(editor);
      // Cmd/Ctrl+S → Save. Bound on the editor instance so it
      // only fires when the JSON editor has focus; doesn't
      // intercept the browser save shortcut elsewhere in the
      // app. The handler dispatches through `jsonSaveRef` to
      // see live state on every keystroke.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        jsonSaveRef.current();
      });
    },
    [collapseJsonSubtrees],
  );

  const handleJsonEditorChange = useCallback(
    (next: string | undefined) => {
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
    },
    [jsonRowsText],
  );

  const handleCopyJson = useCallback(() => {
    void copyText(
      jsonEditorRef.current?.getValue() ?? jsonRowsText,
      "JSON copied",
    );
  }, [jsonRowsText]);

  const handlePrevPage = useCallback(
    () => setPage((p) => Math.max(1, p - 1)),
    [],
  );
  const handleNextPage = useCallback(() => setPage((p) => p + 1), []);

  const handleExportModalClose = useCallback(
    () => setIsExportModalOpen(false),
    [],
  );

  const handleKeepEditingDiscard = useCallback(
    () => setConfirmDiscardOpen(false),
    [],
  );
  const handleConfirmDiscard = useCallback(() => {
    discardAll();
    setConfirmDiscardOpen(false);
    // discardAll is recreated each render and snapshots current pending edits
    // for undo, so it must be a dependency to avoid an empty undo snapshot.
  }, [discardAll]);

  const handleKeepEditingRefresh = useCallback(
    () => setConfirmRefreshOpen(false),
    [],
  );
  const handleConfirmRefresh = useCallback(() => {
    setConfirmRefreshOpen(false);
    runRefresh();
    // runRefresh is recreated each render and reads current page/filters/sort,
    // so it must be a dependency to reload the current view (not page 1).
  }, [runRefresh]);

  const handleSetNull = useCallback(
    (rowId: string, col: string) => handleCellEdit(rowId, col, "NULL"),
    // handleCellEdit is recreated each render and reads current data/editedCells,
    // so it must be a dependency to avoid a stale lookup that clobbers edits.
    [handleCellEdit],
  );
  const handleDuplicateRow = useCallback(
    (rowId: string) => {
      // If the right-clicked row is part of a multi-selection, duplicate
      // the whole selection; otherwise just that row.
      const ids = selectedRows.has(rowId)
        ? Array.from(selectedRows)
        : [rowId];
      duplicateRows(ids);
    },
    [selectedRows, duplicateRows],
  );

  const handleCommitClick = useCallback(() => commitWithFlush(), [commitWithFlush]);

  // The Edit/Data toggle for a view. In "definition" mode it's folded into the
  // embedded RoutineView's toolbar (see toolbarLeading) so the tab has one row.
  const viewModeToggle = (
    <div className="flex items-center bg-muted/50 p-0.5 rounded-md border border-border">
      <Button
        size="sm"
        variant={viewMode === "definition" ? "secondary" : "ghost"}
        className="h-7 px-2"
        onClick={handleShowDefinition}
      >
        <SquarePen className="w-4 h-4 mr-1.5" /> Edit
      </Button>
      <Button
        size="sm"
        variant={viewMode === "table" ? "secondary" : "ghost"}
        className="h-7 px-2"
        onClick={handleShowTable}
      >
        <Table2 className="w-4 h-4 mr-1.5" /> Data
      </Button>
    </div>
  );

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
      {/* Toolbar — hidden in a view's "definition" mode; the embedded
          RoutineView renders the only toolbar there (with the Edit/Data toggle
          folded in via toolbarLeading), so a view tab shows one row, not two. */}
      {viewMode !== "definition" && (
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
                variant={schemaDirty ? "default" : "ghost"}
                className={
                  schemaDirty ? "bg-green-600 hover:bg-green-700 text-white" : undefined
                }
                disabled={!schemaDirty || schemaSaving}
                onClick={handleSchemaSave}
              >
                <Check className="w-4 h-4 mr-2" />
                {schemaSaving ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!schemaDirty || schemaSaving}
                onClick={handleSchemaDiscard}
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
                  onOpenChange={handleFilterPopoverChange}
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
                                onValueChange={makeFilterColumnChange(f.id)}
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
                                onValueChange={makeFilterOpChange(f.id)}
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
                                placeholder={op?.valueless ? "" : (op?.placeholder || "value")}
                                disabled={op?.valueless}
                                className="h-7 flex-1 min-w-0 text-xs"
                                value={f.value}
                                onChange={makeFilterValueChange(f.id)}
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={makeRemoveFilter(f.id)}
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
                  onOpenChange={handleColumnsPopoverChange}
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
                            onCheckedChange={makeToggleColumn(col)}
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
            {/* A view has no structure to edit — swap the Schema toggle for an
                "Edit" toggle that shows its CREATE script in a SQL editor,
                in-tab, so "Data" stays one click away. */}
            {isView ? (
              // This toolbar only renders outside "definition" mode (the whole
              // bar is hidden there), so Edit is never the active toggle here —
              // the active highlight lives in the embedded editor's folded
              // toggle. Always ghost.
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={handleShowDefinition}
                title="Edit view definition (SQL script)"
              >
                <SquarePen className="w-4 h-4 mr-1.5" /> Edit
              </Button>
            ) : (
              supportsSchemaView && (
                <Button
                  size="sm"
                  variant={viewMode === "schema" ? "secondary" : "ghost"}
                  className="h-7 px-2"
                  onClick={handleShowSchema}
                >
                  <LayoutTemplate className="w-4 h-4 mr-1.5" /> Schema
                </Button>
              )
            )}
            <Button
              size="sm"
              variant={viewMode === "table" ? "secondary" : "ghost"}
              className="h-7 px-2"
              onClick={handleShowTable}
            >
              <Table2 className="w-4 h-4 mr-1.5" /> Data
            </Button>
            {isDocumentStore && (
              <Button
                size="sm"
                variant={viewMode === "json" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={handleShowJson}
              >
                <ListTree className="w-4 h-4 mr-1.5" /> JSON Tree
              </Button>
            )}
            {supportsDiagram && !isView && (
              <Button
                size="sm"
                variant={viewMode === "diagram" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={handleShowDiagram}
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
                onClick={handleOpenRealtime}
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
                onClick={handleCommitClick}
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
                onClick={handleOpenDiscardConfirm}
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
                  onClick={handleImportSql}
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
                  onClick={handleOpenExport}
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
            onClick={handleToggleChat}
            title="Ask AI"
          >
            <Sparkles className="w-4 h-4 mr-2 text-primary" />
            Ask AI
          </Button>
        </div>
      </div>
      )}

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
        {isDataView && loading && rowsForView.length === 0 && !loadError && <GridSkeleton />}
        {isDataView && loading && rowsForView.length > 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-sm text-muted-foreground text-xs gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {isDataView && loadError && !loading && (
          <div className="m-4 p-3 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium">
                {isBrokenViewError(loadError)
                  ? `This view is broken`
                  : "Query failed"}
              </div>
              {isBrokenViewError(loadError) && (
                <div className="mb-1 opacity-80">
                  <span className="font-mono">{tableName}</span>'s definition
                  references tables/columns that no longer exist, or its{" "}
                  <code className="font-mono">DEFINER</code> user is missing or
                  lacks rights. Fix or recreate the view in the database — this
                  is not an app error.
                </div>
              )}
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
            style={
              colsMeasured
                ? { tableLayout: "fixed", width: "max-content" }
                : { width: "max-content", minWidth: "100%" }
            }
          >
            {/* Once measured, column widths are authoritative via this colgroup
                under table-layout: fixed, which is what makes them resizable. */}
            {colsMeasured && (
              <colgroup>
                <col style={{ width: 48 }} />
                {displayCols.map((col) => (
                  <col key={col} style={{ width: colWidths[col] }} />
                ))}
              </colgroup>
            )}
            <thead className="text-xs text-muted-foreground bg-muted sticky top-0 z-10 shadow-sm">
              <tr ref={headerRowRef}>
                <th className="w-12 px-4 py-2 border-b border-r border-border font-medium text-center whitespace-nowrap">
                  #
                </th>
                {displayCols.map((col) => (
                  <th
                    key={col}
                    onClick={makeCycleSort(col)}
                    aria-sort={
                      sortBy?.column === col
                        ? sortBy.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="relative px-4 py-2 border-b border-r border-border font-medium cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap min-w-40 select-none"
                  >
                    <div className="flex items-center justify-between gap-2 overflow-hidden">
                      <span className="truncate">{col}</span>
                      {sortBy?.column === col &&
                        (sortBy.direction === "asc" ? (
                          <ChevronUp className="w-3.5 h-3.5 opacity-80 shrink-0" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 opacity-80 shrink-0" />
                        ))}
                    </div>
                    <ColumnResizeHandle onWidth={makeColResize(col)} />
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
                        onClick={makeBeginInsertAt(col)}
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
                      onClick={handleJsonDiscard}
                      title="Discard edits and revert to server state"
                    >
                      <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Discard
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7"
                      onClick={handleJsonSaveClick}
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
                  onClick={handleDismissJsonError}
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
                onMount={handleEditorMount}
                onChange={handleJsonEditorChange}
                options={{
                  readOnly: jsonSaving,
                  minimap: { enabled: false },
                  // Keep in sync with --font-mono (index.css) and the SQL
                  // editor's EDITOR_FONT_FAMILY so all mono surfaces match.
                  fontFamily:
                    '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
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
              onClick={handleCopyJson}
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
        {definitionMounted && (
          // A view's "Edit" mode: its CREATE script in a SQL editor with
          // Run/Save, reusing the view-editor shell. In-tab, so the Data toggle
          // stays available. Stays mounted (hidden on Data) once opened so the
          // in-progress edit is preserved when toggling back and forth.
          <div className={viewMode === "definition" ? "h-full" : "hidden"}>
            <RoutineView
              connection={connection}
              schema={schema}
              name={tableName}
              kind="view"
              onDirtyChange={setDefinitionDirty}
              onLogQuery={onLogQuery}
              toolbarLeading={viewModeToggle}
            />
          </div>
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
              <SelectTrigger size="sm" className="h-7! w-20 py-0 text-xs">
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
                    onClick={handlePrevPage}
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
                    onClick={handleNextPage}
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
        onClose={handleExportModalClose}
        connectionId={connectionId}
        schemas={exportSchemas}
        initialSchema={schema}
        initialTable={tableName}
        supportsUpdateIfExists={["mysql", "postgres", "sqlite"].includes(dialect)}
        supportsSql={!isDocumentStore}
        onExport={handleExport}
      />

      <ProgressDialog
        open={exportProgress !== null}
        title="Export Data"
        state={exportProgress}
        onCancel={handleExportCancel}
        onClose={handleExportProgressClose}
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
              onClick={handleKeepEditingDiscard}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDiscard}
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
              Refreshing will reload from the database and drop your unsaved{" "}
              {pendingSummary || "schema changes"}. Save first if you want to
              keep them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={handleKeepEditingRefresh}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmRefresh}
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
        onSetNull={handleSetNull}
        onDuplicateRow={handleDuplicateRow}
      />
    </div>
  );
}
