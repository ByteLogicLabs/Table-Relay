import { useState } from 'react';
import { Bug, X, RefreshCw, Copy } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { copyText } from '../lib/clipboard';
import { useConnections } from '../state/connections';
import { useRail } from '../state/rail';
import { useDebugPage } from '../state/debug';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5 min-w-0">
      <span className="text-muted-foreground shrink-0 w-28 text-right">{label}</span>
      <span className="font-mono text-xs text-foreground break-all flex-1 min-w-0">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 px-1">{title}</div>
      <div className="rounded-md bg-muted/40 px-2 py-1 space-y-0.5 text-xs">{children}</div>
    </div>
  );
}

export default function DevDebug() {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const connState = useConnections();
  const rail = useRail();
  const page = useDebugPage();

  if (!import.meta.env.DEV) return null;

  const envEntries = Object.entries(import.meta.env as Record<string, string>).filter(
    ([k]) => !k.includes('SECRET') && !k.includes('PASSWORD') && !k.includes('KEY'),
  );

  const lsEntries: [string, string][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const v = localStorage.getItem(k) ?? '';
      lsEntries.push([k, v.length > 80 ? v.slice(0, 80) + '…' : v]);
    }
  } catch { /* noop */ }

  const debugText = [
    `View:       ${page.view}`,
    `Tab:        ${page.activeTabType ?? '—'} › ${page.activeTabTitle ?? '—'}`,
    `Tab ID:     ${page.activeTabId ?? '—'}`,
    `Connection: ${page.focusedConnection ?? '—'} / ${page.focusedDatabase ?? '—'}`,
    `URL:        ${window.location.href}`,
    ``,
    page.lastClick
      ? [
          `Last click:`,
          `  Element:  ${page.lastClick.tag}${page.lastClick.id ? '#' + page.lastClick.id : ''}`,
          `  Path:     ${page.lastClick.path}`,
          `  Text:     ${page.lastClick.text || '(empty)'}`,
          page.lastClick.role ? `  Role:     ${page.lastClick.role}` : null,
          `  At:       ${new Date(page.lastClick.timestamp).toLocaleTimeString()}`,
        ].filter(Boolean).join('\n')
      : `Last click: none`,
  ].join('\n');

  return (
    <>
      <button
        data-dev-debug
        onClick={() => setOpen(o => !o)}
        title="Dev debug"
        className="fixed bottom-3 right-3 z-9999 w-7 h-7 rounded-full bg-yellow-400/90 hover:bg-yellow-400 text-yellow-900 flex items-center justify-center shadow-lg transition-all"
      >
        <Bug className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div data-dev-debug className="fixed bottom-12 right-3 z-9999 w-96 rounded-xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
            <Bug className="w-3.5 h-3.5 text-yellow-500" />
            <span className="text-xs font-semibold flex-1">Dev Debug</span>
            <button
              title="Refresh"
              onClick={() => setTick(t => t + 1)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
            <button
              title="Copy all"
              onClick={() => {
                void copyText(debugText, 'Debug info copied');
              }}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              <Copy className="w-3 h-3" />
            </button>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          <ScrollArea className="flex-1 max-h-[70vh]">
            <div className="p-3 text-xs" key={tick}>

              <Section title="Last click">
                {page.lastClick ? (
                  <>
                    <Row label="tag" value={page.lastClick.tag} />
                    {page.lastClick.id && <Row label="id" value={page.lastClick.id} />}
                    {page.lastClick.role && <Row label="role" value={page.lastClick.role} />}
                    <Row label="text" value={page.lastClick.text || '(empty)'} />
                    <Row label="path" value={page.lastClick.path} />
                    {page.lastClick.classes && (
                      <Row label="classes" value={page.lastClick.classes} />
                    )}
                    {Object.entries(page.lastClick.dataAttrs).map(([k, v]) => (
                      <Row key={k} label={k} value={v} />
                    ))}
                    <Row label="at" value={new Date(page.lastClick.timestamp).toLocaleTimeString()} />
                  </>
                ) : (
                  <span className="text-muted-foreground">nothing clicked yet</span>
                )}
              </Section>

              <Section title="Page">
                <Row label="view" value={page.view} />
                <Row label="tab type" value={page.activeTabType ?? '—'} />
                <Row label="tab title" value={page.activeTabTitle ?? '—'} />
                <Row label="tab id" value={page.activeTabId ?? '—'} />
                <Row label="connection" value={page.focusedConnection ?? '—'} />
                <Row label="database" value={page.focusedDatabase ?? '—'} />
              </Section>

              <Section title="Window">
                <Row label="URL" value={window.location.href} />
                <Row label="origin" value={window.location.origin} />
                <Row label="pathname" value={window.location.pathname} />
                <Row label="userAgent" value={navigator.userAgent} />
              </Section>

              <Section title="Vite env">
                {envEntries.map(([k, v]) => (
                  <Row key={k} label={k} value={String(v)} />
                ))}
              </Section>

              <Section title="Rail tiles">
                {rail.tiles.length === 0
                  ? <span className="text-muted-foreground">empty</span>
                  : rail.tiles.map(t => (
                      <Row key={t.id} label={t.id.slice(0, 8)} value={`${t.serverId.slice(0, 8)} / ${t.databaseName}`} />
                    ))}
              </Section>

              <Section title="Connections">
                <Row label="active" value={String(connState.activeById.size)} />
                <Row label="connecting" value={String(connState.connectingIds.size)} />
                <Row label="errors" value={String(connState.lastErrorById.size)} />
                <Row label="schemas" value={String(connState.schemasById.size)} />
              </Section>

              <Section title="LocalStorage">
                {lsEntries.length === 0
                  ? <span className="text-muted-foreground">empty</span>
                  : lsEntries.map(([k, v]) => (
                      <Row key={k} label={k} value={v} />
                    ))}
              </Section>

            </div>
          </ScrollArea>
        </div>
      )}
    </>
  );
}
