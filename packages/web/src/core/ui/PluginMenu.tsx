import { ChevronDown, ChevronRight } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { parsePluginVersion } from '@prox4u/shared';
import { registry } from '../plugin/registry';
import { useAuth } from '../../store/auth';
import { useLayout } from '../../store/layout';
import { VersionBadge } from '../../components/ui/version-badge';

/** Même style que les liens du sidebar (cohérence visuelle). `withChevron` :
 *  coin droit arrondi (le chevron fait la seconde moitié de la pilule). */
const linkClass = ({ isActive, withChevron = false }: { isActive: boolean; withChevron?: boolean }) =>
  `flex flex-1 items-center gap-2.5 px-2.5 py-2 text-sm font-medium transition-colors ${
    withChevron ? 'rounded-l-lg' : 'rounded-lg'
  } ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`;

/**
 * Entrées de menu construites depuis le registry : UNE entrée par version
 * VISIBLE pour l'utilisateur (autorisée ET sélectionnée dans Mon profil →
 * Modules), triées par `order`. La version canonique porte le lien canonique ;
 * les autres pointent vers `?v=<id de plugin>` (VersionSwitch). Le badge vN
 * n'apparaît que si la famille a plusieurs versions (sinon c'est du bruit).
 *
 * Entrées avec `submenu` (ex. « Vue d'ensemble » → arbre endpoints/nœuds) :
 * un chevron dédié bascule le sous-menu (état persisté, replié par défaut) —
 * le clic sur le label navigue toujours, sans basculer.
 */
export function PluginMenu() {
  const { t } = useTranslation();
  // Ids de versions EXACTS visibles (autorisées ∩ sélection profil) : une entrée
  // de menu par version visible.
  const visibleVersionIds = useAuth((s) => s.visibleVersionIds);
  const location = useLocation();
  const navTreeExpanded = useLayout((s) => s.navTreeExpanded);
  const toggleNavTree = useLayout((s) => s.toggleNavTree);

  // Familles ayant plusieurs versions initialisées → seules elles affichent le badge.
  const versionCounts = new Map<string, number>();
  for (const p of registry.initialized()) {
    const family = parsePluginVersion(p.manifest.id).family;
    versionCounts.set(family, (versionCounts.get(family) ?? 0) + 1);
  }

  const activeIds = new Set(registry.active().map((p) => p.manifest.id));
  const items = registry
    .initialized()
    .filter((p) => visibleVersionIds.includes(p.manifest.id))
    .flatMap((p) => (p.manifest.menu ?? []).map((item) => ({ ...item, pluginId: p.manifest.id })))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  return (
    <>
      {items.map((item) => {
        const family = parsePluginVersion(item.pluginId).family;
        const isActiveVersion = activeIds.has(item.pluginId);
        const to = isActiveVersion ? item.to : `${item.to}${item.to.includes('?') ? '&' : '?'}v=${item.pluginId}`;
        // NavLink ne compare que le pathname → on gère l'active sur pathname + search.
        const [path, search] = to.split('?');
        const isActive = location.pathname === path && (search ? location.search === `?${search}` : location.search === '');
        const label = (
          <NavLink to={to} className={linkClass({ isActive, withChevron: !!item.submenu })}>
            {item.statusDot && <item.statusDot />}
            {item.icon && <item.icon className="h-4 w-4 shrink-0" />}
            {t(item.labelKey)}
            {(versionCounts.get(family) ?? 0) > 1 && <VersionBadge pluginId={item.pluginId} />}
          </NavLink>
        );
        if (!item.submenu) return <div key={`${item.pluginId}:${item.id}`}>{label}</div>;
        return (
          <div key={`${item.pluginId}:${item.id}`}>
            <div className="flex items-center">
              {label}
              <button
                type="button"
                onClick={toggleNavTree}
                aria-expanded={navTreeExpanded}
                aria-label={navTreeExpanded ? t('nav.tree.collapse') : t('nav.tree.expand')}
                className="rounded-r-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {navTreeExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            </div>
            {navTreeExpanded && (
              <div className="ml-3 mt-1 border-l border-border pl-2">{item.submenu}</div>
            )}
          </div>
        );
      })}
    </>
  );
}
