import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { security, securityErrorMessage, type SecurityStatus } from '../../lib/security';
import { applyTheme, DEFAULTS } from '../../lib/settings-store';

export default function SecurityGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(DEFAULTS.theme);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void security.status()
      .then(s => {
        if (!cancelled) setStatus(s);
      })
      .catch(e => {
        if (!cancelled) setError(securityErrorMessage(e));
      });
    return () => { cancelled = true; };
  }, []);

  const mode = status?.state ?? 'locked';
  const creating = mode === 'uninitialized' || mode === 'needsMigration';
  const title = creating ? 'Create app password' : 'Unlock Table Relay';
  const subtitle = useMemo(() => {
    if (!status) return 'Checking encrypted store';
    if (status.state === 'needsMigration') {
      return 'A plaintext local store was found. Create a password to migrate it into encrypted storage.';
    }
    if (status.state === 'uninitialized') {
      return 'This password encrypts local connections, settings, AI keys, and chat history.';
    }
    return 'Enter your app password to decrypt local data for this session.';
  }, [status]);

  if (status?.state === 'unlocked') return <>{children}</>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Password is required');
      return;
    }
    if (creating && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = creating
        ? await security.initialize(password)
        : await security.unlock(password);
      setStatus(next);
      setPassword('');
      setConfirm('');
    } catch (err) {
      setError(securityErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeBackup = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await security.removeBackup());
    } catch (err) {
      setError(securityErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen w-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-3xl grid gap-8 md:grid-cols-[260px_minmax(0,380px)] items-center justify-center">
        <div className="hidden md:flex flex-col items-start gap-4">
          <img
            src="/logo.png"
            alt="Table Relay"
            className="w-36 h-36 rounded-2xl shadow-lg"
          />
          <div>
            <div className="text-xl font-semibold leading-tight">Table Relay</div>
            <div className="text-xs text-muted-foreground mt-1 max-w-52 leading-relaxed">
              Local data is encrypted before the workspace opens.
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="w-full max-w-sm border border-border bg-card px-5 py-5 rounded-lg shadow-sm">
          <div className="mb-5">
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight">{title}</h1>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{subtitle}</p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="app-password">Password</Label>
              <Input
                id="app-password"
                type="password"
                autoFocus
                autoComplete={creating ? 'new-password' : 'current-password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
            {creating && (
              <div className="space-y-1.5">
                <Label htmlFor="app-password-confirm">Confirm password</Label>
                <Input
                  id="app-password-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                />
              </div>
            )}
          </div>

          {status?.plaintextBackupExists && (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
              <p className="text-xs text-amber-500 leading-relaxed">
                A plaintext migration backup exists. Remove it after confirming the encrypted store opens correctly.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs mt-2"
                disabled={busy}
                onClick={() => void removeBackup()}
              >
                Remove backup now
              </Button>
            </div>
          )}
          {error && <p className="text-xs text-destructive mt-3 break-words">{error}</p>}

          <Button type="submit" className="w-full mt-5" disabled={!status || busy}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {creating ? 'Create and unlock' : 'Unlock'}
          </Button>
        </form>
      </div>
    </div>
  );
}
