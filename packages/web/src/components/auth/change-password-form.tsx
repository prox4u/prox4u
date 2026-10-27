import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { validatePassword } from '@prox4u/shared';
import { ApiError, authApi } from '../../lib/auth-api';
import { useAuth } from '../../store/auth';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

/**
 * Changement de mot de passe (ancien + nouveau + confirmation).
 * Validation client miroir de la politique serveur (shared/validatePassword) ;
 * le serveur reste la source de vérité (mêmes codes d'erreur).
 */
export function ChangePasswordForm() {
  const { t } = useTranslation();
  const refresh = useAuth((s) => s.refresh);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSuccess(false);

    // Miroir client de la politique serveur (UX immédiate)
    if (next !== confirm) {
      setError(t('profile.password.error.mismatch'));
      return;
    }
    const issue = validatePassword(next);
    if (issue) {
      setError(t(`profile.password.error.weak.${issue}`));
      return;
    }

    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setSuccess(true);
      setCurrent('');
      setNext('');
      setConfirm('');
      await refresh(); // resynchronise mustChangePassword / user
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      // codes serveur weak-<issue> → clés i18n profile.password.error.weak.<issue>
      const key = code.startsWith('weak-') ? `weak.${code.slice(5)}` : code;
      setError(t(`profile.password.error.${key}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div>
        <label htmlFor="pw-current" className="mb-1 block text-xs font-medium text-muted-foreground">
          {t('profile.password.current')}
        </label>
        <Input
          id="pw-current"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>
      <div>
        <label htmlFor="pw-new" className="mb-1 block text-xs font-medium text-muted-foreground">
          {t('profile.password.new')}
        </label>
        <Input
          id="pw-new"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          required
        />
      </div>
      <div>
        <label htmlFor="pw-confirm" className="mb-1 block text-xs font-medium text-muted-foreground">
          {t('profile.password.confirm')}
        </label>
        <Input
          id="pw-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}
      {success && !error && (
        <p role="status" className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
          {t('profile.password.success')}
        </p>
      )}

      <Button type="submit" variant="default" disabled={busy || !current || !next || !confirm} className="h-9 w-fit">
        {busy ? t('profile.password.busy') : t('profile.password.submit')}
      </Button>
    </form>
  );
}
