import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ConnectionProfile, Driver, SshAuthKind } from '../../types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { toast } from 'sonner';
import { db, type AdapterManifest, type ConnectionField } from '../../lib/db';
import DbIcon from '../../components/db-icon';
import { Loader2 } from 'lucide-react';

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
}

export default function ConnectionModal({ isOpen, onClose, onSave, initialData }: ConnectionModalProps) {
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
  const [isSaving, setIsSaving] = useState(false);
  const [testReport, setTestReport] = useState<TestReport | null>(null);
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

  useEffect(() => {
    if (isOpen) {
      // Clear any stale busy flag from a previous save so the button is
      // live again when the modal is reopened (it isn't unmounted).
      setIsSaving(false);
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
    // Any edit invalidates the last test result — stop showing stale ticks.
    setTestReport(null);
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
    setTestReport(null);
    try {
      const report = await invoke<TestReport>('db_test_connection', {
        profile: buildProfileInput(),
      });
      setTestReport(report);
      if (report.ok && report.server) {
        // Prefer the flavor ("MySQL"/"MariaDB"/…) over the adapter id
        // ("mysql") for the human-facing toast.
        const label = report.server.flavor ?? report.server.adapterId;
        toast.success(`Connected to ${label} ${report.server.version}`);
      } else {
        const failed = report.steps.find(s => s.status === 'failed');
        toast.error(`Failed at: ${failed?.name ?? 'connection test'}`);
      }
    } catch (e: unknown) {
      const err = e as { message?: string; kind?: string } | string;
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
      toast.error(`Connection failed: ${msg}`);
    } finally {
      setIsTesting(false);
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
      }, initialData?.id);
    } catch {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialData ? 'Edit Connection' : 'New Connection'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-6 py-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Adapter</label>
            <Select value={formData.driver} onValueChange={(v) => handleChange('driver', v)}>
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
              onChange={(e) => handleChange('name', e.target.value)}
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
                    onChange={(e) => handleChange('host', e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Port *</label>
                  <Input
                    className="w-full"
                    placeholder="Port"
                    value={formData.port || ''}
                    onChange={(e) => handleChange('port', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">User *</label>
                  <Input
                    className="w-full"
                    value={formData.user || ''}
                    onChange={(e) => handleChange('user', e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Password</label>
                  <Input
                    type="password"
                    className="w-full"
                    placeholder="••••••••"
                    value={formData.password || ''}
                    onChange={(e) => handleChange('password', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Database</label>
                <Input
                  className="w-full"
                  placeholder="Optional default database"
                  value={formData.database || ''}
                  onChange={(e) => handleChange('database', e.target.value)}
                />
              </div>
            </>
          )}

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
                onClick={() => handleChange('sshEnabled', !formData.sshEnabled)}
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
                      onChange={(e) => handleChange('sshHost', e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">SSH Port</label>
                    <Input
                      className="w-full"
                      placeholder="22"
                      value={formData.sshPort ?? ''}
                      onChange={(e) => handleChange('sshPort', e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">SSH User *</label>
                  <Input
                    className="w-full"
                    placeholder="ubuntu"
                    value={formData.sshUser || ''}
                    onChange={(e) => handleChange('sshUser', e.target.value)}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Auth Method</label>
                  <Select
                    value={formData.sshAuthKind ?? 'key'}
                    onValueChange={(v) => handleChange('sshAuthKind', v as SshAuthKind)}
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
                      onChange={(e) => handleChange('sshPassword', e.target.value)}
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
                        onChange={(e) => handleChange('sshKeyPath', e.target.value)}
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
                        onChange={(e) => handleChange('sshKeyPassphrase', e.target.value)}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          )}
        </div>

        {testReport && (
          <div className="mt-2 rounded-md border border-border p-3 space-y-2">
            <div className="text-sm font-medium">Connection test</div>
            {testReport.steps.map((s, i) => {
              const icon =
                s.status === 'ok' ? '✓' : s.status === 'failed' ? '✗' : '—';
              const color =
                s.status === 'ok'
                  ? 'text-green-600 dark:text-green-400'
                  : s.status === 'failed'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-muted-foreground';
              return (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className={`${color} font-mono w-4 shrink-0`}>{icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={color}>{s.name}</span>
                      {s.status !== 'skipped' && (
                        <span className="text-xs text-muted-foreground">
                          {s.durationMs.toFixed(0)}ms
                        </span>
                      )}
                    </div>
                    {s.message && (
                      <div className="text-xs text-muted-foreground wrap-break-word whitespace-pre-wrap">
                        {s.message}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="flex justify-between sm:justify-between mt-4">
          <Button variant="outline" onClick={handleTest} disabled={isTesting}>
            {isTesting ? 'Testing...' : 'Test Connection'}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                  Connecting…
                </>
              ) : (
                'Save & Connect'
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
              onChange={(v) => setFieldValue(f, v)}
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
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const help = field.help ? (
    <div className="text-xs text-muted-foreground">{field.help}</div>
  ) : null;
  const container = (input: React.ReactNode) => (
    <div className="grid gap-2">
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
          onChange={(e) => onChange(e.target.value)}
        />,
      );
    case 'int':
      return container(
        <Input
          type="number"
          className="w-full"
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
          onClick={() => onChange(value === 'true' ? 'false' : 'true')}
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
            onChange={(e) => onChange(e.target.value)}
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
          onChange={(e) => onChange(e.target.value)}
        />,
      );
  }
}
