// macOS uses titleBarStyle "Overlay": traffic lights overlay the content top-left,
// so the rail reserves space for them. Windows/Linux have a native titlebar, so
// this spacer is just wasted gap — render nothing there.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export default function MacWindowControls({ className = '' }: { className?: string }) {
  if (!IS_MAC) return null;
  return (
    <div
      data-tauri-drag-region
      className={`h-8 shrink-0 ${className}`}
    />
  );
}
