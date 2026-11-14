import { useTranslation } from 'react-i18next';
import { Globe, LayoutTemplate, LogOut, Moon, ShieldCheck, Sun, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Lang } from '@prox4u/shared';
import { setLang } from '../../i18n';
import { useMulti } from '../../core/data/use-endpoint';
import { useDashboard } from '../../core/data/dashboard';
import { useTheme } from '../../store/theme';
import { useLayout } from '../../store/layout';
import { useCustomizablePage } from '../../core/widgets/customizable-page';
import { useAuth } from '../../store/auth';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

type HealthLabel = 'nominal' | 'degraded' | 'critical';
const LABEL_RANK: Record<HealthLabel, number> = { nominal: 0, degraded: 1, critical: 2 };
const LABEL_TONE: Record<HealthLabel, 'ok' | 'warn' | 'crit'> = { nominal: 'ok', degraded: 'warn', critical: 'crit' };

export function Topbar() {
  const { t, i18n } = useTranslation();
  const multi = useMulti();
  const wsConnected = useDashboard((s) => s.wsConnected);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);
  const resetLayout = useLayout((s) => s.resetLayout);
  // Le bouton de reset ci-dessous agit sur le store v1 (useLayout). Les pages
  // personnalisables v2 (vue d'ensemble v2, monitors v3) ont LEUR propre
  // barre d'outils avec leur reset — on masque le bouton v1 pour ne pas
  // exposer deux « Réinitialiser la disposition » dont l'un serait un no-op.
  const hasCustomizableToolbar = useCustomizablePage((s) => s.active);

  const eps = multi?.endpoints ?? [];
  const withSnap = eps.filter((e) => e.snapshot);
  const nodesOnline = withSnap.reduce((s, e) => s + (e.snapshot!.cluster.nodesOnline), 0);
  const nodesTotal = withSnap.reduce((s, e) => s + (e.snapshot!.cluster.nodesTotal), 0);
  const worst: HealthLabel | null = withSnap.length
    ? withSnap.reduce<HealthLabel>(
        (acc, e) => (LABEL_RANK[e.snapshot!.health.label] > LABEL_RANK[acc] ? e.snapshot!.health.label : acc),
        'nominal',
      )
    : null;
  const minScore = withSnap.length ? Math.min(...withSnap.map((e) => e.snapshot!.health.score)) : null;

  return (
    <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur transition-colors">
      <div className="flex h-14 items-center gap-3 px-4">
        {multi && (
          <div className="text-[11px] leading-tight text-muted-foreground">
            <span className="font-medium text-foreground">{eps.length}</span> {t('topbar.endpoints')} ·{' '}
            <span className="font-medium text-foreground">
              {nodesOnline}/{nodesTotal}
            </span>{' '}
            {t('topbar.nodes')}
          </div>
        )}

        {worst && minScore !== null && (
          <Badge tone={LABEL_TONE[worst]}>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            {t(`health.${worst}`)} · {Math.round(minScore)}
          </Badge>
        )}

        {multi?.mock && <Badge tone="warn">{t('topbar.mock')}</Badge>}

        <div className="ml-auto flex items-center gap-2">
          <span className="mr-1 flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground">
            <span
              className={`h-1.5 w-1.5 rounded-full ${wsConnected ? 'animate-pulse bg-ok' : 'bg-crit'}`}
              title={wsConnected ? t('topbar.live') : t('topbar.reconnecting')}
            />
            {wsConnected ? t('topbar.live') : t('topbar.reconnecting')}
          </span>
          <Button variant="outline" size="sm" onClick={() => setLang(i18n.language === 'fr' ? ('en' as Lang) : ('fr' as Lang))}>
            <Globe className="h-3.5 w-3.5" />
            {i18n.language.toUpperCase()}
          </Button>
          {!hasCustomizableToolbar && (
            <Button variant="outline" size="sm" onClick={resetLayout} title={t('topbar.resetLayout')}>
              <LayoutTemplate className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={toggleTheme} title={t('topbar.theme')}>
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>
          <UserActions />
        </div>
      </div>
    </header>
  );
}

/** Menu utilisateur linéaire (toujours visible) : avatar + nom + rôle, puis actions profil / administration / déconnexion. */
function UserActions() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  if (!user) return null;
  const initials = user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <>
      <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
          {initials || <UserRound className="h-3.5 w-3.5" />}
        </span>
        <span className="hidden max-w-28 truncate md:block">{user.displayName}</span>
        <Badge tone={user.role === 'admin' ? 'primary' : 'default'}>{t(`role.${user.role}`)}</Badge>
      </div>
      <Button variant="outline" size="sm" onClick={() => navigate('/profile')} title={t('topbar.profile')}>
        <UserRound className="h-3.5 w-3.5" />
      </Button>
      {user.role === 'admin' && (
        <Button variant="outline" size="sm" onClick={() => navigate('/admin')} title={t('nav.admin')}>
          <ShieldCheck className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => void logout()} title={t('topbar.logout')}>
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    </>
  );
}
