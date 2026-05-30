export default function MacWindowControls({ className = '' }: { className?: string }) {
  return (
    <div
      data-tauri-drag-region
      className={`h-8 shrink-0 ${className}`}
    />
  );
}
