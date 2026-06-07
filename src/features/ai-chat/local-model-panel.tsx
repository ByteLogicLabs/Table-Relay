import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { ai, isAiError, type LocalModelInfo, type DownloadDoneEvent, type LlamaRuntimeStatus } from '../../lib/ai';
import { Trash2, Download as DownloadIcon, StopCircle, Copy, CheckCircle2, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { copyText } from '../../lib/clipboard';
import { fmtBytes, fmtRate } from './chat-utils';

// -----------------------------------------------------------------------------
// Local Llama — model catalog with download / delete controls.
// -----------------------------------------------------------------------------

interface DownloadProgress {
  downloaded: number;
  total: number;
  speedBps: number;
}

export function LocalModelPanel({
  selectedId,
  onPick,
}: {
  selectedId: string;
  onPick: (id: string) => void;
}) {
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [runtime, setRuntime] = useState<LlamaRuntimeStatus | null>(null);
  const [checkingRuntime, setCheckingRuntime] = useState(false);

  const refreshRuntime = async () => {
    setCheckingRuntime(true);
    try {
      setRuntime(await ai.checkLlamaServer());
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setCheckingRuntime(false);
    }
  };

  const refresh = async () => {
    try {
      const list = await ai.listLocalModels();
      setModels(list);
      // If nothing is selected yet, auto-pick the first downloaded entry so
      // Start Chat enables the moment the user has something usable.
      if (!selectedId) {
        const first = list.find(m => m.downloaded);
        if (first) onPick(first.id);
      }
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    void refreshRuntime();
    let cancelProg: (() => void) | undefined;
    let cancelDone: (() => void) | undefined;
    void (async () => {
      cancelProg = await ai.onDownloadProgress(ev => {
        setProgress(p => ({
          ...p,
          [ev.modelId]: { downloaded: ev.downloaded, total: ev.total, speedBps: ev.speedBps },
        }));
      });
      cancelDone = await ai.onDownloadDone((ev: DownloadDoneEvent) => {
        setInFlight(prev => {
          const next = new Set(prev);
          next.delete(ev.modelId);
          return next;
        });
        setProgress(p => {
          const copy = { ...p };
          delete copy[ev.modelId];
          return copy;
        });
        if (ev.status === 'error') {
          toast.error(`Download failed: ${ev.message ?? 'unknown error'}`);
        }
        void refresh();
      });
    })();
    return () => {
      cancelProg?.();
      cancelDone?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDownload = async (id: string) => {
    setInFlight(prev => new Set(prev).add(id));
    try {
      await ai.downloadModel(id);
    } catch (e) {
      if (isAiError(e) && e.kind === 'Canceled') {
        // Cancel path — already handled by onDownloadDone, nothing to surface.
        return;
      }
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await ai.cancelDownload(id);
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  const handleDelete = async (id: string) => {
    const ok = window.confirm('Delete this model? The weights will be removed from disk.');
    if (!ok) return;
    try {
      await ai.deleteModel(id);
      if (selectedId === id) onPick('');
      await refresh();
    } catch (e) {
      toast.error(isAiError(e) ? e.message : String(e));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading catalog…
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Local models</label>
        <span className="text-[10px] text-muted-foreground opacity-70">
          Stored in <span className="font-mono">ai-models/</span>
        </span>
      </div>

      <LlamaRuntimeCard runtime={runtime} checking={checkingRuntime} onRecheck={refreshRuntime} />

      {models.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No models in catalog.</p>
      )}

      <RadioGroup
        // Selection model: the RadioGroup drives `onPick` and the card
        // click target also calls `onPick` — both converge on the same
        // state setter so either path works for the user.
        value={selectedId ?? ''}
        onValueChange={(v) => { if (typeof v === 'string') onPick(v); }}
        className="contents"
      >
      {models.map(m => {
        const prog = progress[m.id];
        const downloading = inFlight.has(m.id) || !!prog;
        const pct = prog && prog.total > 0
          ? Math.min(100, Math.round((prog.downloaded / prog.total) * 100))
          : (m.downloaded ? 100 : 0);
        const isSelected = selectedId === m.id;
        const canSelect = m.downloaded && !downloading;

        return (
          <div
            key={m.id}
            className={`rounded-md border px-2.5 py-2 transition-colors ${
              isSelected ? 'border-primary bg-primary/5' : 'border-border'
            } ${canSelect ? 'cursor-pointer hover:bg-muted/20' : ''}`}
            onClick={() => { if (canSelect) onPick(m.id); }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value={m.id} disabled={!canSelect} />
                  <span className="text-xs font-medium truncate">{m.display}</span>
                  {!m.hashPinned && (
                    <span
                      className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 shrink-0"
                      title="Catalog entry has no pinned sha256 — install proceeds and the computed hash is logged. Paste it back into models_catalog.rs to pin."
                    >
                      Unverified
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {fmtBytes(m.sizeBytes)} · {m.minRamGb}GB+ RAM recommended
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {downloading ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void handleCancel(m.id); }}
                    className="p-1 text-muted-foreground hover:text-destructive"
                    title="Cancel download"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                  </button>
                ) : m.downloaded ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(m.id); }}
                    className="p-1 text-muted-foreground hover:text-destructive"
                    title="Delete model"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void handleDownload(m.id); }}
                    className="flex items-center gap-1 text-[11px] text-foreground bg-muted/50 hover:bg-muted px-2 py-1 rounded"
                    title="Download model"
                  >
                    <DownloadIcon className="w-3 h-3" />
                    {m.hasPartial ? 'Resume' : 'Download'}
                  </button>
                )}
              </div>
            </div>

            {(downloading || m.hasPartial) && (
              <div className="mt-1.5">
                <div className="h-1 w-full bg-muted/40 rounded overflow-hidden">
                  <div
                    className="h-full bg-primary transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center justify-between">
                  <span>
                    {fmtBytes(prog?.downloaded ?? m.partialBytes)} / {fmtBytes(prog?.total ?? m.sizeBytes)}
                    {' '}({pct}%)
                  </span>
                  {prog && <span>{fmtRate(prog.speedBps)}</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
      </RadioGroup>

      <p className="text-[10px] text-muted-foreground opacity-70">
        Pick a downloaded model, then Start chat. Weights stay on disk after End chat.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Runtime install card. Shown inside LocalModelPanel: green banner when
// llama-server is detected, yellow install-instructions card when missing.
// Keeps the install action outside the app process — we open the provider's
// install path rather than run privileged commands ourselves.
// -----------------------------------------------------------------------------

function LlamaRuntimeCard({
  runtime,
  checking,
  onRecheck,
}: {
  runtime: LlamaRuntimeStatus | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  if (!runtime) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/20 text-[11px] text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        Checking llama-server…
      </div>
    );
  }

  if (runtime.installed) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-green-500/30 bg-green-500/10 text-[11px]">
        <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400 shrink-0" />
        <span className="font-medium text-green-700 dark:text-green-300">llama-server detected</span>
        {runtime.path && (
          <span className="text-muted-foreground font-mono truncate opacity-80" title={runtime.path}>
            · {runtime.path}
          </span>
        )}
      </div>
    );
  }

  const copyInstall = async () => {
    await copyText(runtime.installCommand, 'Install command copied');
  };

  const openReleases = () => {
    window.open('https://github.com/ggerganov/llama.cpp/releases', '_blank');
  };

  const platformLabel =
    runtime.platform === 'macos' ? 'macOS' :
    runtime.platform === 'linux' ? 'Linux' :
    runtime.platform === 'windows' ? 'Windows' : 'your system';

  return (
    <div className="space-y-2 px-3 py-2.5 rounded-md border border-yellow-500/30 bg-yellow-500/10">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-yellow-700 dark:text-yellow-300">
            llama-server not installed
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            To run local models on {platformLabel}, install the <span className="font-mono">llama.cpp</span> CLI. It's open-source and free.
          </p>
        </div>
      </div>

      <div className="relative">
        <pre className="text-[11px] font-mono bg-background/60 border border-border rounded px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap wrap-break-word">
          {runtime.installCommand}
        </pre>
        <button
          type="button"
          onClick={copyInstall}
          className="absolute top-1 right-1 p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground"
          title="Copy"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onRecheck}
          disabled={checking}
        >
          {checking ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1.5" />}
          {checking ? 'Checking…' : 'Re-check'}
        </Button>
        <button
          type="button"
          onClick={openReleases}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="w-3 h-3" />
          Manual download
        </button>
      </div>
    </div>
  );
}
