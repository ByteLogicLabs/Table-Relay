export type SectionKey = "tables" | "views" | "routines";

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
