import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw,
  X,
  Loader2,
  Search,
  Trash2,
  Plus,
  ShieldCheck,
  Lock,
  KeyRound,
  ChevronLeft,
  ChevronRight,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Checkbox } from '../../components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { DestructiveConfirmDialog } from '../../components/destructive-confirm-dialog';
import { highlight, tokenClass } from '../../lib/highlight';
import {
  db,
  isDbError,
  type UserInfo,
  type UserRef,
  type GrantInfo,
  type GrantRequest,
  type RoleGrant,
  type ManageUsersCapability,
} from '../../lib/db';

// Privileges offered per engine. These mirror the backend allowlists
// (MYSQL_PRIVILEGES / PG_TABLE_PRIVILEGES); the backend re-validates, so a drift
// here can only ever be rejected, never injected. `withHost` distinguishes the
// two engines that support user management (MySQL has a host part, Postgres
// doesn't).
const MYSQL_PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX',
  'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER', 'EXECUTE',
  'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'LOCK TABLES',
  'CREATE TEMPORARY TABLES',
];
const PG_PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
];

/** Which of *.* / db / table a grant targets. For Postgres 'global' is not
 *  offered (table privileges are schema-scoped) and 'database' means schema. */
type ScopeKind = 'global' | 'database' | 'table';

const ALL_PRIVILEGES = 'ALL PRIVILEGES';

/** One editable grant card's working state. `scope` is explicit (not derived
 *  from null-ness) so an empty schema field stays a schema grant, not a global
 *  one. Converted to a `GrantRequest` at apply time. */
interface GrantDraft {
  privileges: string[];
  scope: ScopeKind;
  database: string;
  table: string;
  withGrantOption: boolean;
}

/** A blank grant for a new card. Postgres seeds the `public` schema; MySQL
 *  defaults to global scope with no database. */
function defaultDraft(withHost: boolean): GrantDraft {
  return {
    privileges: [],
    scope: withHost ? 'global' : 'database',
    database: withHost ? '' : 'public',
    table: '',
    withGrantOption: false,
  };
}

/** Turn a card's draft into the backend request for `user`. */
function draftToRequest(d: GrantDraft, user: UserRef): GrantRequest {
  return {
    user,
    privileges: d.privileges.includes(ALL_PRIVILEGES) ? [ALL_PRIVILEGES] : d.privileges,
    database: d.scope === 'global' ? null : d.database.trim() || null,
    table: d.scope === 'table' ? d.table.trim() || null : null,
    withGrantOption: d.withGrantOption,
  };
}

/** Validate a draft the user intends to apply; returns an error string or null.
 *  Empty-privilege drafts are treated as blank (skipped), not errors. */
function draftError(d: GrantDraft, scopeLabel: string): string | null {
  if (d.privileges.length === 0) return null;
  if (d.scope !== 'global' && !d.database.trim()) return `Enter a ${scopeLabel.toLowerCase()} name for the grant.`;
  if (d.scope === 'table' && !d.table.trim()) return 'Enter a table name for the grant.';
  return null;
}

/** Strip surrounding backticks/double-quotes from an identifier and un-double
 *  any internal quote. */
function unquoteIdent(s: string): string {
  const t = s.trim();
  const q = t[0];
  if (t.length >= 2 && (q === '`' || q === '"') && t[t.length - 1] === q) {
    return t.slice(1, -1).split(q + q).join(q);
  }
  return t;
}

/** Split a `db.table` qualifier on the dot that isn't inside quotes. */
function splitQualified(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '`' || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '.') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Best-effort parse of one GRANT statement (MySQL `SHOW GRANTS` line or the
 *  Postgres assembled form) into an editable draft. Returns null for anything
 *  that isn't a plain privilege grant on a table/db/schema scope — role
 *  memberships, `ALTER ROLE`, and `USAGE`-only lines stay display-only. */
function parseGrantStatement(stmt: string, withHost: boolean): GrantDraft | null {
  const m = stmt.match(/^\s*GRANT\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+TO\b/i);
  if (!m) return null;
  const withGrantOption = /WITH\s+GRANT\s+OPTION/i.test(stmt);
  let privileges = m[1]
    .split(',')
    .map(p => p.trim().replace(/\s+/g, ' ').toUpperCase())
    .filter(p => p && p !== 'USAGE');
  if (privileges.length === 0) return null;
  if (privileges.includes(ALL_PRIVILEGES) || privileges.includes('ALL')) privileges = [ALL_PRIVILEGES];

  let target = m[2].trim().replace(/^TABLE\s+/i, '');
  const allInSchema = target.match(/^ALL\s+TABLES\s+IN\s+SCHEMA\s+([\s\S]+)$/i);
  if (allInSchema) {
    return { privileges, scope: 'database', database: unquoteIdent(allInSchema[1]), table: '', withGrantOption };
  }
  if (target === '*.*') {
    return { privileges, scope: 'global', database: '', table: '', withGrantOption };
  }
  const parts = splitQualified(target);
  const db = unquoteIdent(parts[0] ?? '');
  const tbl = parts.length > 1 ? (parts[1] ?? '').trim() : '';
  if (tbl === '' || tbl === '*') {
    return { privileges, scope: 'database', database: db, table: '', withGrantOption };
  }
  // A parse that produced a global-only scope on MySQL is fine; on Postgres a
  // schema is required, but parsed PG grants always carry one.
  void withHost;
  return { privileges, scope: 'table', database: db, table: unquoteIdent(tbl), withGrantOption };
}

