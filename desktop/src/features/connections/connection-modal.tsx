import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ConnectionProfile, Driver, SshAuthKind, type ConnectionTag } from '../../types';
import { TAG_COLORS, getTagColor } from '../../lib/tag-colors';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { toast } from 'sonner';
import { db, type AdapterManifest, type ConnectionField } from '../../lib/db';
import DbIcon from '../../components/db-icon';
import { Loader2, X, Plus } from 'lucide-react';

/** Human driver label → adapter key. Used to pair legacy store rows with
 *  the new adapter manifests until the store is updated to carry
 *  `adapterId` directly. */
const DRIVER_TO_ADAPTER_KEY: Record<string, string> = {
  MySQL: 'mysql',
  SQLite: 'sqlite',
  Redis: 'redis',
  PostgreSQL: 'postgres',
  MongoDB: 'mongo',
};

/** Reverse lookup so we can translate an adapter key back to the driver
 *  string the store expects on save. */
function adapterKeyToDriver(key: string): Driver {
  const entry = Object.entries(DRIVER_TO_ADAPTER_KEY).find(([, v]) => v === key);
  return (entry?.[0] as Driver) ?? 'MySQL';
}

/** URI scheme → driver. */
const SCHEME_TO_DRIVER: Record<string, Driver> = {
  mysql: 'MySQL',
  mariadb: 'MySQL',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  mongodb: 'MongoDB',
  'mongodb+srv': 'MongoDB',
  redis: 'Redis',
  rediss: 'Redis',
  sqlite: 'SQLite',
};

const DEFAULT_PORT: Record<Driver, string> = {
  MySQL: '3306', PostgreSQL: '5432', MongoDB: '27017', Redis: '6379', SQLite: '',
};

export interface ParsedConnString {
  driver: Driver;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  /** Whole original URI — Mongo keeps this in `host` so params like
   *  `?authSource=` reach the driver unchanged. */
  rawUri?: string;
  isSrv?: boolean;
}

/**
 * Parse a database connection string into form fields. Returns `null` if the
 * input isn't a recognized URI. Handles user:pass@host:port/db?params for
 * mysql/postgres/mongodb/redis, mongodb+srv (no port), and sqlite file paths.
 */
