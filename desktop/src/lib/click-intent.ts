export type ClickIntent =
  | { kind: 'open' }
  | { kind: 'toggle' }
  | { kind: 'range' }
  | { kind: 'context' };

type ClickLikeEvent = {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  button?: number;
};

export function getClickIntent(e: ClickLikeEvent): ClickIntent {
  if (e.button === 2) return { kind: 'context' };
  if (e.shiftKey) return { kind: 'range' };
  if (e.metaKey || e.ctrlKey) return { kind: 'toggle' };
  return { kind: 'open' };
}

type KeyLikeEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

export type KeyIntent =
  | { kind: 'open' }
  | { kind: 'toggle' }
  | { kind: 'move'; direction: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'extend'; direction: 'up' | 'down' }
  | { kind: 'select-all' }
  | { kind: 'remove-view' }
  | { kind: 'remove-destructive' }
  | { kind: 'rename' }
  | { kind: 'copy' }
  | { kind: 'refresh' }
  | { kind: 'escape' }
  | null;

export function getKeyIntent(e: KeyLikeEvent): KeyIntent {
  const mod = e.metaKey || e.ctrlKey;

  switch (e.key) {
    case 'Enter':
      return { kind: 'open' };
    case ' ':
      return { kind: 'toggle' };
    case 'ArrowUp':
      return e.shiftKey ? { kind: 'extend', direction: 'up' } : { kind: 'move', direction: 'up' };
    case 'ArrowDown':
      return e.shiftKey ? { kind: 'extend', direction: 'down' } : { kind: 'move', direction: 'down' };
    case 'ArrowLeft':
      return { kind: 'move', direction: 'left' };
    case 'ArrowRight':
      return { kind: 'move', direction: 'right' };
    case 'Delete':
    case 'Backspace':
      return mod ? { kind: 'remove-destructive' } : { kind: 'remove-view' };
    case 'a':
    case 'A':
      return mod ? { kind: 'select-all' } : null;
    case 'c':
    case 'C':
      return mod ? { kind: 'copy' } : null;
    case 'r':
    case 'R':
      return mod ? { kind: 'refresh' } : null;
    case 'F2':
      return { kind: 'rename' };
    case 'Escape':
      return { kind: 'escape' };
    default:
      return null;
  }
}
