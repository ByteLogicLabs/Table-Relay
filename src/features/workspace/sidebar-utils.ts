import { db } from "../../lib/db";
import type { Dialect } from "../data-grid/editor-kinds";

export type SectionKey = "tables" | "views" | "routines" | "triggers";

export function quoteIdentForDialect(
  ident: string,
  dialect: "mysql" | "postgres" | "sqlite" | "generic" | "none",
): string {
  if (dialect === "mysql") return "`" + ident.replace(/`/g, "``") + "`";
  return '"' + ident.replace(/"/g, '""') + '"';
}

export function toTitleCaseLabel(raw: string): string {
  // Display-only prettifier for DB names in the sidebar header.
  // Keeps underlying schema/database identifiers untouched for queries.
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

// Fetch the DDL for a view / routine via `SHOW CREATE ...` and hand it to
// the workspace to open as a pre-filled editor tab. We scaffold the output
// as `CREATE OR REPLACE` (views) or `DROP + CREATE` wrapped in DELIMITER
// directives (routines) so the user can just hit Run to apply edits.
export const pickDdlColumn = (
  columns: { name: string }[],
  label: string,
): number => {
  const target = label.toLowerCase();
  return columns.findIndex((c) => c.name.toLowerCase() === target);
};

/**
 * Fetch a view's definition and return a runnable, editable SQL script
 * (a `CREATE OR REPLACE` / `DROP + CREATE`, dialect-specific). Shared by the
 * sidebar's "Edit definition" and the data-grid toolbar's "Edit" so both open
 * the exact same script tab. Throws on failure — the caller decides how to
 * surface it (toast / log).
 */
export async function loadViewDefinitionSql(
  connectionId: string,
  dbName: string,
  viewName: string,
  dialect: Dialect,
): Promise<string> {
  if (dialect === "postgres") {
    // Postgres has no SHOW CREATE. `pg_get_viewdef` returns the SELECT body;
    // wrap it into a CREATE OR REPLACE VIEW so the editor can run it back.
    const qualified = `${quoteIdentForDialect(dbName, dialect)}.${quoteIdentForDialect(viewName, dialect)}`;
    const res = await db.runQuery(
      connectionId,
      `SELECT pg_get_viewdef('${qualified.replace(/'/g, "''")}'::regclass, true) AS def`,
    );
    const last = res.statements[res.statements.length - 1];
    if (!last || last.error)
      throw new Error(last?.error ?? "no definition returned");
    const body = last.rows[0]?.[0];
    if (typeof body !== "string")
      throw new Error("definition not found in response");
    return `CREATE OR REPLACE VIEW ${qualified} AS\n${body.trim()}\n`;
  }
  if (dialect === "sqlite") {
    // SQLite stores the original CREATE VIEW text in sqlite_master.
    const res = await db.runQuery(
      connectionId,
      `SELECT sql FROM sqlite_master WHERE type='view' AND name='${viewName.replace(/'/g, "''")}'`,
    );
    const last = res.statements[res.statements.length - 1];
    if (!last || last.error)
      throw new Error(last?.error ?? "no definition returned");
    const ddl = last.rows[0]?.[0];
    if (typeof ddl !== "string")
      throw new Error("definition not found in response");
    return `DROP VIEW IF EXISTS ${quoteIdentForDialect(viewName, dialect)};\n\n${ddl.trim()};\n`;
  }
  // MySQL / generic: SHOW CREATE VIEW. No row limit — it rejects a trailing
  // LIMIT.
  const res = await db.runQuery(
    connectionId,
    `SHOW CREATE VIEW \`${dbName}\`.\`${viewName}\``,
  );
  const last = res.statements[res.statements.length - 1];
  if (!last || last.error)
    throw new Error(last?.error ?? "no definition returned");
  const idx = pickDdlColumn(last.columns, "Create View");
  const ddl = idx >= 0 ? last.rows[0]?.[idx] : null;
  if (typeof ddl !== "string")
    throw new Error("definition not found in response");
  // MySQL returns `CREATE ALGORITHM=... DEFINER=... VIEW ... AS ...`.
  const replaced = ddl.replace(/^CREATE\s+/i, "CREATE OR REPLACE ");
  return `USE \`${dbName}\`;\n\n${replaced};\n`;
}
