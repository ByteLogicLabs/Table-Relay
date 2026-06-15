import { useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';
import { Checkbox } from '../../components/ui/checkbox';
import { ai, isAiError, type AutoApprovalFlags } from '../../lib/ai';
import { persistAutoApprovals } from '../../lib/ai-permissions';
import { useSettings } from '../../lib/settings-store';
import { toast } from 'sonner';

/** Permissions popover — lets the user preauthorize tools so the AI can
 *  call them without an Approve/Deny prompt every time. Flags live in the
 *  Rust `AutoApprovals` state (in-memory); they reset on restart unless
 *  "Remember AI permissions across restarts" is on (Settings → AI), in which
 *  case they're mirrored to the encrypted store and restored on boot. */
export function PermissionsButton() {
  const [flags, setFlags] = useState<AutoApprovalFlags | null>(null);
  const [open, setOpen] = useState(false);
  const persistOn = useSettings().persistAiApprovals;

  useEffect(() => {
    // Fetch once on mount. We re-fetch when the popover opens to pick up
    // out-of-band changes (e.g. another permissions UI, future settings).
    void ai.getAutoApprovals().then(setFlags).catch(() => setFlags({
      read_schema: true,
      read_structure: true,
      call_query: false,
      call_query_read: false,
      call_query_write: false,
      call_query_create: false,
      call_query_delete: false,
      cross_database: false,
      write_query_tab: false,
      publish_notify: false,
      subscribe_channel: false,
    }));
  }, []);

  useEffect(() => {
    if (!open) return;
    void ai.getAutoApprovals().then(setFlags).catch(() => {});
  }, [open]);

  const toggle = async (key: keyof AutoApprovalFlags) => {
    if (!flags) return;
    const next = { ...flags, [key]: !flags[key] };
    setFlags(next);
    try {
      await ai.setAutoApprovals(next);
      // Mirror to disk when the user opted into persistence (no-op otherwise).
      void persistAutoApprovals(next);
    } catch (err) {
      toast.error(isAiError(err) ? err.message : String(err));
      setFlags(flags);
    }
  };

  const grantedCount = flags
    ? PERMISSIONS.reduce((n, p) => n + (flags[p.key] ? 1 : 0), 0)
    : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="AI permissions — auto-approve tool calls">
        <PopoverTrigger
          render={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon"
              className="h-6 w-6 relative"
              aria-label="AI permissions"
            >
              <Shield className="w-3 h-3" />
              {grantedCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[8px] leading-[14px] text-center font-medium">
                  {grantedCount}
                </span>
              )}
            </Button>
          )}
        />
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3 max-h-[70vh] overflow-auto">
        <div className="text-xs font-medium mb-1">AI permissions</div>
        <div className="text-[10.5px] text-muted-foreground mb-3">
          Checked tools run without prompting.{' '}
          {persistOn
            ? 'Remembered across restarts (change in Settings → AI).'
            : 'Resets when the app restarts.'}
        </div>
        {PERMISSION_GROUPS.map(group => (
          <div key={group.label} className="mb-3 last:mb-0">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
              {group.label}
            </div>
            <div className="flex flex-col gap-2">
              {group.permissions.map(p => (
                <label
                  key={p.key}
                  className="flex items-start gap-2 text-xs cursor-pointer"
                >
                  <Checkbox
                    checked={flags?.[p.key] ?? false}
                    onCheckedChange={() => void toggle(p.key)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{p.label}</div>
                    <div className="text-[10.5px] text-muted-foreground leading-snug">
                      {p.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface Permission {
  key: keyof AutoApprovalFlags;
  label: string;
  description: string;
}

const PERMISSION_GROUPS: Array<{ label: string; permissions: Permission[] }> = [
  {
    label: 'Read',
    permissions: [
      {
        key: 'read_schema',
        label: 'List schemas / tables',
        description: 'Let the AI list every schema and the tables inside each. Shape only — no rows.',
      },
      {
        key: 'read_structure',
        label: 'Describe table',
        description: 'Let the AI fetch column definitions, indexes, and foreign keys for a specific table.',
      },
    ],
  },
  {
    label: 'Scope',
    permissions: [
      {
        key: 'cross_database',
        label: 'Cross-database access',
        description: 'Off by default — the AI is locked to your active database. It only sees that one database and cannot list, describe, or query others. Turn on to let it reach every database on the connection.',
      },
    ],
  },
  {
    label: 'Run queries',
    permissions: [
      {
        key: 'call_query_read',
        label: 'Read (SELECT)',
        description: 'Run read-only queries — SELECT, SHOW, EXPLAIN. Returns up to 25 rows to the model.',
      },
      {
        key: 'call_query_write',
        label: 'Write (INSERT / UPDATE)',
        description: 'Insert rows and update existing rows (UPDATE must have a WHERE clause).',
      },
      {
        key: 'call_query_create',
        label: 'Create (CREATE / ALTER)',
        description: 'Create or alter tables, indexes, views, columns. Schema-changing DDL.',
      },
      {
        key: 'call_query_delete',
        label: 'Delete (DELETE)',
        description: 'Delete rows (DELETE must have a WHERE clause). DROP / TRUNCATE / no-WHERE deletes always prompt and can never be auto-approved.',
      },
    ],
  },
  {
    label: 'Editor',
    permissions: [
      {
        key: 'write_query_tab',
        label: 'Open / replace query tabs',
        description: 'Let the AI scaffold, refactor, or rewrite queries directly in the editor.',
      },
    ],
  },
  {
    label: 'Realtime',
    permissions: [
      {
        key: 'publish_notify',
        label: 'Publish messages',
        description: 'Let the AI send NOTIFY (Postgres) or PUBLISH (Redis) on your behalf.',
      },
      {
        key: 'subscribe_channel',
        label: 'Start subscriptions',
        description: 'Let the AI prefill and start LISTEN / SUBSCRIBE on the realtime tab.',
      },
    ],
  },
];

const PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap(g => g.permissions);