export function parseConnectionString(input: string): ParsedConnString | null {
  const raw = input.trim();
  if (!raw) return null;

  const schemeMatch = raw.match(/^([a-z][a-z0-9+]*):\/\//i);
  if (!schemeMatch) return null;
  const scheme = schemeMatch[1].toLowerCase();
  const driver = SCHEME_TO_DRIVER[scheme];
  if (!driver) return null;

  if (driver === 'SQLite') {
    // sqlite:///abs/path -> /abs/path ; sqlite://relative.db -> relative.db
    const path = raw.replace(/^sqlite:\/\//i, '');
    return { driver, database: path || undefined, host: '' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const user = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const host = url.hostname || undefined;
  const port = url.port || DEFAULT_PORT[driver] || undefined;
  const path = url.pathname.replace(/^\//, '');
  const database = path ? decodeURIComponent(path) : undefined;
  const isSrv = scheme === 'mongodb+srv';

  return { driver, host, port, user, password, database, rawUri: raw, isSrv };
}

interface TestStep {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  durationMs: number;
  message?: string;
}

interface TestReport {
  steps: TestStep[];
  /** Matches `adapter_api::ServerInfo`. */
  server?: { adapterId: string; version: string; flavor?: string | null };
  ok: boolean;
}

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (conn: ConnectionProfile, previousId?: string) => void | Promise<void>;
  initialData?: ConnectionProfile;
  /** Tags already used by other connections (name + their existing color),
   *  for the autocomplete dropdown so picking one reuses its color. */
  existingTags?: ConnectionTag[];
}

export default function ConnectionModal({ isOpen, onClose, onSave, initialData, existingTags = [] }: ConnectionModalProps) {
  const [formData, setFormData] = useState<Partial<ConnectionProfile>>({
    driver: 'MySQL',
    host: 'localhost',
    port: '3306',
    user: 'root',
    sslMode: 'Disable',
    sshEnabled: false,
    sshPort: '22',
    sshAuthKind: 'key',
  });
  const [isTesting, setIsTesting] = useState(false);
  // Monotonic id for the in-flight test. Cancel/re-test bumps it so a stale
  // db_test_connection result (the backend call can't be aborted, only ignored)
  // is discarded instead of overwriting the toast the user already dismissed.
  const testRunId = useRef(0);
  const [isSaving, setIsSaving] = useState(false);
  /** Every registered adapter manifest. Loaded once per modal open. */
  const [manifests, setManifests] = useState<AdapterManifest[] | null>(null);

  // Load the adapter manifests lazily — no need to hit the backend if the
  // modal never opens. The response is small and stable across the
  // session, so a single fetch is plenty.
  useEffect(() => {
    if (!isOpen || manifests) return;
    let cancelled = false;
    db.listAdapters()
      .then(list => {
        if (!cancelled) setManifests(list);
      })
      .catch(() => {
        // Factory registry down is a hard error; render the modal empty.
        if (!cancelled) setManifests([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, manifests]);

  /** The manifest matching the current `driver` selection, if any. Drives
   *  the rendered form fields + the capability gates (today: SSH). */
  const activeManifest = useMemo<AdapterManifest | null>(() => {
    if (!manifests || manifests.length === 0) return null;
    const key = DRIVER_TO_ADAPTER_KEY[formData.driver ?? ''] ?? '';
    return manifests.find(m => m.adapter.key === key) ?? null;
  }, [manifests, formData.driver]);

  // --- manifest field helpers ---

  /** Manifest keys are snake_case (matches `adapter.toml`); the form
   *  state uses camelCase to match `ConnectionProfile`. Translate here so
   *  adapters don't have to know about frontend conventions. */
  const toFormKey = (manifestKey: string): keyof ConnectionProfile => {
    return manifestKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof ConnectionProfile;
  };

  /** Field-level value from `formData`, falling back to the manifest's
   *  declared default on first render. Returns a string because
   *  `<Input>` / `<Select>` always speak strings. */
  const fieldValue = (field: ConnectionField): string => {
    const formKey = toFormKey(field.key);
    const raw = (formData as Record<string, unknown>)[formKey as string];
    if (raw === undefined || raw === null) return field.default ?? '';
    return String(raw);
  };

  const setFieldValue = (field: ConnectionField, value: string | boolean) => {
    handleChange(toFormKey(field.key), value);
  };

  const [connString, setConnString] = useState('');

  /** Auto-fill the form from the connection string as the user types/pastes.
   *  Silent (no toasts) since it runs on every change; only applies when the
   *  string parses cleanly. For Mongo we keep the full URI in `host` so params
   *  (authSource, replicaSet, tls, …) reach the driver unchanged. */
  const onConnStringChange = (value: string) => {
    setConnString(value);
    const parsed = parseConnectionString(value);
    if (!parsed) return;
    setFormData(prev => {
      const next: Partial<ConnectionProfile> = { ...prev, driver: parsed.driver };
      if (parsed.driver === 'MongoDB' && parsed.rawUri) {
        // Mongo (incl. mongodb+srv, which has no port): keep the whole URI in
        // host so scheme + every query param reaches the driver unchanged.
        next.host = parsed.rawUri;
        next.database = parsed.database ?? '';
      } else if (parsed.driver === 'SQLite') {
        // SQLite has only a file path (the `database` field). No host/port/auth.
        next.host = '';
        next.database = parsed.database ?? '';
      } else {
        // SQL + Redis: fill discrete fields. Use empty strings (not undefined)
        // so values from a previously pasted/typed URI don't linger.
        next.host = parsed.host ?? '';
        next.port = parsed.port ?? prev.port;
        next.user = parsed.user ?? '';
        next.password = parsed.password ?? '';
        next.database = parsed.database ?? '';
      }
      return next;
    });
  };

  useEffect(() => {
    if (isOpen) {
      // Clear any stale busy flag from a previous save so the button is
      // live again when the modal is reopened (it isn't unmounted).
      setIsSaving(false);
      setConnString('');
      if (initialData) {
        setFormData(initialData);
      } else {
        setFormData({
          driver: 'PostgreSQL',
          host: 'localhost',
          port: '5432',
          user: 'postgres',
          sslMode: 'Disable',
          sshEnabled: false,
          sshPort: '22',
          sshAuthKind: 'key',
        });
      }
    }
  }, [isOpen, initialData]);

  const handleChange = (field: keyof ConnectionProfile, value: string | boolean) => {
    setFormData(prev => {
      const newData = { ...prev, [field]: value } as Partial<ConnectionProfile>;
      if (field === 'driver' && typeof value === 'string' && manifests) {
        // Switch defaults off the new driver's manifest so every adapter
        // (Redis:6379, MySQL:3306, Postgres:5432, Mongo:27017, …) gets its
        // own port/user without a hardcoded chain here.
        const nextKey = DRIVER_TO_ADAPTER_KEY[value] ?? '';
        const nextManifest = manifests.find(m => m.adapter.key === nextKey);
        if (nextManifest) {
          const priorKeys = Object.values(DRIVER_TO_ADAPTER_KEY).filter(k => k !== nextKey);
          const priorDefaults = manifests
            .filter(m => priorKeys.includes(m.adapter.key))
            .flatMap(m => m.connectionFields);
          for (const field of nextManifest.connectionFields) {
            if (field.key !== 'port' && field.key !== 'user') continue;
            const formKey = field.key === 'port' ? 'port' : 'user';
            const current = prev[formKey];
            const looksDefaulted =
              current === '' ||
              current == null ||
              priorDefaults.some(pf => pf.key === field.key && pf.default === current);
            if (looksDefaulted && field.default) {
              (newData as Record<string, unknown>)[formKey] = field.default;
            }
          }
        }
      }
      return newData;
    });
  };

  // Pack the current form into the ConnectionProfileInput shape the Rust
  // commands expect. Shared by Save and Test so both paths apply the same
  // defaulting/coercion.
  const buildProfileInput = () => {
    const driver = formData.driver as Driver;
    const fallbackPort = driver === 'PostgreSQL' ? '5432' : driver === 'MongoDB' ? '27017' : '3306';
    return {
      id: String(formData.id || initialData?.id || '').trim() || undefined,
      name: formData.name || 'untitled',
      driver,
      host: formData.host || 'localhost',
      port: Number(formData.port || fallbackPort),
      user: formData.user,
      password: formData.password,
      database: formData.database,
      sslMode: formData.sslMode,
      sshEnabled: !!formData.sshEnabled,
      sshHost: formData.sshHost || undefined,
      sshPort: formData.sshPort ? Number(formData.sshPort) : undefined,
      sshUser: formData.sshUser || undefined,
      sshAuthKind: formData.sshAuthKind,
      sshKeyPath: formData.sshKeyPath || undefined,
      sshPassword: formData.sshPassword || undefined,
      sshKeyPassphrase: formData.sshKeyPassphrase || undefined,
      color: formData.color,
      isFavorite: !!formData.isFavorite,
      tag: formData.tag || undefined,
      tagColor: formData.tagColor || undefined,
    };
  };

  const handleTest = async () => {
    // Validate against the manifest's required fields instead of a hardcoded
    // host/user check — SQLite has neither, and future adapters may not either.
    if (activeManifest) {
      const missing = activeManifest.connectionFields
        .filter(f => f.required)
        .find(f => !fieldValue(f).trim());
      if (missing) {
        toast.error(`${missing.label} is required to test`);
        return;
      }
    } else if (!formData.host || !formData.user) {
      toast.error('Host and user are required to test');
      return;
    }
    setIsTesting(true);
    const runId = ++testRunId.current;
    // One toast for the whole run: loading -> success/error, updated by id so
    // it shows progress without the user scrolling the form. The cancel action
    // bumps testRunId so the eventual result is ignored (the backend call keeps
    // running until it times out, but the user gets the UI back immediately).
    const toastId = toast.loading('Testing connection…', {
      description: 'Running connection checks…',
      cancel: {
        label: 'Cancel',
        onClick: () => {
          testRunId.current++;
          toast.dismiss(toastId);
          setIsTesting(false);
        },
      },
    });
    try {
      const report = await invoke<TestReport>('db_test_connection', {
        profile: buildProfileInput(),
      });
      // User cancelled (or started another test) while this was in flight —
      // drop the result silently rather than clobber the current toast/state.
      if (testRunId.current !== runId) return;
      // Per-step lines (✓ ok / ✗ failed / — skipped) with timing + message —
      // the same detail the old inline panel showed, now in the toast. Rendered
      // as JSX so line breaks + colors survive (plain "\n" strings collapse).
      const details = (
        <div className="mt-1 space-y-1 text-xs">
          {report.steps.map((s, i) => {
            const color =
              s.status === 'ok'
                ? 'text-green-600 dark:text-green-400'
                : s.status === 'failed'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-muted-foreground';
            const icon = s.status === 'ok' ? '✓' : s.status === 'failed' ? '✗' : '—';
            return (
              <div key={i}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className={color}>{icon} {s.name}</span>
                  {s.status !== 'skipped' && (
                    <span className="text-muted-foreground tabular-nums">{s.durationMs.toFixed(0)}ms</span>
                  )}
                </div>
                {s.message && (
                  <div className="text-muted-foreground wrap-break-word whitespace-pre-wrap pl-3">{s.message}</div>
                )}
              </div>
            );
          })}
        </div>
      );

      if (report.ok && report.server) {
        // Prefer the flavor ("MySQL"/"MariaDB"/…) over the adapter id.
        const label = report.server.flavor ?? report.server.adapterId;
        toast.success(`Connected to ${label} ${report.server.version}`, {
          id: toastId,
          description: details,
          duration: 6000,
        });
      } else {
        toast.error('Connection test failed', {
          id: toastId,
          description: details,
          duration: 10000,
        });
      }
    } catch (e: unknown) {
      if (testRunId.current !== runId) return;
      const err = e as { message?: string; kind?: string } | string;
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
      toast.error('Connection failed', { id: toastId, description: msg, duration: 10000 });
    } finally {
      // Only the still-current run owns the button state; a cancelled run
      // already reset it in the cancel handler.
      if (testRunId.current === runId) setIsTesting(false);
    }
  };

  const handleSave = async () => {
    if (!formData.name) {
      toast.error('Name is required');
      return;
    }
    if (activeManifest) {
      const missing = activeManifest.connectionFields
        .filter(f => f.required)
        .find(f => !fieldValue(f).trim());
      if (missing) {
        toast.error(`${missing.label} is required`);
        return;
      }
    } else if (!formData.host || !formData.user) {
      toast.error('Please fill in all required fields');
      return;
    }
    if (formData.sshEnabled && (!formData.sshHost || !formData.sshUser)) {
      toast.error('SSH host and user are required when SSH is enabled');
      return;
    }

    setIsSaving(true);
    try {
      await onSave({
        id: String(formData.id || '').trim() || initialData?.id || Date.now().toString(),
        name: formData.name,
        driver: formData.driver as Driver,
        host: formData.host,
        port: formData.port || (formData.driver === 'PostgreSQL' ? '5432' : formData.driver === 'MongoDB' ? '27017' : '3306'),
        user: formData.user,
        password: formData.password,
        database: formData.database,
        sslMode: formData.sslMode as ConnectionProfile['sslMode'],
        sshEnabled: !!formData.sshEnabled,
        sshHost: formData.sshHost,
        sshPort: formData.sshPort,
        sshUser: formData.sshUser,
        sshAuthKind: formData.sshAuthKind,
        sshKeyPath: formData.sshKeyPath,
        sshPassword: formData.sshPassword,
        sshKeyPassphrase: formData.sshKeyPassphrase,
        color: formData.color,
        isFavorite: formData.isFavorite,
        tags: formData.tags,
        // Mirror the first tag into the legacy fields for back-compat.
        tag: formData.tags?.[0]?.name ?? formData.tag,
        tagColor: formData.tags?.[0]?.color ?? formData.tagColor,
      }, initialData?.id);
    } catch {
      setIsSaving(false);
    }
  };

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) onClose();
  }, [onClose]);

  const handleConnStringChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onConnStringChange(e.target.value);
  }, []);

  const handleDriverChange = useCallback((v: string) => {
    handleChange('driver', v);
  }, [handleChange]);

  // Factory: build a stable input-change handler for a given form field.
  const makeFieldChange = useCallback((field: keyof ConnectionProfile) =>
    (e: React.ChangeEvent<HTMLInputElement>) => handleChange(field, e.target.value), []);

  const handleTagsChange = useCallback((tags: ConnectionTag[]) => {
    setFormData(prev => ({ ...prev, tags }));
  }, []);

  const handleSshToggle = useCallback(() => {
    handleChange('sshEnabled', !formData.sshEnabled);
  }, [formData.sshEnabled]);

  const handleSshAuthKindChange = useCallback((v: string) => {
    handleChange('sshAuthKind', v as SshAuthKind);
  }, []);

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-3xl w-[95vw] max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-3 border-b border-border">
          <DialogTitle>{initialData ? 'Edit Connection' : 'New Connection'}</DialogTitle>
        </DialogHeader>

        {/* Scrollable form body — header + footer stay pinned. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6">
        <div className="grid gap-6 py-4">
          {/* Paste a connection string to auto-fill the fields below. */}
          <div className="grid gap-2">
            <label className="text-sm font-medium">Connection string</label>
            <Input
              value={connString}
              onChange={handleConnStringChange}
              placeholder="mysql://user:pass@host:3306/db  ·  mongodb://…?authSource=admin"
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Optional. Paste a URI and the fields below fill in automatically, or enter details manually.
            </p>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">Adapter</label>
            <Select value={formData.driver} onValueChange={handleDriverChange}>
              <SelectTrigger className="w-full">
                <div className="flex items-center gap-2 min-w-0">
                  {formData.driver && <DbIcon driver={formData.driver} className="w-4 h-4 shrink-0" />}
                  <SelectValue placeholder="Select adapter" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {/* Registered adapters first — these actually work. */}
                {manifests?.map(m => (
                  <SelectItem key={m.adapter.key} value={adapterKeyToDriver(m.adapter.key)}>
                    <span className="flex items-center gap-2">
                      <DbIcon driver={adapterKeyToDriver(m.adapter.key)} className="w-4 h-4 shrink-0" />
                      <span>{m.adapter.displayName}</span>
                    </span>
                  </SelectItem>
                ))}
                {/* Legacy placeholders for drivers with no registered
                    adapter yet. Selecting these will produce a visible
                    "not available" notice rather than a silent failure. */}
                {!manifests?.some(m => m.adapter.key === 'postgres') && (
                  <SelectItem value="PostgreSQL">
                    <span className="flex items-center gap-2">
                      <DbIcon driver="PostgreSQL" className="w-4 h-4 shrink-0" />
                      <span>PostgreSQL (not installed)</span>
                    </span>
                  </SelectItem>
                )}
                {!manifests?.some(m => m.adapter.key === 'mongo') && (
                  <SelectItem value="MongoDB">
                    <span className="flex items-center gap-2">
                      <DbIcon driver="MongoDB" className="w-4 h-4 shrink-0" />
                      <span>MongoDB (not installed)</span>
                    </span>
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {manifests && activeManifest === null && (
              <div className="text-xs text-muted-foreground">
                No adapter registered for this driver yet. The core fields
                below are best-effort; saving will likely fail at connect
                time.
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">Name *</label>
            <Input
              className="w-full"
              placeholder="e.g. Production DB"
              value={formData.name || ''}
              onChange={makeFieldChange('name')}
              autoFocus
            />
          </div>

          {/* Connection fields rendered from the adapter manifest. The
              adapter declares which fields exist, their labels, kinds
              (string / secret / int / enum), and defaults. */}
          {activeManifest ? (
            <ManifestFields
              fields={activeManifest.connectionFields}
              fieldValue={fieldValue}
              setFieldValue={setFieldValue}
            />
          ) : (
            // Fallback: render the old hard-coded fields so selecting an
            // un-installed adapter still lets the user edit a profile.
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Host *</label>
                  <Input
                    className="w-full"
                    placeholder="localhost"
                    value={formData.host || ''}
                    onChange={makeFieldChange('host')}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Port *</label>
                  <Input
                    className="w-full"
                    placeholder="Port"
                    value={formData.port || ''}
                    onChange={makeFieldChange('port')}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">User *</label>
                  <Input
                    className="w-full"
                    value={formData.user || ''}
                    onChange={makeFieldChange('user')}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Password</label>
                  <Input
                    type="password"
                    className="w-full"
                    placeholder="••••••••"
                    value={formData.password || ''}
                    onChange={makeFieldChange('password')}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Database</label>
                <Input
                  className="w-full"
                  placeholder="Optional default database"
                  value={formData.database || ''}
                  onChange={makeFieldChange('database')}
                />
              </div>
            </>
          )}

          <div className="grid gap-2">
            <label className="text-sm font-medium">Tags</label>
            <TagsEditor
              tags={formData.tags ?? []}
              existingTags={existingTags}
              onChange={handleTagsChange}
            />
          </div>

          {/* SSH block — hidden when the adapter's manifest says it has
              no SSH tunnel capability. If there's no active manifest
              (unknown adapter) we show the block so legacy profiles keep
              editing correctly. */}
          {(activeManifest?.capabilities.sshTunnel ?? true) && (
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Connect over SSH tunnel</div>
                <div className="text-xs text-muted-foreground">
                  Forward the database port through a jump host.
                </div>
              </div>
              <Button
                type="button"
                variant={formData.sshEnabled ? 'default' : 'outline'}
                size="sm"
                onClick={handleSshToggle}
              >
                {formData.sshEnabled ? 'Enabled' : 'Disabled'}
              </Button>
            </div>

            {formData.sshEnabled && (
              <div className="grid gap-4 mt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">SSH Server *</label>
                    <Input
                      className="w-full"
                      placeholder="bastion.example.com"
                      value={formData.sshHost || ''}
                      onChange={makeFieldChange('sshHost')}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">SSH Port</label>
                    <Input
                      className="w-full"
                      placeholder="22"
                      value={formData.sshPort ?? ''}
                      onChange={makeFieldChange('sshPort')}
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">SSH User *</label>
                  <Input
                    className="w-full"
                    placeholder="ubuntu"
                    value={formData.sshUser || ''}
                    onChange={makeFieldChange('sshUser')}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Auth Method</label>
                  <Select
                    value={formData.sshAuthKind ?? 'key'}
                    onValueChange={handleSshAuthKindChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="key">Private Key</SelectItem>
                      <SelectItem value="password">Password</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.sshAuthKind === 'password' ? (
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">SSH Password</label>
                    <Input
                      type="password"
                      className="w-full"
                      placeholder="••••••••"
                      value={formData.sshPassword || ''}
                      onChange={makeFieldChange('sshPassword')}
                    />
                  </div>
                ) : (
                  <>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Private Key Path</label>
                      <Input
                        className="w-full"
                        placeholder="~/.ssh/id_rsa (leave blank for default)"
                        value={formData.sshKeyPath || ''}
                        onChange={makeFieldChange('sshKeyPath')}
                      />
                      <div className="text-xs text-muted-foreground">
                        If blank, falls back to ~/.ssh/id_rsa, ~/.ssh/id_ed25519, ~/.ssh/id_ecdsa (in that order).
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Key Passphrase</label>
                      <Input
                        type="password"
                        className="w-full"
                        placeholder="Only if the key is encrypted"
                        value={formData.sshKeyPassphrase || ''}
                        onChange={makeFieldChange('sshKeyPassphrase')}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          )}
        </div>
        </div>

        <DialogFooter className="shrink-0 flex justify-between sm:justify-between gap-2 px-6 pt-4 pb-6 border-t border-border bg-popover">
          <Button variant="outline" onClick={handleTest} disabled={isTesting}>
            {isTesting ? 'Testing...' : 'Test Connection'}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Render the adapter's declared connection fields in the order the
 * manifest lists them. Two-up layout: string/int/enum/bool pairs share a
 * row; `secret` always gets its own row so password managers don't try
 * to autofill neighbouring fields. `help` text goes below the input.
 */
function ManifestFields({
  fields,
  fieldValue,
  setFieldValue,
}: {
  fields: ConnectionField[];
  fieldValue: (field: ConnectionField) => string;
  setFieldValue: (field: ConnectionField, value: string | boolean) => void;
}) {
  // Group fields into pairs while keeping secrets alone.
  const groups: ConnectionField[][] = [];
  let pending: ConnectionField | null = null;
  for (const f of fields) {
    if (f.kind.type === 'secret') {
      if (pending) {
        groups.push([pending]);
        pending = null;
      }
      groups.push([f]);
      continue;
    }
    if (pending) {
      groups.push([pending, f]);
      pending = null;
    } else {
      pending = f;
    }
  }
  if (pending) groups.push([pending]);

  // Factory: stable per-field change handler closing over the field.
  const makeFieldControlChange = useCallback(
    (f: ConnectionField) => (v: string | boolean) => setFieldValue(f, v),
    [setFieldValue],
  );

  return (
    <>
      {groups.map((group, i) => (
        <div
          key={i}
          className={
            group.length === 2
              ? 'grid grid-cols-1 md:grid-cols-2 gap-6'
              : 'grid gap-2'
          }
        >
          {group.map(f => (
            <FieldControl
              key={f.key}
              field={f}
              value={fieldValue(f)}
              onChange={makeFieldControlChange(f)}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ConnectionField;
  value: string;
  onChange: (value: string) => void;
}) {
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  }, [onChange]);

  const handleBoolToggle = useCallback(() => {
    onChange(value === 'true' ? 'false' : 'true');
  }, [onChange, value]);

  const label = `${field.label}${field.required ? ' *' : ''}`;
  const help = field.help ? (
    <div className="text-xs text-muted-foreground">{field.help}</div>
  ) : null;
  // `self-start` + `content-start`: when this cell sits in a 2-col row next to a
  // field WITHOUT help text, the parent grid would stretch both cells to equal
  // height and the inner auto-rows would redistribute the slack — pushing this
  // cell's input/select out of line with its neighbour. Pinning to the top keeps
  // label + input aligned across the row regardless of help text.
  const container = (input: React.ReactNode) => (
    <div className="grid gap-2 content-start self-start">
      <label className="text-sm font-medium">{label}</label>
      {input}
      {help}
    </div>
  );

  switch (field.kind.type) {
    case 'secret':
      return container(
        <Input
          type="password"
          className="w-full"
          placeholder="••••••••"
          value={value}
          onChange={handleInputChange}
        />,
      );
    case 'int':
      return container(
        <Input
          type="number"
          className="w-full"
          value={value}
          onChange={handleInputChange}
          min={field.kind.min}
          max={field.kind.max}
        />,
      );
    case 'enum':
      return container(
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={field.label} />
          </SelectTrigger>
          <SelectContent>
            {field.kind.options.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>,
      );
    case 'bool':
      return container(
        <Button
          type="button"
          variant={value === 'true' ? 'default' : 'outline'}
          size="sm"
          onClick={handleBoolToggle}
        >
          {value === 'true' ? 'On' : 'Off'}
        </Button>,
      );
    case 'file': {
      const { extensions = [], allowCreate = false } = field.kind;
      const pick = async () => {
        try {
          const filters =
            extensions.length > 0
              ? [{ name: field.label, extensions: [...extensions] }]
              : undefined;
          // `save` lets the user target a new path; `open` only accepts
          // existing files. `allow_create` on the manifest picks between
          // them so adapters that need an existing DB don't get a
          // Save-As dialog by mistake.
          const picked = allowCreate
            ? await saveDialog({ title: field.label, filters, defaultPath: value || undefined })
            : await openDialog({ title: field.label, filters, multiple: false, directory: false });
          if (typeof picked === 'string' && picked) {
            onChange(picked);
          }
        } catch (e) {
          toast.error(`Could not open picker: ${String(e)}`);
        }
      };
      return container(
        <div className="flex gap-2">
          <Input
            className="w-full"
            placeholder="/path/to/file"
            value={value}
            onChange={handleInputChange}
          />
          <Button type="button" variant="outline" onClick={pick}>
            Browse…
          </Button>
        </div>,
      );
    }
    case 'string':
    default:
      return container(
        <Input
          className="w-full"
          value={value}
          onChange={handleInputChange}
        />,
      );
  }
}

/** A swatch trigger that opens a grid of all tag colors to pick from. Shared by
 *  the "next tag color" swatch and each chip's recolor dot. */
function ColorGridPopover({
  value,
  onPick,
  trigger,
}: {
  value: string;
  onPick: (color: string) => void;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Factory: stable per-color click handler closing over the color name.
  const makeColorPick = useCallback((name: string) => () => {
    onPick(name);
    setOpen(false);
  }, [onPick]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex items-center">{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-6 gap-1.5">
          {TAG_COLORS.map(c => (
            <button
              key={c.name}
              type="button"
              onClick={makeColorPick(c.name)}
              title={c.name}
              aria-label={c.name}
              className={`w-6 h-6 rounded-full transition-transform hover:scale-110 ${c.dot} ${
                value === c.name ? 'ring-2 ring-foreground ring-offset-2 ring-offset-popover' : 'ring-1 ring-black/10 dark:ring-white/15'
              }`}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Multi-tag editor: removable colored chips + a creatable picker to add tags.
 *  Suggests tags already used by other connections; a new name can be typed and
 *  added with the chosen color. */
function TagsEditor({
  tags,
  existingTags,
  onChange,
}: {
  tags: ConnectionTag[];
  existingTags: ConnectionTag[];
  onChange: (tags: ConnectionTag[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [color, setColor] = useState('Blue');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const colorFor = getTagColor;

  // Next palette color not already used by a tag — so multiple tags get
  // distinct colors automatically (cycles back once all are used).
  const nextAutoColor = (current: ConnectionTag[]): string => {
    const used = new Set(current.map(t => t.color));
    return (TAG_COLORS.find(c => !used.has(c.name)) ?? TAG_COLORS[current.length % TAG_COLORS.length]).name;
  };

  const addTag = (rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    if (tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      setDraft('');
      return;
    }
    // Reuse the color this tag already has elsewhere; only brand-new tags get
    // the next auto-assigned palette color.
    const existing = existingTags.find(t => t.name.toLowerCase() === name.toLowerCase());
    const next = [...tags, { name: existing?.name ?? name, color: existing?.color ?? color }];
    onChange(next);
    setDraft('');
    setHighlight(0);
    setColor(nextAutoColor(next)); // pre-pick a fresh color for the next tag
  };

  const removeTag = (name: string) => {
    onChange(tags.filter(t => t.name !== name));
  };

  const setTagColor = (name: string, newColor: string) => {
    onChange(tags.map(t => (t.name === name ? { ...t, color: newColor } : t)));
  };

  // Suggestions = existing tags not already added, narrowed by what's typed.
  const taken = new Set(tags.map(t => t.name.toLowerCase()));
  const q = draft.trim().toLowerCase();
  const suggestions = existingTags
    .filter(t => !taken.has(t.name.toLowerCase()))
    .filter(t => !q || t.name.toLowerCase().includes(q))
    .slice(0, 8);

  // Offer "Create <draft>" when typed text isn't an existing/added tag.
  const canCreate = q !== '' && !suggestions.some(s => s.name.toLowerCase() === q) && !taken.has(q);
  // Flat option list the dropdown + keyboard nav operate on.
  const options: { value: string; color: string; create?: boolean }[] = [
    ...(canCreate ? [{ value: draft.trim(), color, create: true }] : []),
    ...suggestions.map(s => ({ value: s.name, color: s.color })),
  ];

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Factory: per-tag recolor handler. Depends on setTagColor (recreated each
  // render over the current tags) so it never recolors a stale tag list.
  const makeTagColorPick = useCallback((name: string) => (col: string) => setTagColor(name, col), [setTagColor]);
  // Factory: per-tag remove handler.
  const makeTagRemove = useCallback((name: string) => () => removeTag(name), [removeTag]);
  // Factory: stable per-option highlight handler.
  const makeOptionMouseEnter = useCallback((i: number) => () => setHighlight(i), []);
  // Factory: per-option mousedown handler (preventDefault keeps focus).
  const makeOptionMouseDown = useCallback((optValue: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    addTag(optValue);
  }, [addTag]);

  const handleDraftChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
    setOpen(true);
    setHighlight(0);
  }, []);

  const handleInputFocus = useCallback(() => setOpen(true), []);

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (open && options.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setHighlight(h => {
        const n = options.length;
        return e.key === 'ArrowDown' ? (h + 1) % n : (h - 1 + n) % n;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && options[highlight]) addTag(options[highlight].value);
      else addTag(draft);
      return;
    }
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1].name);
    }
  };

  return (
    <div className="space-y-2 relative" ref={boxRef}>
      {/* Combined field: a color swatch, the existing chips, then the input —
          all inside one focus-within-highlighted box (real tag-input feel). */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 min-h-9 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 transition-colors">
        {/* Color for the NEXT tag added. */}
        <ColorGridPopover
          value={color}
          onPick={setColor}
          trigger={
            <span className="h-6 w-6 shrink-0 flex items-center justify-center rounded-full hover:bg-muted/60 transition-colors cursor-pointer" title="Color for the next tag">
              <span className={`w-3.5 h-3.5 rounded-full ring-1 ring-black/10 dark:ring-white/15 ${colorFor(color).dot}`} />
            </span>
          }
        />

        {tags.map(t => {
          const c = colorFor(t.color);
          return (
            <span
              key={t.name}
              className={`inline-flex items-center gap-1 text-[11px] font-medium pl-1 pr-1 py-0.5 rounded-full ${c.bg} ${c.text}`}
            >
              {/* Click the dot to recolor this tag. */}
              <ColorGridPopover
                value={t.color}
                onPick={makeTagColorPick(t.name)}
                trigger={
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 cursor-pointer ring-1 ring-black/15 dark:ring-white/20 ${colorFor(t.color).dot}`} title="Change color" />
                }
              />
              {t.name}
              <button
                type="button"
                onClick={makeTagRemove(t.name)}
                className="rounded-full hover:bg-black/10 dark:hover:bg-white/10 p-0.5 -my-0.5"
                title="Remove tag"
                aria-label={`Remove ${t.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          );
        })}

        <input
          value={draft}
          onChange={handleDraftChange}
          onFocus={handleInputFocus}
          onKeyDown={onInputKeyDown}
          placeholder={tags.length === 0 ? 'Add tags…' : 'Add another…'}
          className="flex-1 min-w-24 bg-transparent text-sm outline-none placeholder:text-muted-foreground py-0.5"
        />
      </div>

      {/* Autocomplete dropdown: existing matches + a "Create" row. */}
      {open && options.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
          {options.map((opt, i) => {
            const c = colorFor(opt.color);
            return (
              <button
                key={`${opt.create ? 'create' : 'tag'}:${opt.value}`}
                type="button"
                onMouseEnter={makeOptionMouseEnter(i)}
                onMouseDown={makeOptionMouseDown(opt.value)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left transition-colors ${i === highlight ? 'bg-muted' : 'hover:bg-muted/60'}`}
              >
                {opt.create ? (
                  <>
                    <Plus className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">Create</span>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full ${c.bg} ${c.text}`}>
                      <span className={`w-2 h-2 rounded-full ${c.dot}`} /> {opt.value}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
                    <span className="truncate">{opt.value}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
