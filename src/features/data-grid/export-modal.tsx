import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { Download, Table2, Search, FileSpreadsheet, Braces, Database } from "lucide-react";
import type { SchemaInfo } from "../../lib/db";

export type ExportFormat = "csv" | "json" | "sql";

export interface ExportTarget {
  schema: string;
  table: string;
  includeSchema: boolean;
  includeData: boolean;
  dropIfExists: boolean;
  updateIfExists: boolean;
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

export default function ExportModal({
  isOpen,
  onClose,
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
  // Split output into multiple part files once a part crosses this many MB.
  // 0 = single file (no split). Configured before export.
  const [splitMb, setSplitMb] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [tableQuery, setTableQuery] = useState("");

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
  const csvInvalid = format === "csv" && selectedCount !== 1;
  const canExport =
    selectedSchema &&
    selectedCount > 0 &&
    !csvInvalid &&
    !exporting;

  useEffect(() => {
    if (!isOpen) return;
    setSchema(initialSchema);
    setTableOptions({ [initialTable]: defaultTableOptions(true) });
    setFormat("csv");
    setTableQuery("");
    setGzip(false);
    setSplitMb(0);
  }, [initialSchema, initialTable, isOpen]);

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

  const toggleOption = (table: string, option: TableOption, checked: boolean) => {
    setTableOptions((prev) => ({
      ...prev,
      [table]: applyOption(prev[table] ?? defaultTableOptions(false), option, checked),
    }));
  };

  const toggleColumn = (option: TableOption, checked: boolean) => {
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
  };

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

  const submit = async () => {
    if (!canExport || !selectedSchema) return;
    setExporting(true);
    try {
      await onExport({
        targets: selectedTargets,
        format,
        includeHeader,
        gzip,
        splitMb: splitMb > 0 ? splitMb : null,
      });
      onClose();
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
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
                      onClick={() => setFormat(f.value)}
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
            </Field>

            <Field label="Split into parts">
              <Select
                value={String(splitMb)}
                onValueChange={(v) => setSplitMb(Number(v))}
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

          {/* ── Right: table picker ── */}
          <div className="min-w-0 min-h-0 flex flex-col">
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
                  onChange={(e) => setTableQuery(e.target.value)}
                  placeholder="Filter tables…"
                  className="pl-8 h-8 text-sm"
                />
              </div>
            </div>

            {/* Header + rows share ONE scroll container so they sit in the exact
                same content box — the only reliable way to keep the column
                checkboxes aligned (a separate, non-scrolling header drifts by the
                scrollbar width). The header is sticky so it stays visible. Both
                use the same `gridTemplate` and the same `px-3.5` inset. */}
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
                    onChange={(checked) => toggleColumn(col, checked)}
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
                          onChange={(checked) =>
                            toggleOption(table.name, col, checked)
                          }
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
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-border/60 bg-muted/10 px-5 py-3.5 sm:justify-between items-center shrink-0">
          <span className="text-xs text-muted-foreground">
            {csvInvalid
              ? "CSV exports a single table — select exactly one."
              : selectedCount === 0
                ? "Select at least one table to export."
                : `${selectedCount.toLocaleString()} ${selectedCount === 1 ? "table" : "tables"} ready to export.`}
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
        onCheckedChange={(value) => onChange(value === true)}
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
  return (
    <span className="flex justify-center" title={title}>
      <Checkbox
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
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
        onCheckedChange={(value) => onChange(value === true)}
      />
    </label>
  );
}
