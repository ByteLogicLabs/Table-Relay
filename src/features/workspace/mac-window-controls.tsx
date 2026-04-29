import { X, Minus, Maximize2 } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function MacWindowControls({ className = '' }: { className?: string }) {
  const win = getCurrentWindow();

  const onClose = () => { void win.close(); };
  const onMinimize = () => { void win.minimize(); };
  const onToggleMaximize = () => { void win.toggleMaximize(); };

  return (
    <div
      className={`flex items-center gap-1.5 pl-2 pr-2 py-2 ${className}`}
      data-tauri-drag-region
    >
      <button
        type="button"
        aria-label="Close window"
        onClick={onClose}
        style={{ width: 11, height: 11 }}
        className="rounded-full aspect-square shrink-0 bg-red-500 hover:bg-red-600 border border-red-600/60 flex items-center justify-center group cursor-default p-0 leading-none"
      >
        <X className="w-1.75 h-1.75 text-red-900 opacity-0 group-hover:opacity-100" strokeWidth={3} />
      </button>
      <button
        type="button"
        aria-label="Minimize window"
        onClick={onMinimize}
        style={{ width: 11, height: 11 }}
        className="rounded-full aspect-square shrink-0 bg-yellow-500 hover:bg-yellow-600 border border-yellow-600/60 flex items-center justify-center group cursor-default p-0 leading-none"
      >
        <Minus className="w-1.75 h-1.75 text-yellow-900 opacity-0 group-hover:opacity-100" strokeWidth={3} />
      </button>
      <button
        type="button"
        aria-label="Toggle maximize"
        onClick={onToggleMaximize}
        style={{ width: 11, height: 11 }}
        className="rounded-full aspect-square shrink-0 bg-green-500 hover:bg-green-600 border border-green-600/60 flex items-center justify-center group cursor-default p-0 leading-none"
      >
        <Maximize2 className="w-1.75 h-1.75 text-green-900 opacity-0 group-hover:opacity-100" strokeWidth={3} />
      </button>
    </div>
  );
}
