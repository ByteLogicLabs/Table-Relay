import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from './ui/button';
import { checkForUpdate } from '../lib/update';

const POLL_MS = 30 * 60 * 1000; // re-check every 30 minutes

/**
 * Bottom-right "update available" notice.
 *
 * Behaviour (per product spec):
 *   - Shows on every boot when the running version is behind GitHub.
 *   - Re-checks every 30 minutes so a release published while the app is open
 *     still surfaces.
 *   - Dismissing hides it for the rest of this app run (in-memory only) — it
 *     reappears on the next reboot, not on the 30-min poll. Nothing is persisted,
 *     so there's no per-version "remembered dismissal".
 */
export function UpdateNotice() {
  const [info, setInfo] = useState<{ current: string; latest: string } | null>(null);
  // Dismissed for this session — suppresses the card until the app restarts,
  // even across the 30-min re-checks. A ref so the interval callback reads the
  // live value without re-subscribing.
  const dismissedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (dismissedRef.current) return;
      const res = await checkForUpdate();
      if (cancelled || dismissedRef.current) return;
      if (res?.hasUpdate) {
        setInfo({ current: res.current, latest: res.latest });
      }
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
    dismissedRef.current = true;
    setInfo(null);
  };

  const download = () => {
    const base = process.env.GIT_URL || 'https://github.com/ByteLogicLabs/Table-Relay';
    void openUrl(`${base}/releases/latest`).catch(() => {});
    dismiss();
  };

  return (
    // Offset above the dev-debug bug button (bottom-right) so they don't overlap.
    <div className="fixed bottom-14 right-4 z-50 w-76 rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
      {/* Header: icon + title, with the close button aligned to it. */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <ArrowUpCircle className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm font-semibold flex-1 min-w-0">Update available</span>
        <button
          type="button"
          onClick={dismiss}
          className="-mr-1 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Version line — kept on one line; the version pills don't break. */}
      <div className="px-3.5 text-xs text-muted-foreground">
        <span className="font-mono text-foreground">{info.current}</span>
        {' → '}
        <span className="font-mono text-primary">{info.latest}</span>
        {' available'}
      </div>
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-3.5">
        <Button size="sm" className="h-7 text-xs flex-1" onClick={download}>
          Download
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={dismiss}>
          Later
        </Button>
      </div>
    </div>
  );
}
