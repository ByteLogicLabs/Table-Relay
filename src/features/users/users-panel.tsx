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
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { DestructiveConfirmDialog } from '../../components/destructive-confirm-dialog';
import {
  db,
  isDbError,
  type UserInfo,
  type UserRef,
  type GrantInfo,
  type ManageUsersCapability,
} from '../../lib/db';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  /** Driver — used only to shape labels (MySQL has a host part; others don't). */
  driver: string;
}

/** MySQL accounts are `'name'@'host'`; other engines have no host component. */
function hasHostConcept(driver: string): boolean {
  return driver === 'mysql' || driver === 'mariadb';
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
      const ref: UserRef = { name: u.name, host: u.host ?? null };
      setGrantsFor(ref);
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
    [connectionId],
  );

  const confirmDrop = useCallback(async () => {
    if (!dropTarget) return;
    const ref: UserRef = { name: dropTarget.name, host: dropTarget.host ?? null };
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
        className="sm:max-w-4xl max-h-[80vh] flex flex-col"
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
        toast.success('User updated');
      } else {
        await db.createUser(connectionId, {
          name: name.trim(),
          host: withHost ? host.trim() || '%' : null,
          password: password.trim() ? password : null,
          isSuperuser,
          canLogin,
        });
        toast.success('User created');
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
  ]);

  const handleSaveClick = useCallback(() => void save(), [save]);

  return (
    <div className="flex flex-col gap-3 flex-1 overflow-auto">
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
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="user-password">
          {editing ? 'New password (leave blank to keep)' : 'Password'}
        </Label>
        <Input
          id="user-password"
          type="password"
          value={password}
          onChange={handlePassword}
          placeholder={editing ? '••••••••' : 'password'}
          autoComplete="new-password"
        />
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <Label className="cursor-pointer">
          <Checkbox checked={canLogin} onCheckedChange={handleLogin} />
          Can log in
        </Label>
        <Label className="cursor-pointer">
          <Checkbox checked={isSuperuser} onCheckedChange={handleSuper} />
          Superuser (full privileges)
        </Label>
        {editing && withHost && (
          <Label className="cursor-pointer">
            <Checkbox checked={isLocked} onCheckedChange={handleLocked} />
            Account locked
          </Label>
        )}
      </div>

      <DialogFooter className="mt-auto pt-2">
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
