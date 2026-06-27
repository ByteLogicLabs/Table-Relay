import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, Loader2, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Input } from './input';
import { cn } from '@/src/lib/utils';

export interface SearchableSelectOption {
  value: string;
  label: string;
}

/**
 * A trigger-button dropdown with a filter box and a scrollable option list.
 * Matches the app's Select styling but adds search and full keyboard nav
 * (Arrow Up/Down to move, Enter to pick, Esc to close) driven from the search
 * input — used where a connection may have many databases/tables, or to pick a
 * model id.
 */
export function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  icon,
  disabled,
  className,
  allowCustom = false,
  loading = false,
  loadingLabel = 'Loading…',
}: {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** When true, an exact-match-free query can be committed verbatim (a "Use
   *  '<query>'" row appears). Lets the user enter a value not in `options` —
   *  e.g. a CLI model id newer than our curated list. */
  allowCustom?: boolean;
  /** Show a loading row in the open list while options are still being fetched
   *  (e.g. a CLI model catalog spawned via subprocess). */
  loading?: boolean;
  /** Text shown next to the spinner while `loading`. */
  loadingLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Index of the keyboard-highlighted row across the combined list
  // (filtered options first, then the optional "Use '<query>'" custom row).
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  // A selected value not present in `options` (a custom entry) still shows in
  // the trigger.
  const selectedLabel = selected?.label ?? (value || null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);
  const trimmedQuery = query.trim();
  const showCustom =
    allowCustom &&
    trimmedQuery.length > 0 &&
    !options.some((o) => o.value.toLowerCase() === trimmedQuery.toLowerCase());

  // The total number of selectable rows (options + maybe the custom row).
  const rowCount = filtered.length + (showCustom ? 1 : 0);

  // Keep the highlight valid as the filtered list changes (e.g. while typing).
  // Default to the currently-selected option when the list first shows.
  useEffect(() => {
    if (!open) return;
    const selIdx = filtered.findIndex((o) => o.value === value);
    setActiveIndex(selIdx >= 0 ? selIdx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(i, 0), Math.max(rowCount - 1, 0)));
  }, [rowCount]);

  // Scroll the active row into view as it moves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const commit = useCallback(
    (idx: number) => {
      if (idx < filtered.length) {
        onChange(filtered[idx].value);
      } else if (showCustom) {
        onChange(trimmedQuery);
      }
      setOpen(false);
    },
    [filtered, showCustom, onChange, trimmedQuery],
  );

  // Factory handlers for per-row events inside the option .map() (and the
  // custom row), which close over the row index.
  const makeHandleRowClick = useCallback((idx: number) => () => commit(idx), [commit]);
  const makeHandleRowMouseMove = useCallback(
    (idx: number) => () => setActiveIndex(idx),
    [],
  );

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    [],
  );

  const handleOpenChange = useCallback((o: boolean) => {
    setOpen(o);
    if (o) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, []);

  const onInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rowCount > 0) setActiveIndex((i) => (i + 1) % rowCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rowCount > 0) setActiveIndex((i) => (i - 1 + rowCount) % rowCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rowCount > 0) commit(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }, [rowCount, commit, activeIndex]);

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
    >
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          'flex h-9 w-full items-center gap-1.5 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors outline-none',
          'hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        {icon}
        <span className={cn('flex-1 truncate text-left', !selectedLabel && 'text-muted-foreground')}>
          {selectedLabel ?? placeholder}
        </span>
        <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) min-w-56 p-0 gap-0">
        <div className="relative border-b border-border/60">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={handleQueryChange}
            onKeyDown={onInputKeyDown}
            placeholder={searchPlaceholder}
            className="h-9 pl-8 text-sm border-0 rounded-none shadow-none focus-visible:ring-0 focus-visible:border-0"
          />
        </div>
        <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {loadingLabel}
            </div>
          )}
          {!loading && filtered.length === 0 && !showCustom && (
            <div className="py-6 text-center text-xs text-muted-foreground">No matches.</div>
          )}
          {filtered.length > 0 &&
            filtered.map((o, idx) => (
              <button
                key={o.value}
                type="button"
                data-idx={idx}
                onClick={makeHandleRowClick(idx)}
                onMouseMove={makeHandleRowMouseMove(idx)}
                className={cn(
                  'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left transition-colors',
                  idx === activeIndex && 'bg-muted/60',
                  o.value === value ? 'text-primary' : '',
                )}
              >
                <Check className={cn('w-3.5 h-3.5 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          {showCustom && (
            <button
              type="button"
              data-idx={filtered.length}
              onClick={makeHandleRowClick(filtered.length)}
              onMouseMove={makeHandleRowMouseMove(filtered.length)}
              className={cn(
                'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left transition-colors border-t border-border/40 mt-1',
                activeIndex === filtered.length && 'bg-muted/60',
              )}
            >
              <Check className="w-3.5 h-3.5 shrink-0 opacity-0" />
              <span className="truncate">
                Use “<span className="font-mono">{trimmedQuery}</span>”
              </span>
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
