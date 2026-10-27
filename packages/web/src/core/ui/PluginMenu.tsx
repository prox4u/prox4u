import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { parsePluginVersion } from '@prox4u/shared';
import { registry } from '../plugin/registry';
import { useAuth } from '../../store/auth';
import { VersionBadge } from '../../components/ui/version-badge';

/** Même style que les liens du sidebar (cohérence visuelle). */
const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
  }`;

/**
 * Entrées de menu construites depuis le registry : UNE entrée par version
 * VISIBLE pour l'utilisateur (autorisée ET sélectionnée dans Mon profil →
 * Modules), triées par `order`. La version canonique porte le lien canonique ;
 * les autres pointent vers `?v=<id de plugin>` (VersionSwitch). Le badge vN
 * n'apparaît que si la famille a plusieurs versions (sinon c'est du bruit).
 */
export function PluginMenu() {
  const { t } = useTranslation();
  // Ids de versions EXACTS visibles (autorisées ∩ sélection profil) : une entrée
  // de menu par version visible.
  const visibleVersionIds = useAuth((s) => s.visibleVersionIds);
  const location = useLocation();

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
        return (
          <NavLink key={`${item.pluginId}:${item.id}`} to={to} className={linkClass({ isActive })}>
            {item.icon && <item.icon className="h-4 w-4 shrink-0" />}
            {t(item.labelKey)}
            {(versionCounts.get(family) ?? 0) > 1 && <VersionBadge pluginId={item.pluginId} />}
          </NavLink>
        );
      })}
    </>
  );
}
