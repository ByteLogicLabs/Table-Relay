import { ChevronDown, Loader2, Plus, RefreshCw } from "lucide-react";

export function Section({
  label,
  count,
  loading,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  onRefresh,
  refreshing,
}: {
  label: string;
  count: number;
  loading?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** Optional create-new action shown as a `+` on the right of the row. */
  onAdd?: () => void;
  addTitle?: string;
  /** Optional re-sync action shown as a refresh icon on hover. */
  onRefresh?: () => void;
  /** Spin the refresh icon while this section's list is being refetched. */
  refreshing?: boolean;
}) {
  return (
    <div className="group/section w-full flex items-center gap-1 px-2 py-1 text-[11px] tracking-wide text-muted-foreground hover:text-foreground transition-colors">
      <button
        onClick={onToggle}
        className="flex items-center gap-1 flex-1 min-w-0 text-left"
      >
        <ChevronDown
          className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        {/* `capitalize` title-cases the single-word section labels
            (tables → Tables) without touching the call sites. */}
        <span className="truncate capitalize">{label}</span>
      </button>
      {onRefresh && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!refreshing) onRefresh();
          }}
          title={`Refresh ${label}`}
          disabled={refreshing}
          className={`p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity ${
            refreshing
              ? "opacity-100"
              : "opacity-0 group-hover/section:opacity-100"
          }`}
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      )}
      {loading ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <span className="tabular-nums">{count}</span>
      )}
      {onAdd && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          title={addTitle ?? "Add"}
          className="opacity-0 group-hover/section:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
