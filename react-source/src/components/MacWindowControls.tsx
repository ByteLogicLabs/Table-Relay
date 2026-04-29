import { X, Minus, Maximize2 } from 'lucide-react';

export default function MacWindowControls({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 px-4 py-3 ${className}`}>
      <div className="w-3 h-3 rounded-full bg-red-500 border border-red-600 flex items-center justify-center group relative cursor-default">
        <X className="w-2 h-2 text-red-900 opacity-0 group-hover:opacity-100" />
      </div>
      <div className="w-3 h-3 rounded-full bg-yellow-500 border border-yellow-600 flex items-center justify-center group relative cursor-default">
        <Minus className="w-2 h-2 text-yellow-900 opacity-0 group-hover:opacity-100" />
      </div>
      <div className="w-3 h-3 rounded-full bg-green-500 border border-green-600 flex items-center justify-center group relative cursor-default">
        <Maximize2 className="w-2 h-2 text-green-900 opacity-0 group-hover:opacity-100" />
      </div>
    </div>
  );
}
