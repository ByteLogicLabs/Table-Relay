import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import type { DestructiveStatement } from './analyze-destructive';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statements: DestructiveStatement[];
  onConfirm: () => void;
}

export function DestructiveWarningDialog({
  open,
  onOpenChange,
  statements,
  onConfirm,
}: Props) {
  const details = statements
    .map((s) => `[${s.kind}] ${s.detail}: ${s.sql.length > 100 ? s.sql.slice(0, 100) + '…' : s.sql}`)
    .join('\n');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-orange-600">
            ⚠ Destructive query detected
          </DialogTitle>
          <DialogDescription>
            The following statement{statements.length > 1 ? 's' : ''} may
            modify or delete data without a WHERE clause.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap">
          {details}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Run anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
