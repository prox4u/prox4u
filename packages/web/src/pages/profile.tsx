import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, LayoutGrid } from 'lucide-react';
import { ChangePasswordForm } from '../components/auth/change-password-form';
import { ModuleSelector } from '../components/auth/module-selector';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { useAuth } from '../store/auth';

/**
 * Page « Mon profil » : changement de mot de passe + colonne des modules actifs.
 * Avant le 1er changement forcé (mustChangePassword), seul l'onglet mot de
 * passe est accessible (forçage côté ProtectedRoute).
 */
export function ProfilePage() {
  const { t } = useTranslation();
  const user = useAuth((s) => s.user);
  const [params, setParams] = useSearchParams();

  if (!user) return null;

  // Mode forçage : pas d'onglets, uniquement le changement de mot de passe.
  if (user.mustChangePassword) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4">
        <h1 className="text-lg font-semibold tracking-tight">{t('profile.title')}</h1>
        <p role="alert" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          {t('profile.password.forced')}
        </p>
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.tab.password')}</CardTitle>
          </CardHeader>
          <div className="px-4 pb-4">
            <ChangePasswordForm />
          </div>
        </Card>
      </div>
    );
  }

  const tab = params.get('tab') === 'modules' ? 'modules' : 'password';

  function switchTab(next: string) {
    setParams(next === 'password' ? {} : { tab: next }, { replace: true });
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight">{t('profile.title')}</h1>

      <div className="flex gap-1 rounded-xl border bg-card p-1">
        {(
          [
            { id: 'password', label: t('profile.tab.password'), icon: KeyRound },
            { id: 'modules', label: t('profile.tab.modules'), icon: LayoutGrid },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => switchTab(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'password' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.tab.password')}</CardTitle>
          </CardHeader>
          <div className="px-4 pb-4">
            <ChangePasswordForm />
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.tab.modules')}</CardTitle>
          </CardHeader>
          <div className="px-4 pb-4">
            <ModuleSelector />
          </div>
        </Card>
      )}
    </div>
  );
}
