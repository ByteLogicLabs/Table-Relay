import { useCallback } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button } from '../../components/ui/button';

// ── Small reusable controls ─────────────────────────────────────────────────────

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const handleClick = useCallback(() => onChange(!checked), [onChange, checked]);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={handleClick}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        {desc && <div className="text-[11px] text-muted-foreground mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A backup/transfer list row: label + description on the left, Export / Import on the right. */
export function DataRow({ label, desc, onExport, onImport }: {
  label: string;
  desc: string;
  onExport: () => void;
  onImport: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{desc}</div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={onExport}>
          <Download className="w-3.5 h-3.5" /> Export
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={onImport}>
          <Upload className="w-3.5 h-3.5" /> Import
        </Button>
      </div>
    </div>
  );
}
