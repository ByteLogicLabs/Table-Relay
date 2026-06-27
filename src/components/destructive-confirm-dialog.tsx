import { useCallback } from 'react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Action verb shown in title and primary button, e.g. "Drop", "Delete", "Truncate". */
  action: string;
  /** Singular noun for what is being acted on, e.g. "table", "row", "database", "conversation". */
  itemNoun: string;
  /** Names of the items being affected. Used for both the count and the visible list. */
  itemNames: string[];
  /** Optional context line shown above the names list, e.g. "from public.users" or "in connection production". */
  context?: string;
  /** Extra warning text below the names list. */
  warning?: string;
  /** Render the visible names list. Off when the count alone is enough (e.g.
   *  clearing many conversations) — `itemNames` is still used for the count. */
  showList?: boolean;
  onConfirm: () => void;
}

export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  action,
  itemNoun,
  itemNames,
  context,
  warning,
  showList = true,
  onConfirm,
}: Props) {
  const count = itemNames.length;
  const pluralNoun = count === 1 ? itemNoun : `${itemNoun}s`;
  const title = `${action} ${count} ${pluralNoun}?`;
  const buttonLabel = `${action} ${count} ${pluralNoun}`;
  const visibleNames = itemNames.slice(0, 20);
  const overflow = count - visibleNames.length;

  const handleCancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  const handleConfirm = useCallback(() => {
    onConfirm();
    onOpenChange(false);
  }, [onConfirm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">{title}</DialogTitle>
          {context && <DialogDescription>{context}</DialogDescription>}
        </DialogHeader>
        {showList && (
          <div className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs font-mono">
            <ul className="space-y-0.5">
              {visibleNames.map((name) => (
                <li key={name} className="truncate">{name}</li>
              ))}
            </ul>
            {overflow > 0 && (
              <div className="mt-1 text-muted-foreground">
                …and {overflow} more
              </div>
            )}
          </div>
        )}
        {warning && (
          <p className="text-xs text-muted-foreground">{warning}</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            autoFocus
          >
            {buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
