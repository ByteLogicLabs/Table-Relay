import { useCallback, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, Ban } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog';
import { Button } from './button';
import { cn } from '@/src/lib/utils';

export type ProgressPhase = 'running' | 'done' | 'error' | 'cancelled';

export interface ProgressLogLine {
  text: string;
  kind?: 'info' | 'success' | 'error';
}

export interface ProgressState {
  /** Short step label, e.g. "Exporting public.users". */
  step: string;
  /** 0..1 fraction, or null for an indeterminate bar. */
  fraction: number | null;
  /** Optional numeric detail, e.g. "1,200 / 5,000 rows". */
  detail?: string;
  phase: ProgressPhase;
  /** Append-only log lines shown in a scrolling box. */
  log: ProgressLogLine[];
}

/**
 * A modal progress popup for long-running import/export jobs. Shows a progress
 * bar (determinate when a fraction is known, indeterminate otherwise), the
 * current step, a numeric detail line, and a scrolling log. Offers Cancel while
 * running and Close once the job settles.
 */
export default function ProgressDialog({
  open,
  title,
  state,
  onCancel,
  onClose,
  /** When false, the running phase shows no Cancel button (e.g. a single
   *  server-side call that can't be interrupted). Defaults to true. */
  cancellable = true,
}: {
  open: boolean;
  title: string;
  state: ProgressState | null;
  onCancel: () => void;
  onClose: () => void;
  cancellable?: boolean;
}) {
  const logRef = useRef<HTMLDivElement | null>(null);

  // Keep the log pinned to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state?.log.length]);

  const phase = state?.phase ?? 'running';
  const running = phase === 'running';
  const pct = state?.fraction != null ? Math.round(state.fraction * 100) : null;

  const handleOpenChange = useCallback(
    (o: boolean) => {
      // While running, the backdrop / Esc shouldn't silently abort — the user
      // must press Cancel. Allow close only once settled.
      if (!o && !running) onClose();
    },
    [running, onClose],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            {phase === 'running' && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
            {phase === 'done' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
            {phase === 'error' && <XCircle className="w-4 h-4 text-destructive" />}
            {phase === 'cancelled' && <Ban className="w-4 h-4 text-muted-foreground" />}
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Step + percentage */}
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-foreground">{state?.step ?? 'Starting…'}</span>
            {pct != null && <span className="tabular-nums text-muted-foreground shrink-0">{pct}%</span>}
          </div>

          {/* Progress bar */}
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            {pct != null ? (
              <div
                className={cn(
                  'h-full transition-[width] duration-150',
                  phase === 'error' ? 'bg-destructive' : phase === 'cancelled' ? 'bg-muted-foreground' : 'bg-primary',
                )}
                style={{ width: `${pct}%` }}
              />
            ) : (
              // Indeterminate: a sliding sliver.
              <div className="h-full w-1/3 bg-primary/70 animate-[progress-indeterminate_1.2s_ease-in-out_infinite]" />
            )}
          </div>

          {state?.detail && (
            <div className="text-xs text-muted-foreground tabular-nums">{state.detail}</div>
          )}

          {/* Log */}
          {state && state.log.length > 0 && (
            <div
              ref={logRef}
              className="max-h-40 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-2 font-mono text-[11px] leading-relaxed"
            >
              {state.log.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap wrap-break-word',
                    l.kind === 'error' && 'text-destructive',
                    l.kind === 'success' && 'text-emerald-500',
                    (!l.kind || l.kind === 'info') && 'text-muted-foreground',
                  )}
                >
                  {l.text}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            {running ? (
              cancellable ? (
                <Button variant="outline" size="sm" onClick={onCancel}>
                  <Ban className="w-3.5 h-3.5 mr-1.5" /> Cancel
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground self-center">
                  This step can’t be cancelled once started.
                </span>
              )
            ) : (
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