/** Stable key for a grant's scope (so grants on the same target are diffed
 *  together regardless of card order). */
function scopeKeyOf(d: GrantDraft): string {
  return JSON.stringify({
    db: d.scope === 'global' ? null : d.database.trim(),
    tbl: d.scope === 'table' ? d.table.trim() : null,
  });
}

/** Result of diffing the original grants against the edited cards: the grant
 *  and revoke requests needed to reconcile them. Revokes are applied first. */
function diffGrants(originals: GrantDraft[], desired: GrantDraft[], user: UserRef): {
  revoke: GrantRequest[];
  grant: GrantRequest[];
} {
  type Bucket = { sample: GrantDraft; privs: Set<string>; grantOption: boolean };
  const build = (list: GrantDraft[]) => {
    const map = new Map<string, Bucket>();
    for (const d of list) {
      if (d.privileges.length === 0) continue;
      const k = scopeKeyOf(d);
      const b = map.get(k) ?? { sample: d, privs: new Set<string>(), grantOption: false };
      d.privileges.forEach(p => b.privs.add(p));
      if (d.withGrantOption) b.grantOption = true;
      map.set(k, b);
    }
    return map;
  };
  const orig = build(originals);
  const want = build(desired);
  const revoke: GrantRequest[] = [];
  const grant: GrantRequest[] = [];
  for (const k of new Set([...orig.keys(), ...want.keys()])) {
    const o = orig.get(k);
    const w = want.get(k);
    const sample = (w ?? o)!.sample;
    const oPrivs = o?.privs ?? new Set<string>();
    const wPrivs = w?.privs ?? new Set<string>();
    const toRevoke = [...oPrivs].filter(p => !wPrivs.has(p));
    const toGrant = [...wPrivs].filter(p => !oPrivs.has(p));
    if (toRevoke.length) revoke.push(draftToRequest({ ...sample, privileges: toRevoke }, user));
    if (toGrant.length) {
      grant.push(draftToRequest({ ...sample, privileges: toGrant, withGrantOption: w?.grantOption ?? false }, user));
    }
  }
  return { revoke, grant };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  /** Driver — used only to shape labels (MySQL has a host part; others don't). */
  driver: string;
}

/** MySQL accounts are `'name'@'host'`; other engines have no host component. */
// `driver` is the `Driver` label ('MySQL', 'PostgreSQL', 'MongoDB', …) but some
// call paths pass the lowercase adapter key, so match case-insensitively.
function hasHostConcept(driver: string): boolean {
  const d = driver.toLowerCase();
  return d === 'mysql' || d === 'mariadb';
}
function isMongoDriver(driver: string): boolean {
  const d = driver.toLowerCase();
  return d === 'mongodb' || d === 'mongo';
}

function userKey(u: UserRef): string {
  return u.host != null ? `${u.name}@${u.host}` : u.name;
}

function userLabel(u: UserInfo): string {
  return u.host ? `${u.name}@${u.host}` : u.name;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; user: UserInfo };

