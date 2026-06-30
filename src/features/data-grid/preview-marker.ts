// Preview markers for oversized field values.
//
// Adapters whose documents can grow huge (Mongo) don't ship every byte of
// every field when browsing a page — a 50-row grid page of multi-MB documents
// would otherwise transfer hundreds of MB and serialize for seconds, even
// though the grid only renders a collapsed cell. Instead the backend collapses
// any oversized top-level field value to a compact marker object:
//
//   { __tableRelayPreview: true, kind: "array"|"object"|"binData", approxBytes, count? }
//
// The grid renders these as a friendly stub and lazy-loads the full record via
// `db.getRecord` the moment the user opens / edits that row. Keep this shape in
// sync with `preview_stub` in src-adapters/mongo/backend/src/mongo.rs.

export interface PreviewMarker {
  __tableRelayPreview: true;
  kind: "array" | "object" | "binData" | "value";
  approxBytes: number;
  count?: number;
}

/** True when `v` is a backend preview stub standing in for an oversized value. */
export function isPreviewMarker(v: unknown): v is PreviewMarker {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __tableRelayPreview?: unknown }).__tableRelayPreview === true
  );
}

/** True when any cell of `row` is a preview stub (so the full record must be
 *  fetched before showing / editing the row). */
export function rowHasPreview(row: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (k === "__rowId") continue;
    if (isPreviewMarker(v)) return true;
  }
  return false;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Short, human-readable label for a preview stub cell. */
export function formatPreviewMarker(m: PreviewMarker): string {
  const size = humanBytes(m.approxBytes);
  const count = (m.count ?? 0).toLocaleString();
  switch (m.kind) {
    case "array":
      return `[array · ${count} items · ${size}]`;
    case "object":
      return `{object · ${count} fields · ${size}}`;
    case "binData":
      return `[binary · ${size}]`;
    default:
      return `[large value · ${size}]`;
  }
}
