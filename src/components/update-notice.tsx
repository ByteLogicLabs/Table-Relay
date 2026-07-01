import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, X, Loader2 } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from 'sonner';
import { Button } from './ui/button';
import {
  checkForUpdate,
  canAutoInstall,
  downloadAndInstallUpdate,
  relaunchApp,
} from '../lib/update';

const POLL_MS = 30 * 60 * 1000;

type Phase = 'idle' | 'installing' | 'done';

export function UpdateNotice() {
  const [info, setInfo] = useState<{ current: string; latest: string; url?: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pct, setPct] = useState<number | null>(null);
  const dismissedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (dismissedRef.current) return;
      const res = await checkForUpdate();
      if (cancelled || dismissedRef.current) return;
      if (res?.hasUpdate) setInfo({ current: res.current, latest: res.latest, url: res.url });
    };
    void run();
    const id = window.setInterval(() => void run(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!info) return null;

  const dismiss = () => {
    if (phase === 'installing') return;
    dismissedRef.current = true;
    setInfo(null);
  };

  const openReleases = () => {
    const base = process.env.GIT_URL || 'https://github.com/ByteLogicLabs/Table-Relay';
    // Prefer the exact release page (from the Releases API) so the user lands on
    // the version's notes + assets; fall back to the latest-release redirect.
    const target = info.url || `${base}/releases/latest`;
    void openUrl(target).catch(() => {});
    dismiss();
  };

  const update = async () => {
    if (!canAutoInstall()) {
      openReleases();
      return;
    }
    setPhase('installing');
    setPct(null);
    try {
      await downloadAndInstallUpdate(({ downloaded, total }) => {
        setPct(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
      });
      setPhase('done');
      await relaunchApp();
    } catch (e) {
      setPhase('idle');
      setPct(null);
      toast.error(`Update failed: ${String(e)}`);
    }
  };

  const handleUpdateClick = () => void update();

  const installing = phase === 'installing';
  const done = phase === 'done';

  return (
    <div className="fixed bottom-14 right-4 z-50 w-76 rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <ArrowUpCircle className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm font-semibold flex-1 min-w-0">Update available</span>
        {!installing && (
          <button
            type="button"
            onClick={dismiss}
            className="-mr-1 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
            title="Dismiss"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="px-3.5 text-xs text-muted-foreground">
        <span className="font-mono text-foreground">{info.current}</span>
        {' → '}
        <span className="font-mono text-primary">{info.latest}</span>
        {' available'}
      </div>

      {installing && (
        <div className="px-3.5 pt-2.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: pct === null ? '40%' : `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {pct === null ? 'Downloading…' : `Downloading… ${pct}%`}
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 px-3.5 pt-3 pb-3.5">
        {done ? (
          <Button size="sm" className="h-7 text-xs flex-1" disabled>
            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Restarting…
          </Button>
        ) : installing ? (
          <Button size="sm" className="h-7 text-xs flex-1" disabled>
            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Installing…
          </Button>
        ) : (
          <>
            <Button size="sm" className="h-7 text-xs flex-1" onClick={handleUpdateClick}>
              {canAutoInstall() ? 'Update now' : 'Download'}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={dismiss}>
              Later
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
