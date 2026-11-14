import { useTranslation } from 'react-i18next';
import { useDashboard } from '../../core/data/dashboard';
import { PluginMenu } from '../../core/ui/PluginMenu';

export function Sidebar() {
  const { t } = useTranslation();
  const wsConnected = useDashboard((s) => s.wsConnected);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card transition-colors">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        {/* Emblème Prox4u sur fond blanc : les parties noires du bouclier
            restent visibles en thème sombre comme en thème clair. */}
        <img
          src="/images/logo-emblem.webp"
          alt=""
          aria-hidden
          className="h-8 w-8 rounded-lg border border-border bg-white"
        />
        <div className="text-sm font-semibold tracking-tight">{t('app.title')}</div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        {/*
         * Menu : fourni par les plugins actifs (triés par `order` — hypervision 10,
         * network 20, storage 30). Un plugin désactivé par feature flag ne fournit
         * plus d'entrée de menu. L'arbre endpoints/nœuds Proxmox est un sous-menu
         * repliable de « Vue d'ensemble » (PluginMenu + manifest hypervision).
         */}
        <PluginMenu />
      </nav>

      {/* Mascotte Prox4u — sous le menu, au-dessus de l'indicateur LIVE */}
      <div className="px-3 pb-3">
        <img
          src="/images/robot-cosy-sidebar.webp"
          alt=""
          aria-hidden
          className="h-auto w-full rounded-lg border border-border"
        />
      </div>

      <div className="flex items-center gap-1.5 border-t p-3 text-[11px] tracking-wide text-muted-foreground">
        <span className={`h-1.5 w-1.5 rounded-full ${wsConnected ? 'animate-pulse bg-ok' : 'bg-crit'}`} />
        {wsConnected ? t('topbar.live') : t('topbar.reconnecting')}
      </div>
    </aside>
  );
}
