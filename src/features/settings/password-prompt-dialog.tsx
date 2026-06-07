import { useEffect, useRef, useState } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

/**
 * Small password prompt used for encrypted export/import.
 *
 *  - mode 'set'   → exporting: ask for a password + confirmation.
 *  - mode 'enter' → importing an encrypted file: ask for the password.
 *
 * Resolves via `onSubmit(password)`; closing without submitting calls
 * `onOpenChange(false)` so the caller can treat it as a cancel.
 */
export default function PasswordPromptDialog({
  open,
  mode,
  title,
  description,
  busy,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  mode: 'set' | 'enter';
  title: string;
  description?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (password: string) => void;
  onOpenChange: (v: boolean) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setConfirm('');
      setShow(false);
      setLocalError(null);
      // Focus after the dialog mounts.
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const submit = () => {
    if (!password) {
      setLocalError('Enter a password.');
      return;
    }
    if (mode === 'set') {
      if (password.length < 4) {
        setLocalError('Use at least 4 characters.');
        return;
      }
      if (password !== confirm) {
        setLocalError('Passwords don’t match.');
        return;
      }
    }
    setLocalError(null);
    onSubmit(password);
  };

  const shownError = error ?? localError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Lock className="w-4 h-4" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {description && <p className="text-xs text-muted-foreground">{description}</p>}

          <div className="relative">
            <Input
              ref={inputRef}
              type={show ? 'text' : 'password'}
              className="pr-9 h-9 text-sm"
              placeholder={mode === 'set' ? 'New password' : 'Password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'enter') submit(); }}
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={show ? 'Hide password' : 'Show password'}
            >
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {mode === 'set' && (
            <Input
              type={show ? 'text' : 'password'}
              className="h-9 text-sm"
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
          )}

          {shownError && <p className="text-xs text-destructive">{shownError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={busy}>
              {mode === 'set' ? 'Encrypt & export' : 'Decrypt & import'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
