/**
 * Lightweight skeleton placeholders shown while real content loads, so the
 * UI looks like data is materializing instead of flashing a spinner on an
 * empty pane. Pure CSS shimmer via Tailwind's `animate-pulse` — no deps.
 */

/** A single shimmering bar. `w` accepts any Tailwind width class. */
export function SkeletonBar({ w = 'w-full', className = '' }: { w?: string; className?: string }) {
  return <div className={`h-3 rounded bg-muted-foreground/15 animate-pulse ${w} ${className}`} />;
}

/**
 * Sidebar table/collection list skeleton — a stack of rows, each with a small
 * icon block + a label bar of varied width so it reads as a list.
 */
export function SidebarListSkeleton({ rows = 8 }: { rows?: number }) {
  // Deterministic varied widths so it looks organic without Math.random
  // (which is also banned in some of our runtimes).
  const widths = ['w-3/4', 'w-1/2', 'w-2/3', 'w-4/5', 'w-1/2', 'w-3/5', 'w-3/4', 'w-2/5'];
  return (
    <div className="px-2 py-1 space-y-1" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <div className="w-3.5 h-3.5 rounded-sm bg-muted-foreground/15 animate-pulse shrink-0" />
          <SkeletonBar w={widths[i % widths.length]} />
        </div>
      ))}
    </div>
  );
}

/**
 * Data-grid skeleton — a header strip + N shimmering rows × M columns, so the
 * main pane shows a table taking shape while the first page loads.
 */
export function GridSkeleton({ rows = 12, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="absolute inset-0 overflow-hidden p-0" aria-hidden>
      {/* Header strip */}
      <div className="flex border-b border-border bg-muted/20">
        <div className="w-14 h-9 border-r border-border shrink-0" />
        {Array.from({ length: cols }).map((_, c) => (
          <div key={c} className="flex-1 h-9 border-r border-border flex items-center px-3">
            <SkeletonBar w="w-2/3" />
          </div>
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex border-b border-border/60">
          <div className="w-14 h-8 border-r border-border/60 shrink-0 flex items-center justify-center">
            <SkeletonBar w="w-4" />
          </div>
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="flex-1 h-8 border-r border-border/60 flex items-center px-3">
              {/* Stagger widths per cell so the grid doesn't look like a barcode. */}
              <SkeletonBar w={['w-1/2', 'w-3/4', 'w-1/3', 'w-2/3', 'w-1/2'][(r + c) % 5]} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
