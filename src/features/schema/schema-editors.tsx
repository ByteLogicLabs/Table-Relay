import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Trash2, Link2, Link2Off } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { ensureTableStructure } from '../../state/connections';
import { type DraftColumn, type DraftForeignKey, type FkAction, FK_ACTIONS } from './schema-types';

// -------- editable cell primitives --------

export function CellInput({
  value, onCommit, disabled, placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <input
      ref={ref}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setLocal(value); (e.target as HTMLInputElement).blur(); }
      }}
      className="w-full px-2.5 py-1.5 bg-transparent text-sm font-[inherit] outline-none focus:bg-muted/40 disabled:opacity-50"
    />
  );
}

export function CellSelect({
  value, onChange, options, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      {/* Flat cell trigger: matches the borderless `CellInput` cells around
          it. We explicitly clear the base trigger's dark fill + rounding —
          tailwind-merge keeps `dark:bg-input/30` next to a base
          `bg-transparent` (different variants), which is what made the
          control look like an oversized pill inside the dense grid. */}
      <SelectTrigger
        size="sm"
        className="h-7 w-full border-0 rounded-none shadow-none bg-transparent hover:bg-muted/40 dark:bg-transparent dark:hover:bg-muted/40 px-2.5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/**
 * Typeahead input with a preset dropdown + "Manual input..." escape.
 * Shown as an input cell; clicking the caret opens the preset list, typing
 * filters it, and picking "Manual input..." just keeps the typed text.
 */
export function CellCombobox({
  value, onCommit, options, disabled, placeholder, className,
}: {
  value: string;
  onCommit: (v: string) => void;
  options: string[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [local, setLocal] = useState(value);
  const [open, setOpen] = useState(false);
  // Whether the user has typed since the list opened. While false, the
  // dropdown shows the FULL option list (not just the row matching the
  // current value) so opening a populated cell doesn't collapse the list
  // down to one item — the user can scan every type before deciding.
  const [typing, setTyping] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setLocal(value); }, [value]);

  // Measure + track the input's viewport rect whenever the popover is
  // open so the fixed-position list stays attached through table scroll
  // and window resize. Recalculated on scroll of any ancestor, not just
  // window — the schema table lives inside its own scroll container.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      if (ref.current) setAnchorRect(ref.current.getBoundingClientRect());
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  // Close when clicking outside either the input wrapper or the portal'd
  // popover itself. Without the popover check the first click on a list
  // item would race the close handler.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useMemo(() => {
    // Only filter once the user starts typing. On open we show everything
    // so the current value never hides the rest of the catalogue.
    if (!typing) return options;
    const q = local.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, local, typing]);

  const commit = (v: string) => {
    setLocal(v);
    setTyping(false);
    if (v !== value) onCommit(v);
    setOpen(false);
  };

  // Choose above vs. below based on which side has more room, so the
  // dropdown doesn't get clipped by the grid's overflow container.
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const spaceBelow = anchorRect ? viewportH - anchorRect.bottom : 0;
  const spaceAbove = anchorRect ? anchorRect.top : 0;
  const openUp = anchorRect != null && spaceBelow < 180 && spaceAbove > spaceBelow;
  const maxH = Math.max(120, Math.min(288, openUp ? spaceAbove - 8 : spaceBelow - 8));

  return (
    <div ref={wrapRef} className={`relative w-full ${className ?? ''}`}>
      <input
        ref={ref}
        value={local}
        disabled={disabled}
        placeholder={placeholder}
        onChange={e => { setLocal(e.target.value); setTyping(true); if (!open) setOpen(true); }}
        onFocus={() => { setOpen(true); setTyping(false); }}
        onBlur={() => { if (local !== value && !open) onCommit(local); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit(local); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setLocal(value); setOpen(false); setTyping(false); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'ArrowDown' && !open) { setOpen(true); }
        }}
        className="w-full px-2.5 py-1.5 pr-5 bg-transparent text-sm font-[inherit] outline-none focus:bg-muted/40 disabled:opacity-50"
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(e) => { e.preventDefault(); setTyping(false); setOpen(o => !o); ref.current?.focus(); }}
        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 4l3 3 3-3z" /></svg>
      </button>
      {open && filtered.length > 0 && anchorRect && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            left: anchorRect.left,
            top: openUp ? undefined : anchorRect.bottom + 2,
            bottom: openUp ? viewportH - anchorRect.top + 2 : undefined,
            width: anchorRect.width,
            maxHeight: maxH,
          }}
          className="z-50 min-w-36 overflow-auto rounded-lg bg-popover shadow-md ring-1 ring-foreground/10 py-1"
        >
          {filtered.map(o => (
            <button
              key={o}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(o); }}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground ${
                o === value ? 'bg-accent/50' : ''
              }`}
            >
              {o}
            </button>
          ))}
          <div className="border-t border-border/60 mt-1 pt-1">
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); ref.current?.focus(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground italic hover:bg-accent hover:text-accent-foreground"
            >
              Manual input…
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// -------- FK cell + popover --------

export function FkCell({
  tableName, column, fk, allColumns, siblingTables, connectionId, schema, disabled, onApply, onRemove,
}: {
  tableName: string;
  column: DraftColumn;
  fk: DraftForeignKey | undefined;
  allColumns: string[];
  siblingTables: string[];
  connectionId: string;
  schema: string;
  disabled?: boolean;
  onApply: (patch: {
    columns: string[];
    refTable: string;
    refColumns: string;
    onUpdate: FkAction;
    onDelete: FkAction;
    name?: string;
  }) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Draft state for the popover (only committed on OK). This UI only supports
  // single-column FKs — the most common case, matching TablePlus. Composite
  // keys are rare and the existing multi-column storage stays underneath.
  const seedCol = column.originalName ?? column.name;
  const [col, setCol] = useState<string>(fk?.columns[0] ?? seedCol ?? '');
  const [refTable, setRefTable] = useState(fk?.refTable ?? '');
  const [refColumn, setRefColumn] = useState<string>(
    fk?.refColumns ? fk.refColumns.split(',').map(s => s.trim()).filter(Boolean)[0] ?? '' : '',
  );
  const [targetCols, setTargetCols] = useState<string[]>([]);
  const [targetLoading, setTargetLoading] = useState(false);
  const [onUpdate, setOnUpdate] = useState<FkAction>(fk?.onUpdate ?? 'NO ACTION');
  const [onDelete, setOnDelete] = useState<FkAction>(fk?.onDelete ?? 'NO ACTION');
  const [name, setName] = useState(fk?.name ?? '');

  useEffect(() => {
    if (!open) return;
    // reseed when opening
    setCol(fk?.columns[0] ?? seedCol ?? '');
    setRefTable(fk?.refTable ?? '');
    setRefColumn(fk?.refColumns ? fk.refColumns.split(',').map(s => s.trim()).filter(Boolean)[0] ?? '' : '');
    setOnUpdate(fk?.onUpdate ?? 'NO ACTION');
    setOnDelete(fk?.onDelete ?? 'NO ACTION');
    setName(fk?.name ?? '');
  }, [open, fk, seedCol]);

  // Load the target table's columns once a Referenced Table is picked so the
  // Referenced Columns field can autocomplete against real column names.
  useEffect(() => {
    if (!open || !refTable || !schema) {
      setTargetCols([]);
      return;
    }
    let cancelled = false;
    setTargetLoading(true);
    ensureTableStructure(connectionId, schema, refTable)
      .then(s => { if (!cancelled) setTargetCols(s.columns.map(c => c.name)); })
      .catch(() => { if (!cancelled) setTargetCols([]); })
      .finally(() => { if (!cancelled) setTargetLoading(false); });
    return () => { cancelled = true; };
  }, [open, refTable, schema, connectionId]);

  const hasFk = !!fk;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled && next) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            disabled={disabled}
            className="w-full h-full px-2.5 py-1.5 text-left text-xs font-mono hover:bg-muted/40 flex items-center gap-1"
            title={hasFk ? 'Edit foreign key' : 'Add foreign key'}
          >
            {hasFk ? (
              <>
                <Link2 className="w-3 h-3 text-primary" />
                <span className="text-primary truncate">{fk!.refTable}({fk!.refColumns})</span>
              </>
            ) : (
              <>
                <Link2Off className="w-3 h-3 text-muted-foreground/50" />
                <span className="opacity-50">—</span>
              </>
            )}
          </button>
        )}
      />
      <PopoverContent className="w-80 gap-3">
        <div className="text-sm font-medium border-b border-border/60 pb-2">
          {hasFk ? 'Edit foreign key' : 'Add foreign key'}
        </div>

        <FkField label="Constraint name">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={`fk_${tableName}_${col || 'col'}`}
            disabled={disabled}
          />
        </FkField>

        <FkField label="Table">
          <Input value={tableName} disabled />
        </FkField>

        <FkField label="Column">
          <Select value={col} onValueChange={setCol} disabled={disabled}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue placeholder="Select column" />
            </SelectTrigger>
            <SelectContent>
              {allColumns.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </FkField>

        <FkField label="Referenced Table">
          {siblingTables.length > 0 ? (
            <Select value={refTable} onValueChange={setRefTable} disabled={disabled}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="Select table" />
              </SelectTrigger>
              <SelectContent>
                {siblingTables.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <Input value={refTable} onChange={e => setRefTable(e.target.value)} placeholder="referenced_table" disabled={disabled} />
          )}
        </FkField>

        <FkField label="Referenced Column">
          {refTable ? (
            targetLoading ? (
              <div className="text-xs text-muted-foreground px-1 py-1.5 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading columns…
              </div>
            ) : targetCols.length > 0 ? (
              <Select value={refColumn} onValueChange={setRefColumn} disabled={disabled}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue placeholder="Select column" />
                </SelectTrigger>
                <SelectContent>
                  {targetCols.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={refColumn}
                onChange={e => setRefColumn(e.target.value)}
                placeholder="id"
                disabled={disabled}
              />
            )
          ) : (
            <div className="text-xs text-muted-foreground px-1 py-1.5">Pick a referenced table first.</div>
          )}
        </FkField>

        <div className="grid grid-cols-2 gap-2">
          <FkField label="On Update">
            <Select value={onUpdate} onValueChange={v => setOnUpdate(v as FkAction)} disabled={disabled}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FK_ACTIONS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
          </FkField>
          <FkField label="On Delete">
            <Select value={onDelete} onValueChange={v => setOnDelete(v as FkAction)} disabled={disabled}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FK_ACTIONS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
          </FkField>
        </div>

        <div className="flex items-center justify-between border-t border-border/60 pt-2 gap-2">
          {hasFk ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() => { onRemove(); setOpen(false); }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Delete
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={disabled}>Cancel</Button>
            <Button
              variant="default"
              size="sm"
              disabled={disabled || !col || !refTable.trim() || !refColumn.trim()}
              onClick={() => {
                onApply({
                  columns: [col],
                  refTable: refTable.trim(),
                  refColumns: refColumn.trim(),
                  onUpdate,
                  onDelete,
                  name: name.trim() || undefined,
                });
                setOpen(false);
              }}
            >
              OK
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FkField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

// -------- table shell --------

export function Th({ children, last }: { children?: React.ReactNode; last?: boolean }) {
  return (
    <th className={`px-4 py-2 border-b ${last ? '' : 'border-r'} border-border font-medium whitespace-nowrap`}>
      {children}
    </th>
  );
}

export function Td({ children, last, className }: { children: React.ReactNode; last?: boolean; className?: string }) {
  return (
    <td className={`${last ? '' : 'border-r'} border-border whitespace-nowrap ${className ?? ''}`}>
      {children}
    </td>
  );
}

// Mongo-flavoured fields table. Mongo has no enforced schema — what
// `describe_table` returns is a 200-doc sample summary: which fields
// exist, what BSON types they hold (multiple if heterogeneous), and
// whether they're missing in some sampled docs. We render that shape
// directly instead of pretending it's an SQL column definition.
export function MongoFieldsTable({ columns }: { columns: DraftColumn[] }) {
  const visible = columns.filter(c => !c.pendingDelete);
  return (
    <table className="w-full text-sm text-left border-collapse">
      <thead className="text-[11px] text-muted-foreground uppercase bg-muted sticky top-0 z-10">
        <tr>
          <Th>field</Th>
          <Th>bson_types</Th>
          <Th>presence</Th>
          <Th>indexed</Th>
          <Th last></Th>
        </tr>
      </thead>
      <tbody>
        {visible.length === 0 && (
          <tr>
            <td className="px-4 py-3 text-xs text-muted-foreground" colSpan={5}>
              No fields seen in the sampled documents.
            </td>
          </tr>
        )}
        {visible.map(c => {
          // `dataType` arrives pipe-joined from the adapter ("string|null",
          // "objectId", "int|long", …). Splitting + rendering as chips
          // matches Compass's "Multiple types" badge while staying compact
          // when it's just one.
          const types = c.dataType
            .split('|')
            .map(t => t.trim())
            .filter(Boolean);
          const presenceLabel = c.nullable ? 'sometimes' : 'always';
          const presenceClass = c.nullable
            ? 'text-yellow-700 dark:text-yellow-400'
            : 'text-emerald-700 dark:text-emerald-400';
          const isPk = c.key === 'PRIMARY';
          return (
            <tr key={c.id} className="border-b border-border/60 hover:bg-muted/20">
              <Td className="font-mono text-foreground px-4 py-2">
                <span className="inline-flex items-center gap-1.5">
                  {c.name}
                  {isPk && <span className="text-[10px] uppercase text-muted-foreground tracking-wide">primary</span>}
                </span>
              </Td>
              <Td className="font-mono text-muted-foreground px-4 py-2">
                {types.length === 0 ? (
                  <span className="text-muted-foreground/60">—</span>
                ) : (
                  <span className="inline-flex flex-wrap gap-1">
                    {types.map(t => (
                      <span
                        key={t}
                        className="px-1.5 py-0.5 rounded bg-muted text-[11px] font-mono"
                        title={types.length > 1 ? 'Field has multiple BSON types across sampled docs' : undefined}
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </Td>
              <Td className={`px-4 py-2 text-[11px] uppercase tracking-wide ${presenceClass}`}>
                {presenceLabel}
              </Td>
              <Td className="px-4 py-2 text-[11px] text-muted-foreground">
                {/* `is_unique` covers both PK + secondary unique indexes;
                    we surface it alongside indexed for at-a-glance reading. */}
                {isPk
                  ? 'unique (_id)'
                  : c.key === 'UNIQUE'
                    ? 'unique'
                    : '—'}
              </Td>
              <Td last className="px-4 py-2"> </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
