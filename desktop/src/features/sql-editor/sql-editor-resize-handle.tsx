import { useRef } from 'react';

/**
 * A 6px drag strip that reports delta-Y to its parent. Placed at the top or
 * bottom edge of a panel; the parent decides whether dragging down means
 * "grow" or "shrink" via the onResize callback (positive dy = cursor moved
 * down). Captures the pointer on mousedown so drags continue even when the
 * cursor briefly leaves the handle.
 */
export function VerticalResizeHandle({
  onResize,
  orientation,
}: {
  onResize: (dy: number) => void;
  orientation: 'top' | 'bottom';
}) {
  const startYRef = useRef(0);
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startYRef.current = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startYRef.current;
      startYRef.current = ev.clientY;
      onResize(dy);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <div
      onMouseDown={onDown}
      role="separator"
      aria-orientation="horizontal"
      className={`absolute left-0 right-0 h-1.5 cursor-ns-resize hover:bg-primary/30 active:bg-primary/50 z-20 ${
        orientation === 'top' ? '-top-0.5' : '-bottom-0.5'
      }`}
    />
  );
}
