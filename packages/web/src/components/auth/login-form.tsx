import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import { ApiError } from '../../lib/auth-api';
import { useAuth } from '../../store/auth';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

/**
 * Formulaire de connexion (login/password).
 * Erreurs distinctes : identifiants invalides, compte désactivé, rate-limiting.
 */
export function LoginForm() {
  const { t } = useTranslation();
  const login = useAuth((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      // la navigation est gérée par le parent (LoginPage) via le statut du store
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      setError(t(`auth.error.${code}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-3">
      <div>
        <label htmlFor="login-username" className="mb-1 block text-xs font-medium text-muted-foreground">
          {t('auth.login.username')}
        </label>
        <Input
          id="login-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </div>
      <div>
        <label htmlFor="login-password" className="mb-1 block text-xs font-medium text-muted-foreground">
          {t('auth.login.password')}
        </label>
        <Input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}

      <Button type="submit" variant="default" disabled={busy || !username || !password} className="mt-1 h-9">
        {busy ? t('auth.login.busy') : t('auth.login.submit')}
      </Button>
    </form>
  );
}

/** Carte de connexion (logo + titre + formulaire). */
export function LoginCard() {
  const { t } = useTranslation();
  return (
    <div className="flex w-full max-w-sm flex-col gap-6 rounded-2xl border bg-card p-8 shadow-xl">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-md shadow-indigo-500/30">
          <Server className="h-6 w-6 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t('auth.login.title')}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{t('auth.login.subtitle')}</p>
        </div>
      </div>
      <LoginForm />
    </div>
  );
}
