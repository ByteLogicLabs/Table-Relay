// Frontend diagnostic logger. Writes to the browser console AND (best-effort)
// to the Rust side via the `frontend_log` command, so the lines land in
// logs/app.log tagged `fe:<tag>` — interleaved with backend lines on the same
// clock. Use this to trace flows that cross the JS↔Rust boundary (chat send,
// event delivery) where a console-only log is lost once the window reloads.

import { invoke } from '@tauri-apps/api/core';

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Log one diagnostic line. `tag` groups related lines (e.g. "chat"); `parts`
 * are concatenated (objects JSON-stringified). Fire-and-forget — never throws,
 * never blocks the caller.
 */
export function flog(tag: string, ...parts: unknown[]): void {
  const msg = parts.map(safeStringify).join(' ');
  // Console first so it's visible in devtools even if the IPC call fails.
  // eslint-disable-next-line no-console
  console.log(`[fe:${tag}]`, ...parts);
  void invoke('frontend_log', { tag, msg }).catch(() => {
    /* logging must never break the app */
  });
}
