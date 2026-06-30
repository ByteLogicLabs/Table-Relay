import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SearchableSelect } from "../../components/ui/searchable-select";
import {
  Download,
  Table2,
  Search,
  FileSpreadsheet,
  Braces,
  Database,
  Eye,
  FunctionSquare,
  Zap,
  Loader2,
} from "lucide-react";
import { db, type SchemaInfo, type RoutineInfo, type TriggerInfo } from "../../lib/db";

export type ExportFormat = "csv" | "json" | "sql";

export interface ExportTarget {
  schema: string;
  table: string;
  includeSchema: boolean;
  includeData: boolean;
  dropIfExists: boolean;
  updateIfExists: boolean;
}

/** A stored routine selected for export (procedures + functions share a list
 *  but need their `kind` to fetch the right DDL). */
export interface ExportRoutineRef {
  name: string;
  kind: string;
}

export interface ExportConfig {
  targets: ExportTarget[];
  format: ExportFormat;
  includeHeader: boolean;
  /** gzip the output to a `.gz` file. */
  gzip: boolean;
  /** When set, split the output into multiple part files once a part crosses
   *  this many megabytes (measured before gzip). `null` = single file. */
  splitMb: number | null;
  /** (SQL only) Prefix every table reference with its source database name
   *  (`db.table`). Off by default so the dump is portable — it imports into
   *  whatever database the target connection is pointed at, instead of failing
   *  with "Unknown database" when the destination has a different name. */
  qualifyDatabase: boolean;
  /** Schema the views/routines/triggers below belong to (all share one). */
  schema: string;
  /** (SQL only) View names to export as CREATE VIEW. */
  views: string[];
  /** (SQL only) Routines (procedures/functions) to export. */
  routines: ExportRoutineRef[];
  /** (SQL only) Trigger names to export as CREATE TRIGGER. */
  triggers: string[];
}

type TableOption = "schema" | "data" | "drop" | "update";
type TableOptions = Record<TableOption, boolean>;

const OPTION_HELP: Record<TableOption, string> = {
  schema: "Include CREATE TABLE statements for the selected tables.",
  data: "Include table rows in the export.",
  drop: "Add DROP TABLE IF EXISTS before each CREATE TABLE statement.",
  update: "Use upsert statements so existing rows are updated when keys conflict.",
};

const FORMATS: Array<{
  value: ExportFormat;
  label: string;
  icon: typeof FileSpreadsheet;
  hint: string;
}> = [
  {
    value: "csv",
    label: "CSV",
    icon: FileSpreadsheet,
    hint: "Spreadsheet-friendly rows. Exports one table at a time.",
  },
  {
    value: "json",
    label: "JSON",
    icon: Braces,
    hint: "Rows as JSON objects. Good for APIs and scripts.",
  },
  {
    value: "sql",
    label: "SQL",
    icon: Database,
    hint: "Portable INSERT (and optional CREATE/DROP) statements.",
  },
];

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Active connection — needed to list routines/triggers for the Views /
   *  Routines / Triggers tabs. `null` only in degenerate states. */
  connectionId: string | null;
  schemas: SchemaInfo[];
  initialSchema: string;
  initialTable: string;
  supportsUpdateIfExists: boolean;
  /** Whether the active store can produce SQL dumps. False for document/KV
   *  stores (Mongo, Redis) where INSERT/CREATE statements are meaningless —
   *  those get CSV/JSON only. */
  supportsSql: boolean;
  onExport: (config: ExportConfig) => void | Promise<void>;
}

type ObjectTab = "tables" | "views" | "routines" | "triggers";

