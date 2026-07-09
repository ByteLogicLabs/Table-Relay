import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * Column resizing for plain HTML tables. The strategy: let the table lay out in
 * `auto` mode once so columns size naturally to their content, snapshot those
 * widths, then flip to `table-layout: fixed` and drive every column width from
 * a `<colgroup>`. Fixed layout makes the `<col>` widths authoritative and lets
 * (already-truncating) cells clip cleanly, so resizing never fights cell
 * min/max-width rules.
 *
 * `keys` are the resizable data columns in render order. Any leading fixed
 * columns (a row-number / checkbox gutter) are counted via `leadingCols` so
 * measurement reads the right `<th>` offsets.
 */
export function useColumnWidths(keys: string[], headerRowRef: React.RefObject<HTMLTableRowElement | null>, leadingCols = 0) {
  const [widths, setWidths] = useState<Record<string, number>>({});

  // Seed any not-yet-measured column from its natural auto-layout width. Runs
  // after layout so `getBoundingClientRect` reflects real widths. When new
  // columns appear, `allMeasured` briefly drops (table returns to auto) so they
  // get a natural width too, then we re-lock to fixed.
  useLayoutEffect(() => {
    const row = headerRowRef.current;
    if (!row) return;
    const ths = row.querySelectorAll('th');
    setWidths((prev) => {
      let changed = false;
      const next = { ...prev };
      keys.forEach((k, i) => {
        if (next[k] == null) {
          const th = ths[i + leadingCols] as HTMLElement | undefined;
          if (th) {
            next[k] = Math.round(th.getBoundingClientRect().width);
            changed = true;
          }
        }
      });
      // Drop widths for columns that no longer exist so the map can't grow
      // without bound across schema changes.
      for (const k of Object.keys(next)) {
        if (!keys.includes(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [keys, headerRowRef, leadingCols]);

  const setWidth = useCallback((key: string, w: number) => {
    setWidths((prev) => ({ ...prev, [key]: w }));
  }, []);

  const allMeasured = keys.length > 0 && keys.every((k) => widths[k] != null);

  return { widths, setWidth, allMeasured };
}

/**
 * A drag handle pinned to the right edge of a `<th>`. Measures the header cell
 * on pointer-down and reports the new width as the pointer moves. The parent
 * `<th>` must be `position: relative`.
 */
export function ColumnResizeHandle({ min = 56, onWidth }: { min?: number; onWidth: (w: number) => void }) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Don't let the drag trigger the header's own click (sort) handler.
      e.preventDefault();
      e.stopPropagation();
      const th = e.currentTarget.parentElement as HTMLElement | null;
      if (!th) return;
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      const onMove = (ev: PointerEvent) => {
        onWidth(Math.max(min, Math.round(startW + (ev.clientX - startX))));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [min, onWidth],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 right-0 z-20 h-full w-1.5 translate-x-1/2 cursor-col-resize select-none hover:bg-primary/40 active:bg-primary/60"
    />
  );
}
