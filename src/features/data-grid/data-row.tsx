import { memo, useCallback, useEffect } from "react";
import { validateEditorValue, type EditorKind } from "./editor-kinds";
import { type NullDisplay } from "../../lib/settings-store";
import { copyText } from "../../lib/clipboard";
import { CellEditor } from "./cell-editors";
import {
  type GridRow,
  KEY_SEP,
  BLOB_TYPE_RE,
  truncateForCell,
  CELL_MAX_RENDER_CHARS,
} from "./data-grid-utils";
import { isPreviewMarker, formatPreviewMarker } from "./preview-marker";

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

export const DataRow = memo(function DataRow({
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

  const handleRowClick = useCallback(
    (e: React.MouseEvent) => onRowClick(row.__rowId, e),
    [onRowClick, row.__rowId],
  );
  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent) => onOpenMenu(e, row.__rowId, null),
    [onOpenMenu, row.__rowId],
  );

  return (
    <tr
      data-row-id={row.__rowId}
      className={`border-b border-border group cursor-pointer ${rowBg}`}
      onClick={handleRowClick}
      onContextMenu={handleRowContextMenu}
    >
      <td
        className={`p-0 border-r border-border text-center whitespace-nowrap select-none ${indexBg}`}
      >
        <div className="block px-4 py-1.5 w-full h-full">{indexLabel}</div>
      </td>
      {cols.map((col) => (
        <DataCell
          key={col}
          row={row}
          col={col}
          columnKinds={columnKinds}
          columnDataTypes={columnDataTypes}
          requiredColumnNames={requiredColumnNames}
          editedCells={editedCells}
          activeEdit={activeEdit}
          nullDisplay={nullDisplay}
          onOpenMenu={onOpenMenu}
          onBeginEdit={onBeginEdit}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          onActiveEditChange={onActiveEditChange}
          inputRef={inputRef}
        />
      ))}
    </tr>
  );
});

interface DataCellProps {
  row: GridRow;
  col: string;
  columnKinds: Record<string, EditorKind>;
  columnDataTypes: Record<string, string>;
  requiredColumnNames: Set<string>;
  editedCells: Record<string, unknown>;
  activeEdit: { rowId: string; col: string; value: string } | null;
  nullDisplay: NullDisplay;
  onOpenMenu: (e: React.MouseEvent, rowId: string, col: string | null) => void;
  onBeginEdit: (rowId: string, col: string, value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onActiveEditChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function DataCell({
  row,
  col,
  columnKinds,
  columnDataTypes,
  requiredColumnNames,
  editedCells,
  activeEdit,
  nullDisplay,
  onOpenMenu,
  onBeginEdit,
  onCommitEdit,
  onCancelEdit,
  onActiveEditChange,
  inputRef,
}: DataCellProps) {
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
  // Oversized values come back from browse as a preview stub (see
  // preview-marker.ts): the backend didn't ship the full value to keep the
  // page small. Render a friendly summary and treat the cell as read-only —
  // the real value is reachable by opening the row's JSON view, which fetches
  // the full document on demand.
  const isPreview = isPreviewMarker(rawValue);
  // Real cell value is always '' for NULL (edit/length/blob logic keys off
  // an empty string); the NULL marker is purely a display concern.
  const fullValue = isNull
    ? ""
    : isPreview
      ? formatPreviewMarker(rawValue)
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

  const handleDoubleClick = useCallback(() => {
    // A preview stub isn't the real value — editing the summary string would
    // write garbage back. Open the row's JSON view to see/edit the full doc.
    if (isPreview) return;
    // Editing a BLOB in a tiny text box would corrupt it — bail.
    if (isBlobCol && fullValue.length > 0) return;
    // Huge text values open the editor fine, but we pass the full
    // value so the user can actually edit what's there, not the
    // truncated display string.
    onBeginEdit(row.__rowId, col, fullValue);
  }, [isPreview, isBlobCol, fullValue, onBeginEdit, row.__rowId, col]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onOpenMenu(e, row.__rowId, col);
    },
    [onOpenMenu, row.__rowId, col],
  );
  const handleCommit = useCallback(() => {
    if (validateEditorValue(kind, activeEdit!.value) !== null) return;
    onCommitEdit();
  }, [kind, activeEdit, onCommitEdit]);

  return (
    <td
      className={`p-0 border-r border-border font-mono text-xs align-top min-w-40 max-w-100 ${cellBg}`}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      title={tooltip}
    >
      {isCurrentlyEditing ? (
        <CellEditor
          kind={kind}
          value={activeEdit.value}
          inputRef={inputRef}
          error={error}
          onChange={onActiveEditChange}
          onCommit={handleCommit}
          onCancel={onCancelEdit}
        />
      ) : (
        <div
          className={`px-4 py-1.5 truncate ${(isBlobCol && fullValue.length > 0) || isPreview ? "italic text-muted-foreground" : ""} ${isNull && nullMarker ? "text-muted-foreground/40" : ""}`}
        >
          {isNull && nullMarker ? nullMarker : value}
          {didTruncate && !isBlobCol && (
            <span className="ml-2 text-[10px] text-muted-foreground/70 not-italic">
              +
              {(fullValue.length - CELL_MAX_RENDER_CHARS).toLocaleString()}{" "}
              more
            </span>
          )}
        </div>
      )}
    </td>
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
  onDuplicateRow: (rowId: string) => void;
}

export function SharedContextMenu({
  state,
  onClose,
  rows,
  pendingDeletes,
  editedCells,
  onBeginEdit,
  onUndoRowDelete,
  onDiscardInsert,
  onSetNull,
  onDuplicateRow,
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

  const handleEditCell = () =>
    act(() => onBeginEdit(state.rowId, state.col!, cellValue));
  const handleCopyValue = () =>
    act(() => {
      void copyText(cellValue, "Value copied");
    });
  const handleSetNull = () => act(() => onSetNull(state.rowId, state.col!));
  const handleCopyRowAsJson = () =>
    act(() => {
      void copyText(JSON.stringify(row, null, 2), "Row copied as JSON");
    });
  const handleDuplicateRow = () => act(() => onDuplicateRow(state.rowId));
  const handleDiscardInsert = () => act(() => onDiscardInsert(state.rowId));
  const handleUndoRowDelete = () => act(() => onUndoRowDelete(state.rowId));

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
          <button className={itemCls} onClick={handleEditCell}>
            Edit Cell
          </button>
          <button className={itemCls} onClick={handleCopyValue}>
            Copy Value
          </button>
          <div className={sepCls} />
          <button className={itemCls} onClick={handleSetNull}>
            Set to NULL
          </button>
          <button className={itemCls} onClick={handleCopyRowAsJson}>
            Copy Row as JSON
          </button>
          <button className={itemCls} onClick={handleDuplicateRow}>
            Duplicate row
          </button>
        </>
      ) : (
        <>
          {isDraft ? (
            <button className={itemCls} onClick={handleDiscardInsert}>
              Discard new row
            </button>
          ) : isPendingDelete ? (
            <button className={itemCls} onClick={handleUndoRowDelete}>
              Undo delete
            </button>
          ) : (
            <button className={itemCls} onClick={onClose}>
              View Record
            </button>
          )}
          <div className={sepCls} />
          <button className={itemCls} onClick={handleCopyRowAsJson}>
            Copy Row as JSON
          </button>
          <button className={itemCls} onClick={handleDuplicateRow}>
            Duplicate row
          </button>
        </>
      )}
    </div>
  );
}
