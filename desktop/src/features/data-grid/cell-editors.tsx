import { useState, useRef, useEffect, useCallback } from "react";
import {
  Check,
  Calendar as CalendarIcon,
  Clock as ClockIcon,
  ChevronDown,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { Calendar } from "../../components/ui/calendar";
import { type EditorKind } from "./editor-kinds";
import {
  parseDateTimeString,
  pad,
  formatDate,
  formatDateTime,
} from "./data-grid-utils";

/* ---------- Type-aware cell editor ---------- */

interface CellEditorProps {
  kind: EditorKind;
  value: string;
  error: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function CellEditor({
  kind,
  value,
  error,
  inputRef,
  onChange,
  onCommit,
  onCancel,
}: CellEditorProps) {
  const baseCls = `w-full h-full px-4 py-1.5 bg-background text-foreground outline-none border-2 ${
    error ? "border-destructive" : "border-primary"
  }`;
  const keyHandler = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") onCommit();
      else if (e.key === "Escape") onCancel();
    },
    [onCommit, onCancel],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    [onChange],
  );

  const wrap = (node: React.ReactNode) => (
    <div className="relative" title={error ?? undefined}>
      {node}
      {error && (
        <div className="absolute left-0 right-0 top-full z-30 px-2 py-1 text-[11px] bg-destructive text-destructive-foreground shadow-md">
          {error}
        </div>
      )}
    </div>
  );

  // boolean + enum use a self-contained inline dropdown (SelectCellEditor).
  // It renders its option list in-tree (no portal) so picking a value can't
  // race with the grid's outside-click/blur commit logic — the failure mode
  // the portaled Base UI <Select> hit, which made the dropdown feel dead.
  if (kind.kind === "boolean") {
    // Normalize any truthy/falsy string the data pipeline may have produced
    // (e.g. JS booleans get stringified as "true"/"false") into the canonical
    // MySQL values "1" / "0" for display in the select.
    const normalized = /^(1|true|yes|on)$/i.test(value)
      ? "1"
      : /^(0|false|no|off)$/i.test(value)
        ? "0"
        : value === ""
          ? ""
          : value;
    return wrap(
      <SelectCellEditor
        value={normalized}
        options={[
          { value: "1", label: "true (1)" },
          { value: "0", label: "false (0)" },
        ]}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
        error={error}
      />,
    );
  }

  if (kind.kind === "enum") {
    return wrap(
      <SelectCellEditor
        value={value}
        options={kind.options.map((o) => ({ value: o, label: o }))}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
        error={error}
      />,
    );
  }

  if (kind.kind === "number") {
    return wrap(
      <input
        ref={inputRef}
        type="number"
        step={kind.integer ? 1 : "any"}
        min={kind.min}
        max={kind.max}
        className={baseCls}
        value={value}
        onChange={handleInputChange}
        onBlur={onCommit}
        onKeyDown={keyHandler}
      />,
    );
  }

  if (kind.kind === "date" || kind.kind === "datetime") {
    return wrap(
      <DateTimeCellEditor
        mode={kind.kind}
        value={value}
        error={error}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
  }

  if (kind.kind === "time") {
    return wrap(
      <TimeCellEditor
        value={value}
        error={error}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
  }

  // text / set / json fall through to plain text input. SET could be richer
  // later but a comma-separated text field is predictable.
  return wrap(
    <input
      ref={inputRef}
      type="text"
      className={baseCls}
      value={value}
      onChange={handleInputChange}
      onBlur={onCommit}
      onKeyDown={keyHandler}
    />,
  );
}

/* ---------- Boolean / enum dropdown backed by the project Select ---------- */

interface SelectCellEditorProps {
  value: string;
  options: { value: string; label: string }[];
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function SelectCellEditor({
  value,
  options,
  error,
  onChange,
  onCommit,
  onCancel,
}: SelectCellEditorProps) {
  // A self-contained custom dropdown rendered INSIDE the cell editor (no
  // portal). The Base UI <Select> portals its popup to document.body, which
  // lands outside the cell's DOM — so the grid's outside-click / blur commit
  // logic treats picking an option as a click-outside and cancels the edit
  // before the value lands. Keeping the menu in-tree (absolute, inside the
  // editor's relative wrapper) sidesteps that race entirely.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Highlight starts on the current value (or the first option) so keyboard
  // nav and the visual cursor agree from the first keypress.
  const initialIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [highlight, setHighlight] = useState(initialIndex);

  const pick = useCallback(
    (v: string) => {
      onChange(v);
      // Commit on the next tick so the parent's onChange has flushed first and
      // the commit reads the freshly-picked value (matching the prior behavior).
      setTimeout(onCommit, 0);
    },
    [onChange, onCommit],
  );

  const makeHandleOptionMouseDown = useCallback(
    (v: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      pick(v);
    },
    [pick],
  );

  const makeHandleOptionMouseEnter = useCallback(
    (i: number) => () => setHighlight(i),
    [],
  );

  // Close-on-outside-click. Anything outside this editor cancels the edit,
  // mirroring the plain text input's blur/Escape behavior.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      onCancel();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onCancel]);

  // Focus the list on mount so arrow keys / Enter / Escape work immediately
  // without a second click — the cell editor opens "already focused" like a
  // native <select> popup.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(options.length - 1, h + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = options[highlight];
        if (opt) pick(opt.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Tab") {
        // Commit the highlighted option on Tab so editing flows like a form.
        const opt = options[highlight];
        if (opt) pick(opt.value);
      }
    },
    [options, highlight, pick, onCancel],
  );

  const borderCls = error ? "border-destructive" : "border-primary";
  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className="relative w-full h-full">
      {/* Trigger row showing the current value, styled like the other editors. */}
      <div
        className={`w-full h-full flex items-center justify-between px-4 py-1.5 bg-background text-foreground outline-none border-2 ${borderCls}`}
      >
        <span className={current ? "" : "text-muted-foreground"}>
          {current ? current.label : "(unset)"}
        </span>
        <ChevronDown className="size-4 text-muted-foreground shrink-0" />
      </div>
      {/* Inline option list. min-w matches the cell; max-h keeps long enums
          scrollable. Rendered in-tree, no portal. */}
      <div
        ref={listRef}
        role="listbox"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="absolute left-0 top-full z-40 mt-1 min-w-full max-h-60 overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 p-1 outline-none"
      >
        {options.map((o, i) => {
          const selected = o.value === value;
          const active = i === highlight;
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={selected}
              // mousedown (not click) so the pick fires before the window
              // mousedown outside-handler can ever see it as a blur.
              onMouseDown={makeHandleOptionMouseDown(o.value)}
              onMouseEnter={makeHandleOptionMouseEnter(i)}
              className={`relative flex w-full items-center justify-between gap-2 rounded-md py-1.5 pl-2.5 pr-8 text-left text-xs cursor-pointer select-none ${
                active ? "bg-accent text-accent-foreground" : ""
              }`}
            >
              <span className="truncate">{o.label}</span>
              {selected && (
                <Check className="absolute right-2 size-4 shrink-0" />
              )}
            </button>
          );
        })}
        {options.length === 0 && (
          <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
            No options
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Date / datetime editor ---------- */

interface DateTimeCellEditorProps {
  mode: "date" | "datetime";
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function DateTimeCellEditor({
  mode,
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: DateTimeCellEditorProps) {
  const parsed = parseDateTimeString(value);
  const [open, setOpen] = useState(true);

  const triggerCls = `w-full h-full flex items-center gap-2 px-4 py-1.5 bg-background text-foreground outline-none border-2 ${
    error ? "border-destructive" : "border-primary"
  }`;

  const applyDate = useCallback(
    (d: Date | undefined) => {
      if (!d) return;
      if (mode === "date") {
        onChange(formatDate(d));
        setTimeout(() => {
          onCommit();
          setOpen(false);
        }, 0);
      } else {
        onChange(formatDateTime(d, parsed.h, parsed.m, parsed.sec));
      }
    },
    [mode, onChange, onCommit, parsed.h, parsed.m, parsed.sec],
  );

  const applyTimePart = useCallback(
    (h: number, m: number, sec: number) => {
      if (!parsed.date) {
        // No date selected yet — default to today so the time value is usable.
        const now = new Date();
        onChange(formatDateTime(now, h, m, sec));
      } else {
        onChange(formatDateTime(parsed.date, h, m, sec));
      }
    },
    [parsed.date, onChange],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        // Dismissing without picking commits whatever the user typed/chose.
        setTimeout(onCommit, 0);
      }
    },
    [onCommit],
  );

  const handleTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        setOpen(false);
      }
    },
    [onCancel],
  );

  const handleNowClick = useCallback(() => {
    // "Now" fills in the current local clock — commits immediately
    // for date columns, leaves the popover open for datetime so the
    // user can still nudge the time if they want.
    const now = new Date();
    if (mode === "date") {
      onChange(formatDate(now));
      setTimeout(() => {
        onCommit();
        setOpen(false);
      }, 0);
    } else {
      onChange(
        formatDateTime(
          now,
          now.getHours(),
          now.getMinutes(),
          now.getSeconds(),
        ),
      );
    }
  }, [mode, onChange, onCommit]);

  const handleClearClick = useCallback(() => {
    onChange("");
    setTimeout(() => {
      onCommit();
      setOpen(false);
    }, 0);
  }, [onChange, onCommit]);

  const handleDoneClick = useCallback(() => {
    onCommit();
    setOpen(false);
  }, [onCommit]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            className={triggerCls}
            onKeyDown={handleTriggerKeyDown}
          >
            <CalendarIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">
              {value || (
                <span className="text-muted-foreground">
                  (pick a {mode === "date" ? "date" : "date & time"})
                </span>
              )}
            </span>
          </button>
        )}
      />
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={parsed.date}
          onSelect={applyDate}
          defaultMonth={parsed.date}
          autoFocus
        />
        {mode === "datetime" && (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <ClockIcon className="w-3.5 h-3.5 text-muted-foreground" />
            <TimeFields
              h={parsed.h}
              m={parsed.m}
              s={parsed.sec}
              onChange={applyTimePart}
            />
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Button size="xs" variant="ghost" onClick={handleNowClick}>
            Now
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={handleClearClick}
          >
            Clear
          </Button>
          {mode === "datetime" && (
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={handleDoneClick}
            >
              Done
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------- Time editor (standalone TIME column) ---------- */

interface TimeCellEditorProps {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function TimeCellEditor({
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: TimeCellEditorProps) {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(value) ?? [
    "",
    "0",
    "0",
    "0",
  ];
  const [open, setOpen] = useState(true);
  const h = Number(match[1]) || 0;
  const m = Number(match[2]) || 0;
  const s = Number(match[3]) || 0;

  const triggerCls = `w-full h-full flex items-center gap-2 px-4 py-1.5 bg-background text-foreground outline-none border-2 ${
    error ? "border-destructive" : "border-primary"
  }`;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setTimeout(onCommit, 0);
    },
    [onCommit],
  );

  const handleTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        setOpen(false);
      }
    },
    [onCancel],
  );

  const handleTimeFieldsChange = useCallback(
    (nh: number, nm: number, ns: number) =>
      onChange(`${pad(nh)}:${pad(nm)}:${pad(ns)}`),
    [onChange],
  );

  const handleNowClick = useCallback(() => {
    const now = new Date();
    onChange(
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    );
  }, [onChange]);

  const handleClearClick = useCallback(() => {
    onChange("");
    setTimeout(() => {
      onCommit();
      setOpen(false);
    }, 0);
  }, [onChange, onCommit]);

  const handleDoneClick = useCallback(() => {
    onCommit();
    setOpen(false);
  }, [onCommit]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            className={triggerCls}
            onKeyDown={handleTriggerKeyDown}
          >
            <ClockIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">
              {value || (
                <span className="text-muted-foreground">(pick a time)</span>
              )}
            </span>
          </button>
        )}
      />
      <PopoverContent align="start" className="w-auto">
        <div className="flex items-center gap-2">
          <TimeFields h={h} m={m} s={s} onChange={handleTimeFieldsChange} />
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <Button size="xs" variant="ghost" onClick={handleNowClick}>
            Now
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={handleClearClick}
          >
            Clear
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={handleDoneClick}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------- H / M / S spinner row used by both editors ---------- */

function TimeFields({
  h,
  m,
  s,
  onChange,
}: {
  h: number;
  m: number;
  s: number;
  onChange: (h: number, m: number, s: number) => void;
}) {
  const spinnerCls =
    "w-14 h-7 rounded border border-input bg-background px-2 text-sm tabular-nums text-center outline-none focus:border-primary";
  const clamp = useCallback(
    (n: number, max: number) =>
      Math.max(0, Math.min(max, Number.isFinite(n) ? n : 0)),
    [],
  );

  const handleHoursChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(clamp(Number(e.target.value), 23), m, s),
    [onChange, clamp, m, s],
  );

  const handleMinutesChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(h, clamp(Number(e.target.value), 59), s),
    [onChange, clamp, h, s],
  );

  const handleSecondsChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(h, m, clamp(Number(e.target.value), 59)),
    [onChange, clamp, h, m],
  );

  return (
    <div className="flex items-center gap-1 font-mono">
      <input
        type="number"
        min={0}
        max={23}
        className={spinnerCls}
        value={h}
        onChange={handleHoursChange}
      />
      <span className="text-muted-foreground">:</span>
      <input
        type="number"
        min={0}
        max={59}
        className={spinnerCls}
        value={m}
        onChange={handleMinutesChange}
      />
      <span className="text-muted-foreground">:</span>
      <input
        type="number"
        min={0}
        max={59}
        className={spinnerCls}
        value={s}
        onChange={handleSecondsChange}
      />
    </div>
  );
}