export function UsersPanel({ open, onOpenChange, connectionId, driver }: Props) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<ManageUsersCapability | null>(null);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  // The user whose grants are shown in the inspector, keyed so a refresh
  // that drops/reorders rows can't point it at the wrong account.
  const [grantsFor, setGrantsFor] = useState<UserRef | null>(null);
  const [grants, setGrants] = useState<GrantInfo | null>(null);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [dropTarget, setDropTarget] = useState<UserInfo | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  const withHost = hasHostConcept(driver);
  const isMongo = isMongoDriver(driver);
  const canManage = cap?.canManage ?? false;

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      // Probe privileges and list in parallel — listing may itself require
      // privilege, so surface the capability reason if the list fails.
      const [capability, list] = await Promise.all([
        db.canManageUsers(connectionId),
        db.listUsers(connectionId),
      ]);
      setCap(capability);
      setUsers(list);
    } catch (err) {
      setError(isDbError(err) ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (open) {
      void fetchUsers();
    } else {
      // Reset transient state so re-opening starts clean.
      setUsers([]);
      setSearch('');
      setMode({ kind: 'list' });
      setGrantsFor(null);
      setGrants(null);
      setDropTarget(null);
      setError(null);
    }
  }, [open, fetchUsers]);

  const visibleUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      [u.name, u.host, ...u.attributes].some(
        (f) => f != null && String(f).toLowerCase().includes(q),
      ),
    );
  }, [users, search]);

  const openGrants = useCallback(
    async (u: UserInfo) => {
      const ref: UserRef = { name: u.name, host: u.host ?? null, database: u.database ?? null };
      setGrantsFor(ref);
      // Mongo has no SHOW GRANTS — its roles come back structured on the user,
      // so render them directly instead of calling the (unsupported) command.
      if (isMongo) {
        setGrants({ statements: (u.roles ?? []).map(r => `${r.role} @ ${r.db}`) });
        return;
      }
      setGrants(null);
      setGrantsLoading(true);
      try {
        const g = await db.listGrants(connectionId, ref);
        setGrants(g);
      } catch (err) {
        toast.error(isDbError(err) ? err.message : String(err));
        setGrantsFor(null);
      } finally {
        setGrantsLoading(false);
      }
    },
    [connectionId, isMongo],
  );

  const confirmDrop = useCallback(async () => {
    if (!dropTarget) return;
    const ref: UserRef = { name: dropTarget.name, host: dropTarget.host ?? null, database: dropTarget.database ?? null };
    try {
      await db.dropUser(connectionId, ref);
      toast.success(`Dropped ${userLabel(dropTarget)}`);
      if (grantsFor && userKey(grantsFor) === userKey(ref)) {
        setGrantsFor(null);
        setGrants(null);
      }
      await fetchUsers();
    } catch (err) {
      toast.error(isDbError(err) ? err.message : String(err));
    }
  }, [dropTarget, connectionId, grantsFor, fetchUsers]);

  const handleRefresh = useCallback(() => void fetchUsers(), [fetchUsers]);
  const [flushing, setFlushing] = useState(false);
  const handleFlush = useCallback(async () => {
    setFlushing(true);
    try {
      await db.flushPrivileges(connectionId);
      toast.success('Privileges flushed');
    } catch (err) {
      toast.error(isDbError(err) ? err.message : String(err));
    } finally {
      setFlushing(false);
    }
  }, [connectionId]);
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  const handleSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value),
    [],
  );
  const handleNewUser = useCallback(() => setMode({ kind: 'create' }), []);
  const backToList = useCallback(() => setMode({ kind: 'list' }), []);
  const closeGrants = useCallback(() => {
    setGrantsFor(null);
    setGrants(null);
  }, []);

  const afterSave = useCallback(async () => {
    setMode({ kind: 'list' });
    await fetchUsers();
  }, [fetchUsers]);

  const makeOpenGrants = useCallback(
    (u: UserInfo) => () => void openGrants(u),
    [openGrants],
  );
  const makeEdit = useCallback(
    (u: UserInfo) => () => setMode({ kind: 'edit', user: u }),
    [],
  );
  const makeDrop = useCallback((u: UserInfo) => () => setDropTarget(u), []);
  const clearDropTarget = useCallback(
    (o: boolean) => !o && setDropTarget(null),
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-4xl max-h-[80vh] flex flex-col overflow-hidden min-h-0"
        initialFocus={listContainerRef}
      >
        <DialogHeader>
          <DialogTitle>
            {mode.kind === 'create'
              ? 'Create user'
              : mode.kind === 'edit'
                ? `Edit ${userLabel(mode.user)}`
                : 'Users & Privileges'}
          </DialogTitle>
        </DialogHeader>

        {/* Privilege banner — always visible so the user knows why controls
            are disabled. */}
        {cap && !canManage && (
          <div className="flex items-start gap-2 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs p-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              You can view users but not modify them — {cap.reason || 'insufficient privileges'}.
            </span>
          </div>
        )}

        {error && (
          <div className="rounded bg-destructive/10 text-destructive text-xs p-2">
            {error}
          </div>
        )}

        {mode.kind === 'list' ? (
          <>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewUser}
                disabled={!canManage}
                title={
                  canManage
                    ? 'Create a new user'
                    : 'Requires user-management privileges'
                }
              >
                <Plus className="w-3.5 h-3.5" /> New user
              </Button>
              {/* FLUSH PRIVILEGES is MySQL-only (Postgres applies grants
                  immediately). Handy after editing the grant tables directly. */}
              {withHost && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleFlush()}
                  disabled={!canManage || flushing}
                  title={
                    canManage
                      ? 'Reload the in-memory grant tables (FLUSH PRIVILEGES)'
                      : 'Requires user-management privileges'
                  }
                >
                  {flushing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <KeyRound className="w-3.5 h-3.5" />
                  )}
                  Flush privileges
                </Button>
              )}
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {search.trim()
                  ? `${visibleUsers.length} / ${users.length}`
                  : `${users.length} total`}
              </span>
              <div className="ml-auto relative w-56">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={search}
                  onChange={handleSearch}
                  placeholder="Filter users…"
                  className="h-8 rounded-md pl-8 pr-3 text-xs"
                />
              </div>
            </div>

            <div className="flex flex-1 gap-3 min-h-0">
              <div
                ref={listContainerRef}
                tabIndex={-1}
                className="flex-1 overflow-auto border rounded outline-none"
              >
                <table className="w-full text-xs">
                  <thead className="text-xs text-muted-foreground bg-muted sticky top-0 z-10 shadow-sm">
                    <tr>
                      <th className="px-3 py-2 border-b border-r border-border font-medium text-left">
                        User
                      </th>
                      {withHost && (
                        <th className="px-3 py-2 border-b border-r border-border font-medium text-left">
                          Host
                        </th>
                      )}
                      <th className="px-3 py-2 border-b border-r border-border font-medium text-left">
                        Attributes
                      </th>
                      <th className="px-3 py-2 border-b border-border font-medium w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsers.length === 0 && !loading && (
                      <tr>
                        <td
                          colSpan={withHost ? 4 : 3}
                          className="px-3 py-4 text-center text-muted-foreground"
                        >
                          {users.length === 0
                            ? 'No users'
                            : 'No users match your filter'}
                        </td>
                      </tr>
                    )}
                    {visibleUsers.map((u) => (
                      <tr
                        key={userKey({ name: u.name, host: u.host })}
                        className={`border-b border-border hover:bg-muted/50 ${
                          grantsFor &&
                          userKey(grantsFor) ===
                            userKey({ name: u.name, host: u.host })
                            ? 'bg-muted/40'
                            : ''
                        }`}
                      >
                        <td className="px-3 py-1.5 border-r border-border">
                          <button
                            type="button"
                            className="flex items-center gap-1.5 text-left hover:text-primary font-mono"
                            onClick={makeOpenGrants(u)}
                            title="View grants"
                          >
                            {u.isSuperuser && (
                              <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0" />
                            )}
                            {u.isLocked && (
                              <Lock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            )}
                            {u.name}
                          </button>
                        </td>
                        {withHost && (
                          <td className="px-3 py-1.5 border-r border-border font-mono">
                            {u.host ?? '-'}
                          </td>
                        )}
                        <td className="px-3 py-1.5 border-r border-border text-muted-foreground">
                          {u.attributes.length > 0
                            ? u.attributes.join(', ')
                            : u.isSuperuser
                              ? 'Superuser'
                              : '-'}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={makeEdit(u)}
                              disabled={!canManage}
                              title={
                                canManage ? 'Edit user' : 'Requires privileges'
                              }
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={makeDrop(u)}
                              disabled={!canManage}
                              title={
                                canManage ? 'Drop user' : 'Requires privileges'
                              }
                            >
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Grants inspector — opens beside the list when a user is
                  selected. */}
              {grantsFor && (
                <div className="w-72 shrink-0 border rounded flex flex-col overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-2 border-b bg-muted text-xs font-medium">
                    <span className="truncate font-mono">
                      {userKey(grantsFor)}
                    </span>
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      onClick={closeGrants}
                      title="Close grants"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-auto p-2">
                    {grantsLoading ? (
                      <div className="flex items-center justify-center py-6 text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                    ) : grants && grants.statements.length > 0 ? (
                      <ul className="space-y-1">
                        {grants.statements.map((s, i) => (
                          <li
                            key={i}
                            className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all bg-muted/40 rounded px-2 py-1 select-text"
                          >
                            {s}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-xs text-muted-foreground text-center py-6">
                        No grants
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : isMongo ? (
          <MongoUserForm
            connectionId={connectionId}
            mode={mode}
            onCancel={backToList}
            onSaved={afterSave}
          />
        ) : (
          <UserForm
            connectionId={connectionId}
            withHost={withHost}
            mode={mode}
            onCancel={backToList}
            onSaved={afterSave}
          />
        )}

        {mode.kind === 'list' && (
          <DialogFooter>
            <Button variant="ghost" onClick={handleClose}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>

      {dropTarget && (
        <DestructiveConfirmDialog
          open={dropTarget != null}
          onOpenChange={clearDropTarget}
          action="Drop"
          itemNoun="user"
          itemNames={[userLabel(dropTarget)]}
          warning="This permanently removes the account and its privileges."
          onConfirm={confirmDrop}
        />
      )}
    </Dialog>
  );
}

// ---- Create / edit form ----

interface FormProps {
  connectionId: string;
  withHost: boolean;
  mode: { kind: 'create' } | { kind: 'edit'; user: UserInfo };
  onCancel: () => void;
  onSaved: () => void;
}

function UserForm({ connectionId, withHost, mode, onCancel, onSaved }: FormProps) {
  const editing = mode.kind === 'edit';
  const existing = editing ? mode.user : null;

  const [name, setName] = useState(existing?.name ?? '');
  const [host, setHost] = useState(existing?.host ?? '%');
  const [password, setPassword] = useState('');
  const [isSuperuser, setIsSuperuser] = useState(existing?.isSuperuser ?? false);
  const [canLogin, setCanLogin] = useState(existing?.canLogin ?? true);
  const [isLocked, setIsLocked] = useState(existing?.isLocked ?? false);
  const [saving, setSaving] = useState(false);
  // Grant cards. In create mode they're staged and applied after the user is
  // made; in edit mode they're seeded from the account's current grants and
  // reconciled (grant/revoke diff) on save. Always keeps at least one card.
  const [pendingGrants, setPendingGrants] = useState<GrantDraft[]>(() => [defaultDraft(withHost)]);
  // Edit mode only: the parsed grants the account started with (for diffing)
  // and the raw statements (shown read-only, incl. lines we can't map to cards).
  const [originalGrants, setOriginalGrants] = useState<GrantDraft[]>([]);
  const [currentGrantsRaw, setCurrentGrantsRaw] = useState<string[]>([]);
  const addPendingGrant = useCallback(() => setPendingGrants(prev => [...prev, defaultDraft(withHost)]), [withHost]);
  const removePendingGrant = useCallback((i: number) => setPendingGrants(prev => prev.filter((_, idx) => idx !== i)), []);
  const updatePendingGrant = useCallback(
    (i: number, d: GrantDraft) => setPendingGrants(prev => prev.map((g, idx) => (idx === i ? d : g))),
    [],
  );

  // Edit mode: load the account's current grants, map the parseable ones into
  // editable cards, and remember the originals so save can reconcile changes.
  useEffect(() => {
    if (!editing || !existing) return;
    let cancelled = false;
    const ref: UserRef = { name: existing.name, host: existing.host ?? null };
    db.listGrants(connectionId, ref)
      .then(info => {
        if (cancelled) return;
        setCurrentGrantsRaw(info.statements);
        const parsed = info.statements
          .map(s => parseGrantStatement(s, withHost))
          .filter((d): d is GrantDraft => d !== null);
        setOriginalGrants(parsed);
        setPendingGrants(parsed.length > 0 ? parsed.map(d => ({ ...d })) : [defaultDraft(withHost)]);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentGrantsRaw([]);
        setOriginalGrants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [editing, existing, connectionId, withHost]);

  const handleName = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    [],
  );
  const handleHost = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setHost(e.target.value),
    [],
  );
  const handlePassword = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value),
    [],
  );
  const handleSuper = useCallback(
    (v: boolean | 'indeterminate') => setIsSuperuser(v === true),
    [],
  );
  const handleLogin = useCallback(
    (v: boolean | 'indeterminate') => setCanLogin(v === true),
    [],
  );
  const handleLocked = useCallback(
    (v: boolean | 'indeterminate') => setIsLocked(v === true),
    [],
  );

  const save = useCallback(async () => {
    if (!editing && !name.trim()) {
      toast.error('Enter a user name.');
      return;
    }
    setSaving(true);
    try {
      if (editing && existing) {
        const ref: UserRef = { name: existing.name, host: existing.host ?? null };
        await db.alterUser(connectionId, {
          name: existing.name,
          host: existing.host ?? null,
          // Only send a password when the user typed one.
          password: password.trim() ? password : null,
          isSuperuser:
            existing.isSuperuser !== isSuperuser ? isSuperuser : null,
          canLogin: existing.canLogin !== canLogin ? canLogin : null,
          // Only send a lock change when the server actually has a lock concept
          // (MySQL sets is_locked to a real bool; Postgres leaves it null, and
          // its "lock" is proxied to NOLOGIN). Without the null guard, PG edits
          // always saw `null !== false` → sent false → silently appended LOGIN,
          // turning NOLOGIN roles into login roles on every edit.
          isLocked: existing.isLocked != null && existing.isLocked !== isLocked ? isLocked : null,
        });

        // Reconcile grants: diff the edited cards against what the account
        // started with, then revoke removed privileges and grant added ones.
        // A superuser already has everything, so skip grant edits for them.
        const scopeLabel = withHost ? 'Database' : 'Schema';
        if (!isSuperuser) {
          for (const d of pendingGrants) {
            const err = draftError(d, scopeLabel);
            if (err) {
              toast.error(err);
              return;
            }
          }
          const { revoke, grant } = diffGrants(originalGrants, pendingGrants, ref);
          let failed = 0;
          // Revokes first so an ALL→specific narrowing lands correctly.
          for (const req of revoke) {
            try {
              await db.revokePrivileges(connectionId, req);
            } catch (e) {
              failed++;
              toast.error(`Revoke failed: ${isDbError(e) ? e.message : String(e)}`);
            }
          }
          for (const req of grant) {
            try {
              await db.grantPrivileges(connectionId, req);
            } catch (e) {
              failed++;
              toast.error(`Grant failed: ${isDbError(e) ? e.message : String(e)}`);
            }
          }
          if (failed === 0) toast.success('User updated');
        } else {
          toast.success('User updated');
        }
      } else {
        // A superuser already has full access, so staged per-object grants are
        // redundant. Otherwise take the cards with at least one privilege; a
        // card left with no privileges is an empty draft and is skipped.
        const scopeLabel = withHost ? 'Database' : 'Schema';
        const drafts = isSuperuser ? [] : pendingGrants.filter(d => d.privileges.length > 0);
        // Validate BEFORE creating the user so we don't leave a half-configured
        // account when a grant card is missing its schema/table.
        for (const d of drafts) {
          const err = draftError(d, scopeLabel);
          if (err) {
            toast.error(err);
            return;
          }
        }
        await db.createUser(connectionId, {
          name: name.trim(),
          host: withHost ? host.trim() || '%' : null,
          password: password.trim() ? password : null,
          isSuperuser,
          canLogin,
        });
        // The user now exists; each grant is a separate statement (DDL can't be
        // transactional), so surface a per-grant failure but don't abort.
        if (drafts.length > 0) {
          const newUser: UserRef = { name: name.trim(), host: withHost ? host.trim() || '%' : null };
          let failed = 0;
          for (const d of drafts) {
            try {
              await db.grantPrivileges(connectionId, draftToRequest(d, newUser));
            } catch (e) {
              failed++;
              toast.error(`Grant failed: ${isDbError(e) ? e.message : String(e)}`);
            }
          }
          const applied = drafts.length - failed;
          toast.success(`User created${applied > 0 ? ` with ${applied} grant${applied === 1 ? '' : 's'}` : ''}`);
        } else {
          toast.success('User created');
        }
      }
      onSaved();
    } catch (err) {
      toast.error(isDbError(err) ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [
    editing,
    existing,
    name,
    host,
    password,
    isSuperuser,
    canLogin,
    isLocked,
    withHost,
    connectionId,
    onSaved,
    pendingGrants,
    originalGrants,
  ]);

  const handleSaveClick = useCallback(() => void save(), [save]);

  return (
    // Column that fills the dialog: a scrollable body + a footer pinned to the
    // bottom (outside the scroll area) so Back/Create stay visible.
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      {/* Scrollable body. min-w-0 lets flex/grid children shrink instead of
          forcing the popup wider (the cause of the stray horizontal scrollbar);
          overflow-x-hidden guards it; pr-1 keeps content off the scrollbar. */}
      <div className="flex flex-col gap-3 flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden pr-1 pb-4">
      {/* Two-column field grid: Name / Host (MySQL only) / Password flow into
          two columns. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="user-name">Name</Label>
          <Input
            id="user-name"
            value={name}
            onChange={handleName}
            disabled={editing}
            placeholder="username"
            autoFocus={!editing}
          />
        </div>
        {withHost && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="user-host">Host</Label>
            <Input
              id="user-host"
              value={host}
              onChange={handleHost}
              disabled={editing}
              placeholder="%"
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="user-password">
            {editing ? 'New password (leave blank to keep)' : 'Password'}
          </Label>
          <Input
            id="user-password"
            type="text"
            value={password}
            onChange={handlePassword}
            placeholder={editing ? 'leave blank to keep' : 'password'}
            autoComplete="new-password"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
        <Label className="cursor-pointer flex items-center gap-2">
          <Checkbox checked={canLogin} onCheckedChange={handleLogin} />
          Can log in
        </Label>
        <Label className="cursor-pointer flex items-center gap-2">
          <Checkbox checked={isSuperuser} onCheckedChange={handleSuper} />
          Superuser (full privileges)
        </Label>
        {editing && withHost && (
          <Label className="cursor-pointer flex items-center gap-2">
            <Checkbox checked={isLocked} onCheckedChange={handleLocked} />
            Account locked
          </Label>
        )}
      </div>

      {/* A superuser already has full access, so per-object grants are moot —
          hide the whole section when the Superuser box is ticked. */}
      {isSuperuser ? (
        <div className="border-t border-border pt-4">
          <div className="text-sm font-medium">Privileges &amp; grants</div>
          <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <ShieldCheck className="w-4 h-4 shrink-0 text-amber-500" />
            Superuser has full access — individual privileges aren’t needed.
          </div>
        </div>
      ) : (
        <GrantsEditor
          withHost={withHost}
          caption={
            editing
              ? 'Edit the account’s grants below — changes are reconciled on save.'
              : 'Stage privileges to apply right after the user is created.'
          }
          currentGrants={editing ? currentGrantsRaw : undefined}
          drafts={pendingGrants}
          onAddDraft={addPendingGrant}
          onRemoveDraft={removePendingGrant}
          onUpdateDraft={updatePendingGrant}
        />
      )}

      </div>

      <DialogFooter className="shrink-0 mt-0 pt-3 border-t border-border">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          <ChevronLeft className="w-3.5 h-3.5" /> Back
        </Button>
        <Button onClick={handleSaveClick} disabled={saving}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {editing ? 'Save changes' : 'Create user'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ---- Privileges & grants editor ----

interface GrantsEditorProps {
  /** true = MySQL (host part, global/db/table scopes); false = Postgres
   *  (schema/table scopes, `database` field carries the schema). */
  withHost: boolean;
  /** Header caption under the section title. */
  caption: string;
  /** Raw current-grant statements, shown read-only above the cards (edit mode).
   *  Includes lines that couldn't be mapped to a card (roles, USAGE, …). */
  currentGrants?: string[];
  drafts: GrantDraft[];
  onAddDraft: () => void;
  onRemoveDraft: (index: number) => void;
  onUpdateDraft: (index: number, draft: GrantDraft) => void;
}

function GrantsEditor({
  withHost,
  caption,
  currentGrants,
  drafts,
  onAddDraft,
  onRemoveDraft,
  onUpdateDraft,
}: GrantsEditorProps) {
  const catalog = withHost ? MYSQL_PRIVILEGES : PG_PRIVILEGES;
  const scopeLabel = withHost ? 'Database' : 'Schema';
  const scopes: ScopeKind[] = withHost ? ['global', 'database', 'table'] : ['database', 'table'];
  // The raw grant SQL is redundant with the cards, so keep it collapsed by
  // default; the user can expand it to see the exact statements.
  const [showCurrent, setShowCurrent] = useState(false);

  // The editable fields of one grant card, bound to `draft`. Rendered as a
  // plain function (not a child component) so typing in an input doesn't
  // remount and drop focus.
  const renderFields = (draft: GrantDraft, onChange: (d: GrantDraft) => void) => {
    const privs = draft.privileges;
    const isAll = privs.includes(ALL_PRIVILEGES);
    // Show the standard privileges PLUS any the account already holds that
    // aren't in the standard set (e.g. MySQL 8 dynamic privileges like
    // SYSTEM_USER) — so every current grant maps to a visible, understandable
    // checkbox instead of only appearing in the raw text above.
    const extras = privs.filter(p => p !== ALL_PRIVILEGES && !catalog.includes(p));
    const shownPrivs = [...catalog, ...extras];
    const setPrivs = (next: string[]) => onChange({ ...draft, privileges: next });
    const togglePriv = (p: string, on: boolean) => {
      const cur = new Set(privs);
      if (on) cur.add(p);
      else cur.delete(p);
      setPrivs([...cur]);
    };
    return (
      <>
        <div className="grid gap-2">
          <label className="text-sm font-medium">Privileges</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
            <Label className="cursor-pointer text-sm flex items-center gap-2">
              <Checkbox
                checked={isAll}
                onCheckedChange={v => setPrivs(v === true ? [ALL_PRIVILEGES] : [])}
              />
              All privileges
            </Label>
            {!isAll &&
              shownPrivs.map(p => (
                <Label key={p} className="cursor-pointer text-sm flex items-center gap-2">
                  <Checkbox checked={privs.includes(p)} onCheckedChange={v => togglePriv(p, v === true)} />
                  {p}
                </Label>
              ))}
          </div>
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium">Apply to</label>
          <RadioGroup
            value={draft.scope}
            onValueChange={v => onChange({ ...draft, scope: v as ScopeKind })}
            className="flex flex-row flex-wrap gap-4"
          >
            {scopes.map(s => (
              <Label key={s} className="cursor-pointer text-sm flex items-center gap-2">
                <RadioGroupItem value={s} />
                {s === 'global' ? 'All (*.*)' : s === 'database' ? scopeLabel : 'Table'}
              </Label>
            ))}
          </RadioGroup>
        </div>

        {draft.scope !== 'global' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <label className="text-sm font-medium">{scopeLabel}</label>
              <Input
                className="w-full"
                value={draft.database}
                onChange={e => onChange({ ...draft, database: e.target.value })}
                placeholder={scopeLabel.toLowerCase()}
              />
            </div>
            {draft.scope === 'table' && (
              <div className="grid gap-2">
                <label className="text-sm font-medium">Table</label>
                <Input
                  className="w-full"
                  value={draft.table}
                  onChange={e => onChange({ ...draft, table: e.target.value })}
                  placeholder="table"
                />
              </div>
            )}
          </div>
        )}

        <Label className="cursor-pointer text-sm flex items-center gap-2">
          <Checkbox
            checked={draft.withGrantOption}
            onCheckedChange={v => onChange({ ...draft, withGrantOption: v === true })}
          />
          With grant option
        </Label>
      </>
    );
  };

  return (
    <div className="border-t border-border pt-4 flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium">Privileges &amp; grants</div>
        <div className="text-xs text-muted-foreground">{caption}</div>
      </div>

      {currentGrants && currentGrants.length > 0 && (
        <div className="grid gap-1.5">
          <button
            type="button"
            onClick={() => setShowCurrent(v => !v)}
            className="flex items-center gap-1 text-sm font-medium w-fit hover:text-foreground/80"
            aria-expanded={showCurrent}
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showCurrent ? 'rotate-90' : ''}`} />
            Current grants
            <span className="text-xs font-normal text-muted-foreground">({currentGrants.length})</span>
          </button>
          {showCurrent && (
            <div className="rounded-md border border-border bg-muted/30 p-2.5 text-[11px] font-mono max-h-28 overflow-auto space-y-1">
              {currentGrants.map((g, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {highlight(g, 'sql').map((t, j) => (
                    <span key={j} className={tokenClass[t.kind]}>{t.text}</span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {drafts.map((d, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="rounded-md border border-border p-3 flex flex-col gap-3">
              {renderFields(d, nd => onUpdateDraft(i, nd))}
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onRemoveDraft(i)}
                disabled={drafts.length <= 1}
                title={drafts.length <= 1 ? 'Keep at least one grant' : 'Delete this grant'}
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div>
        <Button size="sm" variant="outline" onClick={onAddDraft}>
          <Plus className="w-3.5 h-3.5" /> Add grant
        </Button>
      </div>
    </div>
  );
}

// ---- MongoDB user form (role-based) ----

/** Built-in MongoDB roles offered in the picker. Database-level roles first,
 *  then cluster/backup and the `*AnyDatabase` admin roles. */
const MONGO_ROLES = [
  'read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin',
  'clusterAdmin', 'clusterManager', 'clusterMonitor', 'hostManager',
  'backup', 'restore',
  'readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase',
  'root',
];

/** One card: a set of roles scoped to a single database. */
interface MongoRoleCard {
  roles: string[];
  db: string;
}

interface MongoFormProps {
  connectionId: string;
  mode: { kind: 'create' } | { kind: 'edit'; user: UserInfo };
  onCancel: () => void;
  onSaved: () => void;
}

/** Group a user's flat role list into one card per target database (so the UI
 *  shows "these roles on db X" rather than a long flat list). */
function groupRolesByDb(roles: RoleGrant[] | undefined | null, fallbackDb: string): MongoRoleCard[] {
  const byDb = new Map<string, string[]>();
  for (const r of roles ?? []) {
    const list = byDb.get(r.db) ?? [];
    list.push(r.role);
    byDb.set(r.db, list);
  }
  if (byDb.size === 0) return [{ roles: [], db: fallbackDb }];
  return [...byDb.entries()].map(([db, rs]) => ({ roles: rs, db }));
}

function MongoUserForm({ connectionId, mode, onCancel, onSaved }: MongoFormProps) {
  const editing = mode.kind === 'edit';
  const existing = editing ? mode.user : null;
  const authDb = existing?.database ?? 'admin';

  const [name, setName] = useState(existing?.name ?? '');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState(authDb);
  const [cards, setCards] = useState<MongoRoleCard[]>(() => groupRolesByDb(existing?.roles, authDb));
  const [saving, setSaving] = useState(false);

  const addCard = useCallback(() => setCards(prev => [...prev, { roles: [], db: database }]), [database]);
  const removeCard = useCallback((i: number) => setCards(prev => prev.filter((_, idx) => idx !== i)), []);
  const updateCard = useCallback(
    (i: number, c: MongoRoleCard) => setCards(prev => prev.map((x, idx) => (idx === i ? c : x))),
    [],
  );

  const save = useCallback(async () => {
    if (!editing && !name.trim()) {
      toast.error('Enter a user name.');
      return;
    }
    if (!editing && !password.trim()) {
      toast.error('MongoDB requires a password to create a user.');
      return;
    }
    // Flatten cards → { role, db }. A card with roles must name a database.
    const roles: RoleGrant[] = [];
    for (const c of cards) {
      if (c.roles.length === 0) continue;
      if (!c.db.trim()) {
        toast.error('Enter a database for each role group.');
        return;
      }
      for (const role of c.roles) roles.push({ role, db: c.db.trim() });
    }
    setSaving(true);
    try {
      if (editing && existing) {
        await db.alterUser(connectionId, {
          name: existing.name,
          database: existing.database ?? (database.trim() || 'admin'),
          password: password.trim() ? password : null,
          roles,
        });
        toast.success('User updated');
      } else {
        await db.createUser(connectionId, {
          name: name.trim(),
          password,
          database: database.trim() || 'admin',
          roles,
        });
        toast.success('User created');
      }
      onSaved();
    } catch (err) {
      toast.error(isDbError(err) ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [editing, existing, name, password, database, cards, connectionId, onSaved]);

  const handleSaveClick = useCallback(() => void save(), [save]);

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="flex flex-col gap-3 flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden pr-1 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mongo-name">Name</Label>
            <Input
              id="mongo-name"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={editing}
              placeholder="username"
              autoFocus={!editing}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mongo-password">
              {editing ? 'New password (leave blank to keep)' : 'Password'}
            </Label>
            <Input
              id="mongo-password"
              type="text"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={editing ? 'leave blank to keep' : 'password'}
              autoComplete="new-password"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mongo-authdb">Auth database</Label>
            <Input
              id="mongo-authdb"
              value={database}
              onChange={e => setDatabase(e.target.value)}
              disabled={editing}
              placeholder="admin"
            />
          </div>
        </div>

        <div className="border-t border-border pt-4 flex flex-col gap-4">
          <div>
            <div className="text-sm font-medium">Roles</div>
            <div className="text-xs text-muted-foreground">
              Assign built-in roles per database. Changes take effect on save.
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {cards.map((c, i) => {
              const toggle = (role: string, on: boolean) => {
                const s = new Set(c.roles);
                if (on) s.add(role);
                else s.delete(role);
                updateCard(i, { ...c, roles: [...s] });
              };
              return (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="rounded-md border border-border p-3 flex flex-col gap-3">
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Roles</label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                        {MONGO_ROLES.map(r => (
                          <Label key={r} className="cursor-pointer text-sm flex items-center gap-2">
                            <Checkbox checked={c.roles.includes(r)} onCheckedChange={v => toggle(r, v === true)} />
                            {r}
                          </Label>
                        ))}
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Database</label>
                      <Input
                        className="w-full"
                        value={c.db}
                        onChange={e => updateCard(i, { ...c, db: e.target.value })}
                        placeholder="database (e.g. admin, sales)"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => removeCard(i)}
                      disabled={cards.length <= 1}
                      title={cards.length <= 1 ? 'Keep at least one role group' : 'Delete this role group'}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <Button size="sm" variant="outline" onClick={addCard}>
              <Plus className="w-3.5 h-3.5" /> Add role group
            </Button>
          </div>
        </div>
      </div>

      <DialogFooter className="shrink-0 mt-0 pt-3 border-t border-border">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          <ChevronLeft className="w-3.5 h-3.5" /> Back
        </Button>
        <Button onClick={handleSaveClick} disabled={saving}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {editing ? 'Save changes' : 'Create user'}
        </Button>
      </DialogFooter>
    </div>
  );
}
