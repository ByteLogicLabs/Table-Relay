import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, Search, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { ConnectionProfile } from '../../types';
import { useConnections, refreshSchemas } from '../../state/connections';
import { db, isDbError } from '../../lib/db';
import { useAdapterManifests, resolveManifest } from '../../state/adapter-manifests';

// Sentinel for the "let the server pick" option in the encoding /
// collation pickers. Anything else is sent verbatim to the backend.
const DEFAULT_OPT = '__default__';
const DEFAULT_LABEL = 'Default (Server Pick)';

// MySQL identifier rules are loose, but for the dialog we enforce the
// portable subset: letters, digits, underscore, hyphen. Same set the
// CLI tools accept without quoting.
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface DatabasePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ConnectionProfile | null;
  /** Called with the chosen database name. Caller handles pinning + focus. */
  onPick: (databaseName: string) => void;
}

export default function DatabasePickerDialog({
  open,
  onOpenChange,
  connection,
  onPick,
}: DatabasePickerDialogProps) {
  const connState = useConnections();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [newMode, setNewMode] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCharset, setNewCharset] = useState<string>(DEFAULT_OPT);
  const [newCollation, setNewCollation] = useState<string>(DEFAULT_OPT);
  const [creating, setCreating] = useState(false);
  const [pgDatabases, setPgDatabases] = useState<string[] | null>(null);
  const [pgLoading, setPgLoading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Adapters that expose a discoverable database catalog (Postgres'
  // `pg_database`, Mongo's `listDatabases`) declare `database_picker = true`.
  // For those, we fetch the catalog directly so the picker shows true
  // databases even when the schema list (which may also be present)
  // refers to something else (PG's `public`/user schemas inside a db).
  // Adapters where schema == database (MySQL/SQLite) use the schema list
  // as the database list — those usually have `database_picker = false`
  // or simply don't need this dialog.
  const manifests = useAdapterManifests();
  const activeManifest = connection
    ? resolveManifest(manifests, connection.driver)
    : undefined;
  const usesDatabaseCatalog = activeManifest?.capabilities.databasePicker ?? false;
  const schemasFromState = connection ? (connState.schemasById.get(connection.id) ?? []) : [];
  const schemas = usesDatabaseCatalog
    ? (pgDatabases ?? []).map(n => ({ name: n, tables: [] }))
    : schemasFromState;
  const isLoading = usesDatabaseCatalog
    ? pgLoading
    : connection
      ? connState.loadingSchemasById.has(connection.id)
      : false;

  useEffect(() => {
    if (!open || !usesDatabaseCatalog || !connection) {
      if (!open) setPgDatabases(null);
      return;
    }
    let cancelled = false;
    setPgLoading(true);
    db.listDatabases(connection.id)
      .then(names => { if (!cancelled) setPgDatabases(names); })
      .catch(err => {
        if (!cancelled) toast.error(isDbError(err) ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setPgLoading(false); });
    return () => { cancelled = true; };
  }, [open, usesDatabaseCatalog, connection?.id]);

  // Encoding / collation choices are fetched from the live server via
  // adapter-supplied implementations (`list_charsets` /
  // `list_collations` on the Adapter trait — MySQL queries `SHOW
  // CHARACTER SET` and `information_schema.COLLATIONS`). Adapters that
  // don't model per-database encodings (SQLite, Mongo, Redis) return
  // empty lists, and the dialog hides the corresponding row.
  // Collations are *charset-scoped* — the second list reloads when the
  // user picks a different encoding.
  const [encodings, setEncodings] = useState<string[]>([]);
  const [collations, setCollations] = useState<string[]>([]);
  const showEncoding = encodings.length > 0;
  const showCollation = newCharset !== DEFAULT_OPT && collations.length > 0;

  useEffect(() => {
    if (!open) {
      setQuery('');
      setNewMode(false);
      setNewName('');
      setNewCharset(DEFAULT_OPT);
      setNewCollation(DEFAULT_OPT);
      setHighlight(null);
      return;
    }
    // Seed the highlight with the first result and focus is handled by the
    // Input's `autoFocus`.
    setHighlight(schemas[0]?.name ?? null);
  }, [open, schemas.length]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? schemas.filter(s => s.name.toLowerCase().includes(q)) : schemas;
  }, [schemas, query]);

  // Keep the highlight inside the filtered set.
  useEffect(() => {
    if (!filtered.some(s => s.name === highlight)) {
      setHighlight(filtered[0]?.name ?? null);
    }
  }, [filtered, highlight]);

  // Load encodings the first time the create view is opened. We only
  // probe the server when the user actually clicks "New…" — listing
  // charsets is cheap but it's still a round-trip we don't want to
  // pay on every database-picker open.
  useEffect(() => {
    if (!newMode || !connection) return;
    let cancelled = false;
    db.listCharsets(connection.id)
      .then(list => { if (!cancelled) setEncodings(list); })
      .catch(() => { if (!cancelled) setEncodings([]); });
    return () => { cancelled = true; };
  }, [newMode, connection?.id]);

  // Reload collations whenever the user picks a different charset.
  // Reset the user's collation selection back to Default — the
  // previous one almost certainly doesn't apply to the new charset.
  useEffect(() => {
    if (!newMode || !connection) return;
    if (newCharset === DEFAULT_OPT) {
      setCollations([]);
      return;
    }
    let cancelled = false;
    db.listCollations(connection.id, newCharset)
      .then(list => {
        if (cancelled) return;
        setCollations(list);
        setNewCollation(DEFAULT_OPT);
      })
      .catch(() => { if (!cancelled) setCollations([]); });
    return () => { cancelled = true; };
  }, [newMode, connection?.id, newCharset]);

  const [switching, setSwitching] = useState(false);

  const confirm = async (name: string | null) => {
    if (!name) return;
    if (usesDatabaseCatalog && connection) {
      // PG databases are isolated — rebuild the pool against the chosen
      // database before browsing. The tile keeps the real database name
      // (so the header reads "Local DB · postgres"); the sidebar picks a
      // schema from the fresh list itself (see sidebar.tsx — it defaults
      // to `public` or the first non-empty schema when the tile name is
      // not an actual schema).
      setSwitching(true);
      try {
        await db.switchDatabase(connection.id, name);
        await refreshSchemas(connection.id);
      } catch (err) {
        toast.error(isDbError(err) ? err.message : String(err));
        setSwitching(false);
        return;
      }
      setSwitching(false);
      onPick(name);
      onOpenChange(false);
      return;
    }
    onPick(name);
    onOpenChange(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    // Create view owns its own keys (Enter -> Create, Esc -> back).
    if (newMode) return;
    if (e.key === 'Escape') {
      onOpenChange(false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void confirm(highlight);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      const idx = Math.max(0, filtered.findIndex(s => s.name === highlight));
      const next = e.key === 'ArrowDown'
        ? Math.min(filtered.length - 1, idx + 1)
        : Math.max(0, idx - 1);
      setHighlight(filtered[next].name);
      // Scroll the new highlight into view.
      const el = listRef.current?.querySelector(`[data-name="${CSS.escape(filtered[next].name)}"]`);
      (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const trimmedNewName = newName.trim();
  const nameValid = trimmedNewName.length > 0 && NAME_RE.test(trimmedNewName);
  const nameError = trimmedNewName.length > 0 && !nameValid
    ? 'Use letters, digits, underscore, or hyphen only.'
    : null;

  const handleCreate = async () => {
    if (!connection || !nameValid) return;
    setCreating(true);
    try {
      const name = trimmedNewName;
      // `__default__` -> undefined so the server's own default kicks
      // in. We never send a charset the adapter didn't advertise (the
      // dialog wouldn't have shown the row at all in that case), and
      // we never send a collation without a chosen charset.
      const charset = showEncoding && newCharset !== DEFAULT_OPT ? newCharset : undefined;
      const collation = showCollation && newCollation !== DEFAULT_OPT ? newCollation : undefined;
      await db.createDatabase(connection.id, name, charset, collation);
      if (usesDatabaseCatalog) {
        // For catalog-driven adapters (Postgres) don't auto-switch:
        // the user's current session is still bound to the previous
        // database. Refresh the catalog list so the new name shows up,
        // and let them double-click to switch the pool.
        try {
          const names = await db.listDatabases(connection.id);
          setPgDatabases(names);
        } catch {
          /* non-fatal */
        }
        toast.success(`Created database ${name}. Double-click it to open.`);
        resetCreateForm();
        setHighlight(name);
      } else {
        await refreshSchemas(connection.id);
        toast.success(`Created database ${name}`);
        resetCreateForm();
        await confirm(name);
      }
    } catch (err) {
      toast.error(isDbError(err) ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const resetCreateForm = () => {
    setNewMode(false);
    setNewName('');
    setNewCharset(DEFAULT_OPT);
    setNewCollation(DEFAULT_OPT);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md! w-[28rem]! p-0! rounded-xl! gap-0! overflow-hidden"
        onKeyDown={handleKey}
      >
        {newMode ? (
          /* ---------- Create-database view ---------- */
          <>
            <div className="px-4 pt-4 pb-3 border-b border-border/50 text-center">
              <div className="text-sm font-medium">New Database</div>
            </div>

            <div
              className="p-4 space-y-3"
              onKeyDown={e => {
                if (e.key === 'Enter' && nameValid && !creating) {
                  e.preventDefault();
                  void handleCreate();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  resetCreateForm();
                }
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="db-new-name" className="text-xs">Name</Label>
                <Input
                  id="db-new-name"
                  autoFocus
                  placeholder="database_name"
                  className="h-9 text-sm"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  aria-invalid={!!nameError}
                />
                {nameError && (
                  <div className="text-[11px] text-destructive">{nameError}</div>
                )}
              </div>

              {/* base-ui's <Select.Value /> renders the raw value when
                  not given children. We want "Default (Server Pick)"
                  instead of `__default__` on the trigger, so each
                  Select passes a render function that maps the value
                  to a human label. */}
              {showEncoding && (
                <div className="space-y-1.5">
                  <Label htmlFor="db-new-charset" className="text-xs">Encoding</Label>
                  <Select value={newCharset} onValueChange={setNewCharset}>
                    <SelectTrigger id="db-new-charset" className="w-full">
                      <SelectValue>
                        {(v) => (v === DEFAULT_OPT ? DEFAULT_LABEL : String(v ?? ''))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_OPT}>{DEFAULT_LABEL}</SelectItem>
                      {encodings.map(name => (
                        <SelectItem key={name} value={name}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {showCollation && (
                <div className="space-y-1.5">
                  <Label htmlFor="db-new-collation" className="text-xs">Collation</Label>
                  <Select value={newCollation} onValueChange={setNewCollation}>
                    <SelectTrigger id="db-new-collation" className="w-full">
                      <SelectValue>
                        {(v) => (v === DEFAULT_OPT ? DEFAULT_LABEL : String(v ?? ''))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_OPT}>{DEFAULT_LABEL}</SelectItem>
                      {collations.map(name => (
                        <SelectItem key={name} value={name}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="px-3 py-3 border-t border-border/50 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={resetCreateForm}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={creating || !nameValid}
                onClick={() => void handleCreate()}
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Create'}
              </Button>
            </div>
          </>
        ) : (
          /* ---------- Picker view ---------- */
          <>
            <div className="px-4 pt-4 pb-3 border-b border-border/50 text-center">
              <div className="text-sm font-medium">Open database</div>
            </div>

            <div className="p-3 border-b border-border/50">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  placeholder="Search for database…"
                  className="pl-8 h-9 text-sm"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
              </div>
            </div>

            <div ref={listRef} className="max-h-80 overflow-auto py-1">
              {isLoading && filtered.length === 0 && (
                <div className="px-4 py-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading databases…
                </div>
              )}
              {!isLoading && filtered.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {schemas.length === 0 ? 'No databases on this server.' : 'No matches.'}
                </div>
              )}
              {filtered.map(s => {
                const isActive = s.name === highlight;
                return (
                  <button
                    key={s.name}
                    data-name={s.name}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 transition-colors ${
                      isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted/40'
                    }`}
                    onMouseEnter={() => setHighlight(s.name)}
                    onClick={() => void confirm(s.name)}
                    onDoubleClick={() => void confirm(s.name)}
                  >
                    <Database className="w-4 h-4 shrink-0" />
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className="text-[10px] text-muted-foreground">{s.tables.length}</span>
                  </button>
                );
              })}
            </div>

            <div className="px-3 py-3 border-t border-border/50 flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <div className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => setNewMode(true)}>
                New…
              </Button>
              <Button
                size="sm"
                disabled={!highlight || switching}
                onClick={() => void confirm(highlight)}
              >
                {switching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Open'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

