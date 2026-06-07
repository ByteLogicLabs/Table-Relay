import { useEffect, useMemo, useState } from 'react';
import { Loader2, FileDown, FileUp, AlertTriangle, ShieldAlert, Search, ChevronRight, ChevronLeft, Lock } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Checkbox } from '../../components/ui/checkbox';
import { cn } from '../../lib/utils';
import { toast } from 'sonner';
import { connectionsStore, type ConnectionProfileRecord } from '../../lib/connections-store';
import { connectionInputFromUnknown } from '../settings/settings-utils';
import { IMPORT_SOURCES, type ImportSource, type ImportSourceId, type ParsedConnection } from './import-sources';
import { tableplusImport } from '../../lib/tableplus-import';
import PasswordPromptDialog from '../settings/password-prompt-dialog';

type Mode = 'export' | 'import';

/** A connection candidate shown in the checklist (export: existing record;
 *  import: parsed-from-file input). Kept minimal for the row UI. */
interface Candidate {
  name: string;
  driver: string;
  host: string;
  port: number;
  database?: string | null;
  sshEnabled?: boolean;
  color?: string | null;
}

/**
 * Unified import/export of saved connections with a per-connection picker.
 * Replaces the old all-or-nothing flow buried in Settings: the user opens this
 * from the connection picker / rail, ticks exactly which connections to move,
 * and exports to (or imports from) a plain JSON file.
 */
