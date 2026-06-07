import { db, type TableStructure } from "../../lib/db";
import { ensureTableStructure } from "../../state/connections";
import { ExportWriter } from "./export-writer";
import { csvCell } from "./data-grid-utils";
import type { ExportConfig } from "./export-modal";

/**
 * Streaming data export, decoupled from the data-grid so it can run from a
 * table tab OR a connection-level dialog (no open tab required). Pages each
 * table from the DB and writes CSV / JSON / SQL straight to disk, splitting
 * into part files and gzipping when configured. Memory stays flat regardless
 * of table size.
 */
export type ExportDialect = "mysql" | "postgres" | "sqlite" | null;

export interface RunExportArgs {
  connectionId: string;
  dialect: ExportDialect;
  config: ExportConfig;
  path: string;
  /** Split output into multiple part files past this many bytes (null = single). */
  splitBytes: number | null;
  /** Progress callback as rows stream out. */
  onProgress?: (p: { rows: number; total: number | null; table: string }) => void;
  /** Cooperative cancel — checked between pages/rows. */
  cancelRef: { current: boolean };
}

/** Quote an identifier for the active dialect. */
function makeQuoteIdent(dialect: ExportDialect) {
  if (dialect === "mysql") return (s: string) => `\`${s.replace(/`/g, "``")}\``;
  return (s: string) => `"${s.replace(/"/g, '""')}"`;
}

/** Run an export. Returns the number of part files written. */
export async function runExport(args: RunExportArgs): Promise<number> {
  const { connectionId, dialect, config, path, splitBytes, onProgress, cancelRef } = args;
  const qi = makeQuoteIdent(dialect);

  const qualifiedTableName = (schema: string, table: string) =>
    schema ? `${qi(schema)}.${qi(table)}` : qi(table);

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

  const buildUpsertClause = (cols: string[], primaryKey: string[]) => {
    const updateCols =
      primaryKey.length > 0 ? cols.filter((col) => !primaryKey.includes(col)) : cols;
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

  const streamRowsForExport = async (
    targetSchema: string,
    targetTable: string,
    onPage: (cols: string[], rows: Record<string, unknown>[], isFirstPage: boolean) => Promise<void>,
  ) => {
    const pageSize = 1000;
    let pageNumber = 1;
    let cols: string[] = [];
    let total: number | null = null;
    let fetched = 0;
    for (;;) {
      if (cancelRef.current) return;
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
      onProgress?.({ rows: fetched, total, table: targetTable });
      if (cancelRef.current) return; // stop before fetching the next page
      if (batch.length < pageSize) break;
      if (total !== null && fetched >= total) break;
      pageNumber += 1;
    }
  };

  // ── CSV ────────────────────────────────────────────────────────────────────
  if (config.format === "csv") {
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
          if (cancelRef.current) return;
          await writer.write(cols.map((c) => csvCell(row[c])).join(",") + "\n");
          await writer.maybeRollover();
        }
      });
      return writer.parts;
    } finally {
      await writer.close();
    }
  }

  // ── JSON ───────────────────────────────────────────────────────────────────
  if (config.format === "json") {
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
        if (cancelRef.current) break;
        await closeArray();
        await writer.maybeRollover();
        await openArray();
        await streamRowsForExport(target.schema, target.table, async (cols, rows) => {
          for (const row of rows) {
            if (cancelRef.current) return;
            const obj: Record<string, unknown> = {};
            cols.forEach((c) => {
              obj[c] = row[c] ?? null;
            });
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

  // ── SQL ────────────────────────────────────────────────────────────────────
  let currentPreamble = "";
  const writer = await ExportWriter.create(path, config.gzip, splitBytes, {
    onNewPart: async () => {
      if (currentPreamble) await writer.write(currentPreamble);
    },
  });
  try {
    for (const target of config.targets) {
      if (cancelRef.current) break;
      const qualified = qualifiedTableName(target.schema, target.table);
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
          if (cancelRef.current) return;
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
}

/** Build the default save-dialog filename + filter for a config. */
export function exportFileMeta(config: ExportConfig) {
  const ext = config.format + (config.gzip ? ".gz" : "");
  const first = config.targets[0];
  const safeTarget =
    config.targets.length === 1
      ? `${first.schema}_${first.table}`.replace(/[^\w.-]+/g, "_")
      : `${first.schema}_export`.replace(/[^\w.-]+/g, "_");
  const filter =
    config.format === "json"
      ? { name: "JSON", extensions: config.gzip ? ["json.gz"] : ["json"] }
      : config.format === "sql"
        ? { name: "SQL", extensions: config.gzip ? ["sql.gz"] : ["sql"] }
        : { name: "CSV", extensions: config.gzip ? ["csv.gz"] : ["csv"] };
  return { defaultPath: `${safeTarget}.${ext}`, filter };
}
