import { useState } from 'react';
import { Loader2, Database, Lock, FileUp, AlertTriangle } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from 'sonner';
import {
  tableplusImport,
  type TablePlusCandidate,
  type TablePlusImportResult,
} from '../../lib/tableplus-import';
import { connectionsStore } from '../../lib/connections-store';

type Step = 'pick' | 'preview';

function errMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return String(err);
}

export default function TablePlusImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [step, setStep] = useState<Step>('pick');
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TablePlusImportResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const reset = () => {
    setStep('pick');
    setPath(null);
    setPassword('');
    setBusy(false);
    setError(null);
    setResult(null);
    setSelected(new Set());
  };

  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const pickFile = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: 'TablePlus export', extensions: ['tableplusconnection'] }],
    });
    if (picked && !Array.isArray(picked)) setPath(picked);
  };

  const decrypt = async () => {
    if (!path) {
      setError('Choose a .tableplusconnection file first');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await tableplusImport(path, password);
      setResult(res);
      setSelected(new Set(res.candidates.map((_, i) => i))); // select all by default
      setStep('preview');
    } catch (err) {
      // The backend returns kind:"BadPassword" for the common case.
      const kind = (err as { kind?: string })?.kind;
      setError(kind === 'BadPassword' ? 'Wrong password — could not decrypt the file.' : errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const toggleAll = () => {
    if (!result) return;
    setSelected(prev =>
      prev.size === result.candidates.length ? new Set() : new Set(result.candidates.map((_, i) => i)),
    );
  };

  const doImport = async () => {
    if (!result) return;
    const picks = result.candidates.filter((_, i) => selected.has(i));
    if (picks.length === 0) {
      setError('Select at least one connection to import');
      return;
    }
    setBusy(true);
    setError(null);
    let imported = 0;
    try {
      for (const c of picks) {
        await connectionsStore.save({
          name: c.name,
          driver: c.driver,
          host: c.host,
          port: c.port,
          user: c.user ?? undefined,
          password: c.password ?? undefined,
          database: c.database ?? undefined,
          sshEnabled: c.sshEnabled,
          sshHost: c.sshHost ?? undefined,
          sshPort: c.sshPort ?? undefined,
          sshUser: c.sshUser ?? undefined,
          sshAuthKind: c.sshAuthKind ?? undefined,
          sshKeyPath: c.sshKeyPath ?? undefined,
          sshPassword: c.sshPassword ?? undefined,
          color: c.color ?? undefined,
        });
        imported += 1;
      }
      window.dispatchEvent(new CustomEvent('tablerelay:connections-changed'));
      toast.success(`Imported ${imported} connection${imported === 1 ? '' : 's'} from TablePlus`);
      close(false);
    } catch (err) {
      setError(`Import stopped after ${imported}: ${errMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const fileName = path?.split('/').pop() ?? null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton className="sm:max-w-150 max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Database className="w-4 h-4" /> Import from TablePlus
          </DialogTitle>
        </DialogHeader>

        {step === 'pick' && (
          <div className="space-y-4 py-1">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Choose a password-protected <code>.tableplusconnection</code> export and enter the
              password you set when exporting. Connections are decrypted locally on your machine.
            </p>

            <div className="space-y-1.5">
              <Label>Export file</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={pickFile}>
                  <FileUp className="w-3.5 h-3.5" /> Choose file…
                </Button>
                <span className="text-xs text-muted-foreground truncate min-w-0">
                  {fileName ?? 'No file selected'}
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tp-password">Export password</Label>
              <div className="relative">
                <Lock className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  id="tp-password"
                  type="password"
                  className="pl-8"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void decrypt(); }}
                  placeholder="Password used at export time"
                />
              </div>
            </div>

            {error && <p className="text-xs text-destructive break-words">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => close(false)}>Cancel</Button>
              <Button size="sm" onClick={() => void decrypt()} disabled={busy || !path}>
                {busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                Decrypt &amp; preview
              </Button>
            </div>
          </div>
        )}

        {step === 'preview' && result && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="text-xs text-muted-foreground">
                {result.candidates.length} connection{result.candidates.length === 1 ? '' : 's'} found
                {result.skipped.length > 0 && `, ${result.skipped.length} skipped`}
              </div>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={toggleAll}>
                {selected.size === result.candidates.length ? 'Deselect all' : 'Select all'}
              </Button>
            </div>

            {result.skipped.length > 0 && (
              <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-500 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                <span>
                  Skipped (unsupported): {result.skipped.map(s => `${s.name} (${s.driver})`).join(', ')}
                </span>
              </div>
            )}

            <div className="overflow-y-auto min-h-0 flex-1 rounded-md border border-border divide-y divide-border">
              {result.candidates.map((c, i) => (
                <CandidateRow key={i} c={c} checked={selected.has(i)} onToggle={() => toggle(i)} />
              ))}
            </div>

            {error && <p className="text-xs text-destructive break-words mt-2">{error}</p>}

            <div className="flex justify-between items-center gap-2 pt-3">
              <Button variant="ghost" size="sm" onClick={() => setStep('pick')} disabled={busy}>
                Back
              </Button>
              <Button size="sm" onClick={() => void doImport()} disabled={busy || selected.size === 0}>
                {busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                Import {selected.size} connection{selected.size === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({ c, checked, onToggle }: { c: TablePlusCandidate; checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
    >
      <input type="checkbox" checked={checked} readOnly className="shrink-0 accent-primary" />
      {c.color && (
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">{c.name}</div>
        <div className="text-[11px] text-muted-foreground truncate">
          {c.driver} · {c.host}:{c.port}
          {c.database ? ` / ${c.database}` : ''}
          {c.sshEnabled ? ' · SSH' : ''}
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">{c.driver}</span>
    </button>
  );
}
