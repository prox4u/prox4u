import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { EndpointSnapshot, NodeHealth } from '@prox4u/shared';
import { useMulti } from '../../../core/data/use-endpoint';

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

/**
 * Pastille de santé agrégée de TOUS les endpoints — rendue à gauche du label
 * « Vue d'ensemble » (item de menu avec submenu) : l'alerte reste visible
 * même sous-menu replié. Rouge si un endpoint est en erreur/critique,
 * orange si l'un est dégradé, vert si tout est nominal.
 */
export function EndpointFleetDot() {
  const multi = useMulti();
  const eps = multi?.endpoints ?? [];
  // La sévérité la plus forte gagne : crit > warn > ok > neutre.
  const classes = eps.map(dotClass);
  const cls = classes.includes('bg-crit')
    ? 'bg-crit'
    : classes.includes('bg-warn')
      ? 'bg-warn'
      : classes.includes('bg-ok')
        ? 'bg-ok'
        : 'bg-muted-foreground/40';
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

const epLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
  }`;

const nodeLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md py-1 pl-6 pr-2 text-xs font-medium transition-colors ${
    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
  }`;

/**
 * Arbre endpoints → nœuds Proxmox, rendu en sous-menu repliable sous
 * « Vue d'ensemble » (remplace l'ancienne section « PROXMOX » du sidebar).
 * Liens identiques aux anciens liens sidebar : /e/{endpoint} et /e/{endpoint}/n/{node}.
 */
export function ProxmoxNavTree() {
  const { t } = useTranslation();
  const multi = useMulti();
  const eps = multi?.endpoints ?? [];
  if (eps.length === 0) return null;
  return (
    <div className="space-y-1">
      {eps.map((ep) => (
        <div key={ep.id}>
          <NavLink to={`/e/${encodeURIComponent(ep.id)}`} className={epLinkClass} title={ep.error ?? ep.name}>
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
  );
}