export default function ConnectionTransferDialog({
  open,
  mode,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  mode: Mode;
  onOpenChange: (v: boolean) => void;
  /** Fired after a successful import so the caller can refresh its list. */
  onImported?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Export: the user's saved records. Import: records parsed from a picked file.
  const [records, setRecords] = useState<ConnectionProfileRecord[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Import-only: the file the user picked (so the title can show it).
  const [importPath, setImportPath] = useState<string | null>(null);
  // Import-only: which other client's export format we're reading.
  // null = no source picked yet (the source list is shown).
  const [sourceId, setSourceId] = useState<ImportSourceId | null>(null);
  // Import-only: password for encrypted sources (TablePlus).
  const [password, setPassword] = useState('');
  const [filter, setFilter] = useState('');

  // Password prompt for encrypted native export / import (see settings-dialog
  // for the same pattern).
  const [pwPrompt, setPwPrompt] = useState<{ mode: 'set' | 'enter'; title: string; description?: string } | null>(null);
  const [pwResolver, setPwResolver] = useState<((pw: string | null) => void) | null>(null);
  const askPassword = (opts: { mode: 'set' | 'enter'; title: string; description?: string }) =>
    new Promise<string | null>((resolve) => {
      setPwResolver(() => resolve);
      setPwPrompt(opts);
    });
  const resolvePassword = (pw: string | null) => {
    pwResolver?.(pw);
    setPwResolver(null);
    setPwPrompt(null);
  };

  const reset = () => {
    setLoading(false);
    setBusy(false);
    setError(null);
    setRecords([]);
    setSelected(new Set());
    setImportPath(null);
    setSourceId(null);
    setPassword('');
    setFilter('');
  };

  // Clear everything tied to a specific source — used when going back to the
  // source list or switching source.
  const clearSourceState = () => {
    setRecords([]);
    setSelected(new Set());
    setImportPath(null);
    setPassword('');
    setError(null);
    setFilter('');
  };

  // On open in export mode, load the saved connections to choose from. Import
  // mode waits for the user to pick a file first.
  useEffect(() => {
    if (!open) return;
    reset();
    if (mode !== 'export') return;
    setLoading(true);
    connectionsStore
      .list()
      .then((list) => {
        setRecords(list);
        // Default: everything selected (the common "export all" case).
        setSelected(new Set(list.map((_, i) => i)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, mode]);

  const candidates: Candidate[] = useMemo(
    () =>
      records.map((r) => ({
        name: r.name,
        driver: r.driver,
        host: r.host,
        port: r.port,
        database: r.database,
        sshEnabled: r.sshEnabled,
        color: r.color,
      })),
    [records],
  );

  // Search-filtered view. We carry each item's ORIGINAL index so selection
  // (a Set of record indices) stays correct regardless of the active filter.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = candidates.map((c, i) => ({ c, i }));
    if (!q) return rows;
    return rows.filter(({ c }) =>
      c.name.toLowerCase().includes(q) ||
      c.host.toLowerCase().includes(q) ||
      c.driver.toLowerCase().includes(q) ||
      (c.database ?? '').toLowerCase().includes(q),
    );
  }, [candidates, filter]);

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  // Select-all acts on the currently-VISIBLE (filtered) rows: if all visible are
  // already selected, deselect them; otherwise select them all. With no filter
  // this is the usual "select everything" toggle.
  const visibleAllSelected =
    visible.length > 0 && visible.every(({ i }) => selected.has(i));
  const allSelected = visibleAllSelected;
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (visibleAllSelected) {
        for (const { i } of visible) next.delete(i);
      } else {
        for (const { i } of visible) next.add(i);
      }
      return next;
    });

  const source = sourceId ? IMPORT_SOURCES.find((s) => s.id === sourceId)! : null;

  // Import: pick a file. Plain-text sources parse immediately; encrypted ones
  // (TablePlus) just remember the path and wait for the password step.
  // `src` can be passed explicitly so the source-list click can open the picker
  // in the same tick (before `source` derived state has updated).
  const handlePickImportFile = async (src: ImportSource | null = source) => {
    if (!src) return;
    const source = src;
    setError(null);
    try {
      const exts = Array.from(new Set([...source.extensions]));
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: source.label, extensions: exts },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (!picked || Array.isArray(picked)) return;
      setImportPath(picked);

      if (source.encrypted) return; // password step handles the rest

      // Native Table Relay exports may be encrypted (.dtab). Detect and decrypt
      // before parsing; other sources are always plain files.
      let text: string;
      if (source.id === 'tablerelay' && (await invoke<boolean>('secure_is_encrypted', { path: picked }))) {
        let decrypted: string | null = null;
        for (;;) {
          const pw = await askPassword({
            mode: 'enter',
            title: 'Import encrypted connections',
            description: 'Enter the password used when this file was exported.',
          });
          if (!pw) return; // cancelled
          try {
            decrypted = await invoke<string>('secure_import', { path: picked, password: pw });
            break;
          } catch (err) {
            if ((err as { kind?: string })?.kind === 'BadPassword') {
              toast.error('Wrong password — try again.');
              continue;
            }
            throw err;
          }
        }
        text = decrypted;
      } else {
        text = await readTextFile(picked);
      }

      let parsed: ParsedConnection[];
      try {
        parsed = source.parse!(text);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRecords([]);
        return;
      }

      // Optional second pass: decrypt secrets via the backend (Navicat) or pull
      // them from a companion credentials file (DBeaver).
      if (source.enrich) {
        setBusy(true);
        try {
          parsed = await source.enrich(parsed);
        } catch {
          // Non-fatal — fall back to geometry-only records.
        } finally {
          setBusy(false);
        }
      }

      // Normalize each entry through the shared validator; drop incomplete ones.
      const valid: ConnectionProfileRecord[] = [];
      for (const item of parsed) {
        const input = connectionInputFromUnknown(item);
        if (input) valid.push(input as unknown as ConnectionProfileRecord);
      }
      if (valid.length === 0) {
        setError('No valid connections found in this file.');
        setRecords([]);
        return;
      }
      setRecords(valid);
      setSelected(new Set(valid.map((_, i) => i)));
    } catch (e) {
      setError(`Couldn't read file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // TablePlus: decrypt the picked .tableplusconnection with the export password
  // (done in the Rust backend) and turn the candidates into records.
  const handleDecryptTablePlus = async () => {
    if (!importPath) return;
    setBusy(true);
    setError(null);
    try {
      const res = await tableplusImport(importPath, password);
      const recs = res.candidates.map(
        (c) =>
          ({
            name: c.name,
            driver: c.driver,
            host: c.host,
            port: c.port,
            user: c.user ?? undefined,
            password: c.password ?? undefined,
            database: c.database ?? undefined,
            sslMode: c.sslMode ?? undefined,
            sshEnabled: c.sshEnabled,
            sshHost: c.sshHost ?? undefined,
            sshPort: c.sshPort ?? undefined,
            sshUser: c.sshUser ?? undefined,
            sshAuthKind: c.sshAuthKind ?? undefined,
            sshKeyPath: c.sshKeyPath ?? undefined,
            sshPassword: c.sshPassword ?? undefined,
            color: c.color ?? undefined,
          }) as ConnectionProfileRecord,
      );
      if (recs.length === 0) {
        setError('No supported connections found in this TablePlus export.');
        return;
      }
      setRecords(recs);
      setSelected(new Set(recs.map((_, i) => i)));
    } catch (err) {
      const kind = (err as { kind?: string })?.kind;
      setError(
        kind === 'BadPassword'
          ? 'Wrong password — could not decrypt the file.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    const chosen = records.filter((_, i) => selected.has(i));
    if (chosen.length === 0) {
      toast.error('Select at least one connection to export');
      return;
    }
    try {
      const path = await saveDialog({
        defaultPath: 'table-relay-connections.dtab',
        filters: [{ name: 'Table Relay export', extensions: ['dtab'] }],
      });
      if (!path) return; // cancelled
      // Connection exports carry DB + SSH passwords, so they're always
      // encrypted with a user-chosen password.
      const pw = await askPassword({
        mode: 'set',
        title: 'Encrypt connections export',
        description: 'Set a password to protect this file. It contains database and SSH credentials.',
      });
      if (!pw) return; // cancelled
      setBusy(true);
      await invoke('secure_export', {
        path,
        json: JSON.stringify({ version: 1, connections: chosen }, null, 2),
        password: pw,
      });
      toast.success(`Exported ${chosen.length} connection${chosen.length === 1 ? '' : 's'} (encrypted)`);
      onOpenChange(false);
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    const chosen = records.filter((_, i) => selected.has(i));
    if (chosen.length === 0) {
      toast.error('Select at least one connection to import');
      return;
    }
    setBusy(true);
    let imported = 0;
    try {
      for (const rec of chosen) {
        const input = connectionInputFromUnknown(rec);
        if (!input) continue;
        await connectionsStore.save(input);
        imported++;
      }
      window.dispatchEvent(new CustomEvent('tablerelay:connections-changed'));
      toast.success(`Imported ${imported} connection${imported === 1 ? '' : 's'}`);
      onImported?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const isExport = mode === 'export';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl w-[92vw] flex flex-col max-h-[70vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {isExport ? <FileDown className="w-4 h-4" /> : <FileUp className="w-4 h-4" />}
            {isExport ? 'Export connections' : 'Import connections'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col min-h-0 flex-1 gap-3">
          {/* Import, step 1: choose where to import from (Settings-style list). */}
          {!isExport && !source && (
            <div className="flex flex-col min-h-0 flex-1 gap-1.5 overflow-y-auto">
              {IMPORT_SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    clearSourceState();
                    setSourceId(s.id);
                    // Jump straight to the OS file picker — one click instead of
                    // two. (TablePlus still shows its password step afterwards.)
                    void handlePickImportFile(s);
                  }}
                  className="w-full flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{s.label}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{s.hint}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          )}

          {/* Import, step 2: a source is chosen. */}
          {!isExport && source && (
            <>
              <button
                type="button"
                onClick={() => {
                  clearSourceState();
                  setSourceId(null);
                }}
                className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground self-start"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Choose a different source
              </button>

              {/* Before any connections are loaded, an empty-state card matching
                  the app's pattern (cf. Settings → AI credentials). */}
              {records.length === 0 && (
                <div className="rounded-lg border border-dashed border-border py-10 flex flex-col items-center gap-3 text-center">
                  <FileUp className="w-8 h-8 text-muted-foreground/40" />
                  <div>
                    <p className="text-sm text-muted-foreground">
                      {importPath ? importPath.split('/').pop() : `No ${source.label} file selected`}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5 max-w-xs">{source.hint}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => void handlePickImportFile()}
                    disabled={busy}
                  >
                    <FileUp className="w-3.5 h-3.5" />
                    {importPath ? 'Choose a different file' : 'Choose file'}
                  </Button>

                  {/* Encrypted (TablePlus): password + decrypt before the checklist. */}
                  {source.encrypted && importPath && (
                    <div className="w-full max-w-xs flex flex-col gap-2 pt-1">
                      <div className="relative">
                        <Lock className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        <Input
                          type="password"
                          autoFocus
                          className="pl-8 h-8 text-sm"
                          placeholder="Export password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void handleDecryptTablePlus(); }}
                        />
                      </div>
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => void handleDecryptTablePlus()}
                        disabled={busy}
                      >
                        {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                        Decrypt &amp; preview
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Secrets note for export — the file is encrypted with the password
              you set next, and can only be opened in Table Relay. */}
          {isExport && records.length > 0 && (
            <div className="shrink-0 flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2.5 py-1.5">
              <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>This file includes database &amp; SSH credentials. It’s encrypted with a password you set next — keep that password safe.</span>
            </div>
          )}

          {error && (
            <div className="shrink-0 flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading…
            </div>
          ) : records.length > 0 ? (
            <div className="flex flex-col min-h-0 flex-1 gap-2">
              {/* Search — filters by name, host, driver, or database. */}
              <div className="shrink-0 relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter connections…"
                  className="pl-8 h-8 text-sm"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <div className="shrink-0 flex items-center justify-between text-xs text-muted-foreground px-1">
                <span>
                  {selected.size} of {records.length} selected
                  {filter && ` · ${visible.length} shown`}
                </span>
                <button
                  type="button"
                  className="hover:text-foreground underline-offset-2 hover:underline"
                  onClick={toggleAll}
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto rounded border border-border divide-y divide-border">
                {visible.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">No matches.</div>
                ) : visible.map(({ c, i }) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggle(i)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors',
                      selected.has(i) ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/50',
                    )}
                  >
                    <Checkbox checked={selected.has(i)} className="pointer-events-none" />
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
                  </button>
                ))}
              </div>
            </div>
          ) : isExport ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No saved connections to export.
            </div>
          ) : null}

          {/* Footer appears once there's something to confirm: an export with
              connections, or an import with connections loaded from a file.
              Always shown so the dialog keeps a consistent footer. */}
          <div className="shrink-0 flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || selected.size === 0}
              onClick={() => void (isExport ? handleExport() : handleImport())}
            >
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {isExport ? `Export ${selected.size || ''}`.trim() : `Import ${selected.size || ''}`.trim()}
            </Button>
          </div>
        </div>
      </DialogContent>

      {pwPrompt && (
        <PasswordPromptDialog
          open={pwPrompt !== null}
          mode={pwPrompt.mode}
          title={pwPrompt.title}
          description={pwPrompt.description}
          onSubmit={(pw) => resolvePassword(pw)}
          onOpenChange={(v) => { if (!v) resolvePassword(null); }}
        />
      )}
    </Dialog>
  );
}