export default function ExportModal({
  isOpen,
  onClose,
  connectionId,
  schemas,
  initialSchema,
  initialTable,
  supportsUpdateIfExists,
  supportsSql,
  onExport,
}: ExportModalProps) {
  const [schema, setSchema] = useState(initialSchema);
  const [tableOptions, setTableOptions] = useState<Record<string, TableOptions>>(
    () => ({ [initialTable]: defaultTableOptions(true) }),
  );
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [gzip, setGzip] = useState(false);
  const [qualifyDatabase, setQualifyDatabase] = useState(false);
  // Split output into multiple part files once a part crosses this many MB.
  // 0 = single file (no split). Configured before export.
  const [splitMb, setSplitMb] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [tableQuery, setTableQuery] = useState("");
  // Which object-type tab is showing (SQL only; CSV/JSON are tables-only).
  const [objectTab, setObjectTab] = useState<ObjectTab>("tables");
  // Routines + triggers are fetched on demand (not in SchemaInfo). Views come
  // from the schema's tables list (kind === "view").
  const [routines, setRoutines] = useState<RoutineInfo[]>([]);
  const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(false);
  // Selected object names (default: all, populated when lists resolve). `null`
  // marks "not yet initialised" so the default-all effect runs once per schema.
  const [selectedViews, setSelectedViews] = useState<Set<string> | null>(null);
  const [selectedRoutines, setSelectedRoutines] = useState<Set<string> | null>(null);
  const [selectedTriggers, setSelectedTriggers] = useState<Set<string> | null>(null);

  const selectedSchema = useMemo(
    () => schemas.find((s) => s.name === schema) ?? schemas[0] ?? null,
    [schema, schemas],
  );
  const tables = selectedSchema?.tables ?? [];
  const selectableTables = useMemo(() => {
    // Exclude views, and dedupe by name — a stale/double-refreshed schema can
    // contain the same table twice, which would render duplicate rows and
    // duplicate React keys. First occurrence wins.
    const seen = new Set<string>();
    const out: typeof tables = [];
    for (const t of tables) {
      if (t.kind === "view") continue;
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t);
    }
    return out;
  }, [tables]);
  // Views come straight from the schema's table list (kind === "view"),
  // deduped — no extra fetch needed.
  const views = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tables) {
      if (t.kind !== "view") continue;
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t.name);
    }
    return out;
  }, [tables]);

  // Whether the Views/Routines/Triggers tabs apply at all (SQL dumps only).
  const objectsApply = supportsSql && format === "sql";

  // Fetch routines + triggers for the selected schema when the object tabs are
  // in play. Views are already in hand. Best-effort: a driver that doesn't
  // support routines/triggers just yields empty lists.
  useEffect(() => {
    if (!isOpen || !objectsApply || !connectionId || !selectedSchema) {
      setRoutines([]);
      setTriggers([]);
      return;
    }
    let cancelled = false;
    setObjectsLoading(true);
    const name = selectedSchema.name;
    void (async () => {
      const [r, t] = await Promise.all([
        db.listRoutines(connectionId, name).catch(() => [] as RoutineInfo[]),
        db.listTriggers(connectionId, name).catch(() => [] as TriggerInfo[]),
      ]);
      if (cancelled) return;
      setRoutines(r);
      setTriggers(t);
      setObjectsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isOpen, objectsApply, connectionId, selectedSchema]);

  // Default ALL objects to checked whenever the modal opens, the schema
  // changes, or an async list (routines/triggers) arrives. Keyed on a stable
  // string of the names — NOT the array reference — so a parent re-render that
  // hands us an equal-but-new `schemas` array doesn't wipe the user's manual
  // unchecks mid-session. User toggles don't change the key, so they persist.
  const viewsKey = useMemo(() => views.join(" "), [views]);
  const routinesKey = useMemo(
    () => routines.map((r) => r.name).join(" "),
    [routines],
  );
  const triggersKey = useMemo(
    () => triggers.map((t) => t.name).join(" "),
    [triggers],
  );
  useEffect(() => {
    if (!isOpen) return;
    setSelectedViews(new Set(views));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, viewsKey]);
  useEffect(() => {
    if (!isOpen) return;
    setSelectedRoutines(new Set(routines.map((r) => r.name)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, routinesKey]);
  useEffect(() => {
    if (!isOpen) return;
    setSelectedTriggers(new Set(triggers.map((t) => t.name)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, triggersKey]);

  // Table list filtered by the search box. Selection/column toggles always
  // operate on the full `selectableTables` set, not just the visible filter.
  const visibleTables = useMemo(() => {
    const q = tableQuery.trim().toLowerCase();
    if (!q) return selectableTables;
    return selectableTables.filter((t) => t.name.toLowerCase().includes(q));
  }, [selectableTables, tableQuery]);
  const selectedTargets = useMemo(() => {
    if (!selectedSchema) return [];
    return selectableTables
      .map((table) => {
        const opts = tableOptions[table.name] ?? defaultTableOptions(false);
        const selected =
          format === "sql"
            ? opts.schema || opts.data || opts.drop
            : opts.data;
        if (!selected) return null;
        return {
          schema: selectedSchema.name,
          table: table.name,
          includeSchema: format === "sql" ? opts.schema : false,
          includeData: format === "sql" ? opts.data : true,
          dropIfExists: format === "sql" ? opts.drop : false,
          updateIfExists:
            format === "sql" && supportsUpdateIfExists && opts.data
              ? opts.update
              : false,
        };
      })
      .filter((target): target is ExportTarget => target !== null);
  }, [format, selectableTables, selectedSchema, supportsUpdateIfExists, tableOptions]);
  const selectedCount = selectedTargets.length;
  // Object selections only count toward SQL exports.
  const viewCount = objectsApply ? selectedViews?.size ?? 0 : 0;
  const routineCount = objectsApply ? selectedRoutines?.size ?? 0 : 0;
  const triggerCount = objectsApply ? selectedTriggers?.size ?? 0 : 0;
  const objectCount = viewCount + routineCount + triggerCount;
  const totalSelected = selectedCount + objectCount;
  const csvInvalid = format === "csv" && selectedCount !== 1;
  const canExport =
    !!selectedSchema &&
    !exporting &&
    (format === "csv"
      ? selectedCount === 1
      : format === "json"
        ? selectedCount > 0
        : totalSelected > 0);

  useEffect(() => {
    if (!isOpen) return;
    setSchema(initialSchema);
    setTableOptions({ [initialTable]: defaultTableOptions(true) });
    setFormat("csv");
    setTableQuery("");
    setGzip(false);
    setSplitMb(0);
    setQualifyDatabase(false);
    setObjectTab("tables");
  }, [initialSchema, initialTable, isOpen]);

  // (Object selections default to all-checked via the key-based effects above,
  // which also re-default on schema change and on async list arrival.)

  // CSV/JSON are tables-only — snap back to the Tables tab if the format
  // changes away from SQL while another tab is showing.
  useEffect(() => {
    if (!objectsApply && objectTab !== "tables") setObjectTab("tables");
  }, [objectsApply, objectTab]);

  // If the active store can't do SQL but the format is somehow SQL, snap back.
  useEffect(() => {
    if (!supportsSql && format === "sql") setFormat("csv");
  }, [supportsSql, format]);

  useEffect(() => {
    if (!selectedSchema) return;
    const names = new Set(selectableTables.map((t) => t.name));
    setTableOptions((prev) => {
      const next: Record<string, TableOptions> = {};
      for (const name of names) {
        next[name] = prev[name] ?? defaultTableOptions(false);
      }
      const hasAnyData = Object.values(next).some((opts) => opts.data);
      if (!hasAnyData && names.size > 0) {
        const fallback = names.has(initialTable)
          ? initialTable
          : selectableTables[0].name;
        next[fallback] = defaultTableOptions(true);
      }
      if (!supportsUpdateIfExists) {
        for (const opts of Object.values(next)) opts.update = false;
      }
      return next;
    });
  }, [initialTable, selectableTables, selectedSchema, supportsUpdateIfExists]);

  const toggleOption = useCallback(
    (table: string, option: TableOption, checked: boolean) => {
      setTableOptions((prev) => ({
        ...prev,
        [table]: applyOption(prev[table] ?? defaultTableOptions(false), option, checked),
      }));
    },
    [],
  );

  const toggleColumn = useCallback(
    (option: TableOption, checked: boolean) => {
      setTableOptions((prev) => {
        const next: Record<string, TableOptions> = { ...prev };
        selectableTables.forEach((table) => {
          const current = next[table.name] ?? defaultTableOptions(false);
          next[table.name] =
            option === "update" && !current.data
              ? current
              : applyOption(current, option, checked);
        });
        return next;
      });
    },
    [selectableTables],
  );

  // Factory for per-table cell-checkbox handlers — each row needs the table
  // name and column bound in, so a stable useCallback can't be used directly.
  const makeToggleOption = useCallback(
    (table: string, option: TableOption) => (checked: boolean) =>
      toggleOption(table, option, checked),
    [toggleOption],
  );

  // Factory for per-column header-checkbox handlers.
  const makeToggleColumn = useCallback(
    (option: TableOption) => (checked: boolean) => toggleColumn(option, checked),
    [toggleColumn],
  );

  const makeSetFormat = useCallback(
    (value: ExportFormat) => () => setFormat(value),
    [],
  );

  // Toggle one item in a Set-typed selection (views/routines/triggers).
  const toggleInSet = useCallback(
    (
      setState: React.Dispatch<React.SetStateAction<Set<string> | null>>,
      name: string,
      checked: boolean,
    ) => {
      setState((prev) => {
        const next = new Set(prev ?? []);
        if (checked) next.add(name);
        else next.delete(name);
        return next;
      });
    },
    [],
  );
  const makeToggleView = useCallback(
    (name: string) => (checked: boolean) => toggleInSet(setSelectedViews, name, checked),
    [toggleInSet],
  );
  const makeToggleRoutine = useCallback(
    (name: string) => (checked: boolean) => toggleInSet(setSelectedRoutines, name, checked),
    [toggleInSet],
  );
  const makeToggleTrigger = useCallback(
    (name: string) => (checked: boolean) => toggleInSet(setSelectedTriggers, name, checked),
    [toggleInSet],
  );
  const makeSetObjectTab = useCallback(
    (tab: ObjectTab) => () => setObjectTab(tab),
    [],
  );
  // Select-all / clear for the current object tab.
  const setAllViews = useCallback(
    (all: boolean) => setSelectedViews(all ? new Set(views) : new Set()),
    [views],
  );
  const setAllRoutines = useCallback(
    (all: boolean) =>
      setSelectedRoutines(all ? new Set(routines.map((r) => r.name)) : new Set()),
    [routines],
  );
  const setAllTriggers = useCallback(
    (all: boolean) =>
      setSelectedTriggers(all ? new Set(triggers.map((t) => t.name)) : new Set()),
    [triggers],
  );

  const columnChecked = (option: TableOption) => {
    return (
      selectableTables.length > 0 &&
      selectableTables.every((table) => {
        const opts = tableOptions[table.name] ?? defaultTableOptions(false);
        return opts[option];
      })
    );
  };

  // Formats offered for the active store. Document/KV stores (Mongo, Redis)
  // can't produce SQL dumps, so SQL is dropped for them — they get CSV/JSON.
  const availableFormats = useMemo(
    () => (supportsSql ? FORMATS : FORMATS.filter((f) => f.value !== "sql")),
    [supportsSql],
  );

  // Which option columns are meaningful for the chosen format. csv/json export
  // rows only, so they show just "Data"; the Schema/Drop/Update options are
  // SQL-only and were previously rendered as greyed-out dead checkboxes.
  const visibleColumns: TableOption[] =
    format === "sql" ? ["schema", "data", "drop", "update"] : ["data"];
  // Grid template: table-name column + one 64px slot per visible option column.
  // 64px comfortably fits the widest label ("SCHEMA"/"UPDATE") so the header
  // text doesn't overflow its cell and push the checkbox out of alignment.
  const gridTemplate = `minmax(0,1fr) ${visibleColumns.map(() => "64px").join(" ")}`;
  const columnMeta: Record<TableOption, string> = {
    schema: "Schema",
    data: "Data",
    drop: "Drop",
    update: "Update",
  };

  const submit = useCallback(async () => {
    if (!canExport || !selectedSchema) return;
    setExporting(true);
    try {
      await onExport({
        targets: selectedTargets,
        format,
        includeHeader,
        gzip,
        splitMb: splitMb > 0 ? splitMb : null,
        qualifyDatabase: format === "sql" ? qualifyDatabase : false,
        schema: selectedSchema.name,
        views: objectsApply ? [...(selectedViews ?? [])] : [],
        routines: objectsApply
          ? routines
              .filter((r) => selectedRoutines?.has(r.name))
              .map((r) => ({ name: r.name, kind: r.kind }))
          : [],
        triggers: objectsApply ? [...(selectedTriggers ?? [])] : [],
      });
      onClose();
    } finally {
      setExporting(false);
    }
  }, [
    canExport,
    selectedSchema,
    onExport,
    selectedTargets,
    format,
    includeHeader,
    gzip,
    splitMb,
    qualifyDatabase,
    objectsApply,
    selectedViews,
    selectedRoutines,
    selectedTriggers,
    routines,
    onClose,
  ]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );

  const handleSplitChange = useCallback(
    (v: string) => setSplitMb(Number(v)),
    [],
  );

  const handleTableQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setTableQuery(e.target.value),
    [],
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-205 max-h-[85vh] p-0 overflow-hidden gap-0 flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-4 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Download className="w-4 h-4 text-primary" />
            Export Data
          </DialogTitle>
          <DialogDescription>
            Pick a database and format, then choose which tables to include.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[280px_minmax(0,1fr)] flex-1 min-h-0">
          {/* ── Left: configuration ── */}
          <div className="p-5 space-y-5 border-r border-border/60 bg-muted/[0.04] overflow-y-auto">
            {/* Only worth a picker when there's more than one database — a
                single-DB connection shows it as a static label instead. */}
            {schemas.length > 1 ? (
              <Field label="Database">
                <SearchableSelect
                  value={selectedSchema?.name ?? ""}
                  onChange={setSchema}
                  options={schemas.map((s) => ({ value: s.name, label: s.name }))}
                  placeholder="Select database"
                  searchPlaceholder="Search databases…"
                  icon={<Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                />
              </Field>
            ) : selectedSchema ? (
              <Field label="Database">
                <div className="flex items-center gap-1.5 text-sm text-foreground rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{selectedSchema.name}</span>
                </div>
              </Field>
            ) : null}

            <Field label="Format">
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${availableFormats.length}, minmax(0,1fr))` }}
              >
                {availableFormats.map((f) => {
                  const active = format === f.value;
                  const Icon = f.icon;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      onClick={makeSetFormat(f.value)}
                      className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors ${
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-1.5">
                {FORMATS.find((f) => f.value === format)?.hint}
              </p>
            </Field>

            <Field label="Options">
              {format === "csv" && (
                <Option
                  checked={includeHeader}
                  onChange={setIncludeHeader}
                  label="Include header row"
                  hint="Write column names as the first row."
                />
              )}
              <Option
                checked={gzip}
                onChange={setGzip}
                label="Compress (gzip)"
                hint="Smaller file, great for large dumps."
              />
              {format === "sql" && (
                <Option
                  checked={qualifyDatabase}
                  onChange={setQualifyDatabase}
                  label="Prefix tables with database name"
                  hint="Writes db.table everywhere. Leave off to import the dump into a differently-named database (avoids 'Unknown database' errors)."
                />
              )}
            </Field>

            <Field label="Split into parts">
              <Select
                value={String(splitMb)}
                onValueChange={handleSplitChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Single file (no split)</SelectItem>
                  {[10, 25, 50, 100, 250, 500].map((mb) => (
                    <SelectItem key={mb} value={String(mb)}>
                      Split every {mb} MB
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
                {splitMb > 0
                  ? "Large exports are written as numbered part files, each a valid standalone file."
                  : "Everything goes into one file."}
              </p>
            </Field>
          </div>

          {/* ── Right: object picker (tabbed for SQL) ── */}
          <div className="min-w-0 min-h-0 flex flex-col">
            {/* Object-type tabs — SQL only. CSV/JSON export rows from one
                table, so views/routines/triggers don't apply there. */}
            {objectsApply && (
              <div className="flex items-stretch gap-1 px-2 pt-2 border-b border-border/60 shrink-0">
                <ObjectTabButton
                  active={objectTab === "tables"}
                  onClick={makeSetObjectTab("tables")}
                  icon={Table2}
                  label="Tables"
                  count={selectableTables.length}
                  selected={selectedCount}
                />
                <ObjectTabButton
                  active={objectTab === "views"}
                  onClick={makeSetObjectTab("views")}
                  icon={Eye}
                  label="Views"
                  count={views.length}
                  selected={viewCount}
                />
                <ObjectTabButton
                  active={objectTab === "routines"}
                  onClick={makeSetObjectTab("routines")}
                  icon={FunctionSquare}
                  label="Routines"
                  count={routines.length}
                  selected={routineCount}
                />
                <ObjectTabButton
                  active={objectTab === "triggers"}
                  onClick={makeSetObjectTab("triggers")}
                  icon={Zap}
                  label="Triggers"
                  count={triggers.length}
                  selected={triggerCount}
                />
              </div>
            )}

            {objectTab === "tables" ? (
              <>
                {/* Toolbar: search + count */}
                <div className="px-3 pt-3 pb-2 border-b border-border/60 space-y-2 shrink-0">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs text-muted-foreground">Tables</Label>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {selectedCount} of {selectableTables.length} selected
                    </span>
                  </div>
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={tableQuery}
                      onChange={handleTableQueryChange}
                      placeholder="Filter tables…"
                      className="pl-8 h-8 text-sm"
                    />
                  </div>
                </div>

                {/* Header + rows share ONE scroll container so they sit in the
                    exact same content box — the only reliable way to keep the
                    column checkboxes aligned (a separate, non-scrolling header
                    drifts by the scrollbar width). The header is sticky so it
                    stays visible. Both use the same `gridTemplate` + `px-3.5`. */}
                <div className="flex-1 min-h-0 overflow-auto">
                  <div
                    className="sticky top-0 z-10 bg-popover px-3.5 py-2 border-b border-border/60 grid items-end gap-1 text-[10px] uppercase tracking-wide text-muted-foreground/80"
                    style={{ gridTemplateColumns: gridTemplate }}
                  >
                    <span className="min-w-0 pb-1.5">Name</span>
                    {visibleColumns.map((col) => (
                      <HeaderCheck
                        key={col}
                        label={columnMeta[col]}
                        checked={columnChecked(col)}
                        onChange={makeToggleColumn(col)}
                        disabled={col === "update" && !supportsUpdateIfExists}
                        title={
                          col === "update" && !supportsUpdateIfExists
                            ? "Update if exists is not supported by this adapter."
                            : `Toggle ${columnMeta[col]} for all tables — ${OPTION_HELP[col]}`
                        }
                      />
                    ))}
                  </div>

                  <div className="p-1.5">
                  {selectableTables.length === 0 ? (
                    <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                      No tables available in this database.
                    </div>
                  ) : visibleTables.length === 0 ? (
                    <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                      No tables match “{tableQuery}”.
                    </div>
                  ) : (
                    visibleTables.map((table) => {
                      const opts =
                        tableOptions[table.name] ?? defaultTableOptions(false);
                      return (
                        <div
                          key={table.name}
                          className="grid items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/30"
                          style={{ gridTemplateColumns: gridTemplate }}
                        >
                          <span className="min-w-0 flex items-center gap-2">
                            <Table2 className="w-4 h-4 text-primary shrink-0" />
                            <span className="truncate font-mono">{table.name}</span>
                            {table.rowCount != null && (
                              <span className="text-[10px] text-muted-foreground/70 tabular-nums shrink-0">
                                {table.rowCount.toLocaleString()}
                              </span>
                            )}
                          </span>
                          {visibleColumns.map((col) => (
                            <CellCheck
                              key={col}
                              checked={opts[col]}
                              onChange={makeToggleOption(table.name, col)}
                              disabled={
                                col === "update" &&
                                (!supportsUpdateIfExists || !opts.data)
                              }
                              title={
                                col === "update" && !supportsUpdateIfExists
                                  ? "Update if exists is not supported by this adapter."
                                  : col === "update" && !opts.data
                                    ? "Enable Data first."
                                    : OPTION_HELP[col]
                              }
                            />
                          ))}
                        </div>
                      );
                    })
                  )}
                  </div>
                </div>
              </>
            ) : objectTab === "views" ? (
              <ObjectList
                kindLabel="views"
                items={views.map((name) => ({ name }))}
                selected={selectedViews}
                onToggle={makeToggleView}
                onSetAll={setAllViews}
                loading={false}
              />
            ) : objectTab === "routines" ? (
              <ObjectList
                kindLabel="routines"
                items={routines.map((r) => ({ name: r.name, sub: r.kind }))}
                selected={selectedRoutines}
                onToggle={makeToggleRoutine}
                onSetAll={setAllRoutines}
                loading={objectsLoading}
              />
            ) : (
              <ObjectList
                kindLabel="triggers"
                items={triggers.map((t) => ({ name: t.name, sub: `${t.timing} ${t.event} · ${t.table}` }))}
                selected={selectedTriggers}
                onToggle={makeToggleTrigger}
                onSetAll={setAllTriggers}
                loading={objectsLoading}
              />
            )}
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-border/60 bg-muted/10 px-5 py-3.5 sm:justify-between items-center shrink-0">
          <span className="text-xs text-muted-foreground">
            {csvInvalid
              ? "CSV exports a single table — select exactly one."
              : format === "json"
                ? selectedCount === 0
                  ? "Select at least one table to export."
                  : `${selectedCount.toLocaleString()} ${selectedCount === 1 ? "table" : "tables"} ready to export.`
                : totalSelected === 0
                  ? "Select at least one object to export."
                  : exportSummary(selectedCount, viewCount, routineCount, triggerCount)}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={exporting}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!canExport}>
              <Download className="w-4 h-4 mr-2" />
              {exporting ? "Exporting…" : "Export"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Footer summary line listing the counts across object types. */
function exportSummary(
  tables: number,
  views: number,
  routines: number,
  triggers: number,
): string {
  const parts: string[] = [];
  if (tables) parts.push(`${tables} ${tables === 1 ? "table" : "tables"}`);
  if (views) parts.push(`${views} ${views === 1 ? "view" : "views"}`);
  if (routines) parts.push(`${routines} ${routines === 1 ? "routine" : "routines"}`);
  if (triggers) parts.push(`${triggers} ${triggers === 1 ? "trigger" : "triggers"}`);
  return `${parts.join(", ")} ready to export.`;
}

/** One object-type tab button with a selected/total count badge. */
function ObjectTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  count,
  selected,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Table2;
  label: string;
  count: number;
  selected: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {label}
      <span className="text-[10px] tabular-nums text-muted-foreground/80">
        {selected}/{count}
      </span>
    </button>
  );
}

/** A flat checkbox list for views / routines / triggers, with a select-all
 *  toggle in the header. Items are pre-defaulted to all-checked by the modal. */
function ObjectList({
  kindLabel,
  items,
  selected,
  onToggle,
  onSetAll,
  loading,
}: {
  kindLabel: string;
  items: Array<{ name: string; sub?: string }>;
  selected: Set<string> | null;
  onToggle: (name: string) => (checked: boolean) => void;
  onSetAll: (all: boolean) => void;
  loading: boolean;
}) {
  const allChecked = items.length > 0 && items.every((it) => selected?.has(it.name));
  const selCount = selected ? items.filter((it) => selected.has(it.name)).length : 0;
  return (
    <>
      <div className="px-3.5 py-2 border-b border-border/60 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {selCount} of {items.length} selected
        </span>
        {items.length > 0 && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
            <Checkbox
              checked={allChecked}
              onCheckedChange={(v) => onSetAll(v === true)}
            />
            Select all
          </label>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-1.5">
        {loading ? (
          <div className="px-3 py-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading {kindLabel}…
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">
            No {kindLabel} in this database.
          </div>
        ) : (
          items.map((it) => (
            <label
              key={it.name}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/30 cursor-pointer"
            >
              <Checkbox
                checked={selected?.has(it.name) ?? false}
                onCheckedChange={(v) => onToggle(it.name)(v === true)}
              />
              <span className="truncate font-mono">{it.name}</span>
              {it.sub && (
                <span className="text-[10px] text-muted-foreground/70 truncate shrink-0">
                  {it.sub}
                </span>
              )}
            </label>
          ))
        )}
      </div>
    </>
  );
}

function defaultTableOptions(selected: boolean): TableOptions {
  return {
    schema: false,
    data: selected,
    drop: false,
    update: false,
  };
}

function applyOption(
  current: TableOptions,
  option: TableOption,
  checked: boolean,
): TableOptions {
  if (option === "update" && !current.data) return current;
  if (option === "data" && !checked) {
    return { ...current, data: false, update: false };
  }
  return { ...current, [option]: checked };
}

function HeaderCheck({
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title: string;
}) {
  const handleCheckedChange = useCallback(
    (value: boolean | "indeterminate") => onChange(value === true),
    [onChange],
  );
  return (
    <label
      className={`flex flex-col items-center gap-2 ${
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"
      }`}
      title={title}
    >
      <span className="leading-none whitespace-nowrap">{label}</span>
      <Checkbox
        aria-label={`${label}: ${title}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleCheckedChange}
      />
    </label>
  );
}

function CellCheck({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title: string;
}) {
  const handleCheckedChange = useCallback(
    (value: boolean | "indeterminate") => onChange(value === true),
    [onChange],
  );
  return (
    <span className="flex justify-center" title={title}>
      <Checkbox
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleCheckedChange}
      />
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Option({
  checked,
  onChange,
  label,
  disabled,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  hint?: string;
}) {
  const handleCheckedChange = useCallback(
    (value: boolean | "indeterminate") => onChange(value === true),
    [onChange],
  );
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-muted/30"
      }`}
      title={hint}
    >
      <span className="min-w-0">
        <span>{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleCheckedChange}
      />
    </label>
  );
}
