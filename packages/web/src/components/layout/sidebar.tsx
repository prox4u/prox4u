import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import type { EndpointSnapshot, NodeHealth } from '@prox4u/shared';
import { useMulti } from '../../core/data/use-endpoint';
import { useDashboard } from '../../core/data/dashboard';
import { useAuth } from '../../store/auth';
import { PluginMenu } from '../../core/ui/PluginMenu';

function dotClass(ep: EndpointSnapshot): string {
  if (!ep.ok) return 'bg-crit';
  const label = ep.snapshot?.health.label;
  if (label === 'critical') return 'bg-crit';
  if (label === 'degraded') return 'bg-warn';
  if (label === 'nominal') return 'bg-ok';
  return 'bg-muted-foreground/40';
}

function nodeDotClass(n: NodeHealth): string {
  if (!n.online) return 'bg-crit';
  if (n.severity === 'crit') return 'bg-crit';
  if (n.severity === 'warn') return 'bg-warn';
  return 'bg-ok';
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
  }`;

const nodeLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md py-1.5 pl-7 pr-2.5 text-xs font-medium transition-colors ${
    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
  }`;

export function Sidebar() {
  const { t } = useTranslation();
  const multi = useMulti();
  const wsConnected = useDashboard((s) => s.wsConnected);
  // La liste des endpoints/nœuds appartient au module « hypervision » :
  // masquée si l'utilisateur n'a pas ce module visible.
  const hypervisionVisible = useAuth((s) => s.visibleModuleIds.includes('hypervision'));

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card transition-colors">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-md shadow-indigo-500/30">
          <Server className="h-4 w-4 text-white" />
        </div>
        <div className="text-sm font-semibold tracking-tight">{t('app.title')}</div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        {/*
         * Menu : fourni par les plugins actifs (triés par `order` — hypervision 10,
         * network 20, storage 30). Un plugin désactivé par feature flag ne fournit
         * plus d'entrée de menu.
         */}
        <PluginMenu />

        {hypervisionVisible && (
          <>
            <div className="mb-2 mt-5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('nav.proxmox')}
            </div>
            <div className="space-y-1">
              {(multi?.endpoints ?? []).map((ep) => (
            <div key={ep.id}>
              <NavLink to={`/e/${encodeURIComponent(ep.id)}`} className={linkClass} title={ep.error ?? ep.name}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(ep)}`} />
                <span className="truncate">{ep.name}</span>
              </NavLink>
              {(ep.snapshot?.nodes ?? []).map((n) => (
                <NavLink
                  key={n.node}
                  to={`/e/${encodeURIComponent(ep.id)}/n/${encodeURIComponent(n.node)}`}
                  className={nodeLinkClass}
                  title={n.online ? n.node : `${n.node} — ${t('nodes.offline')}`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${nodeDotClass(n)}`} />
                  <span className="truncate">{n.node}</span>
                </NavLink>
              ))}
              </div>
              ))}
            </div>
          </>
        )}
      </nav>

      <div className="flex items-center gap-1.5 border-t p-3 text-[11px] tracking-wide text-muted-foreground">
        <span className={`h-1.5 w-1.5 rounded-full ${wsConnected ? 'animate-pulse bg-ok' : 'bg-crit'}`} />
        {wsConnected ? t('topbar.live') : t('topbar.reconnecting')}
      </div>
    </aside>
  );
}
