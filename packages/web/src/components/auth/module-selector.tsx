import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { parsePluginVersion } from '@prox4u/shared';
import { VersionBadge } from '../ui/version-badge';
import { useAuth } from '../../store/auth';

/**
 * Colonne des modules : l'utilisateur ne peut cocher QUE les modules autorisés
 * (globaux ∪ groupes) — la liste est servie par /me, pas calculée ici. Une case
 * par VERSION du catalogue (le badge vN n'apparaît que si la famille a plusieurs
 * versions) : cocher v1 et/ou v2 choisit les entrées du menu de gauche. Chaque
 * bascule met à jour les préférences côté serveur.
 */
export function ModuleSelector() {
  const { t } = useTranslation();
  const user = useAuth((s) => s.user);
  const authorizedModules = useAuth((s) => s.authorizedModules);
  const toggleModule = useAuth((s) => s.toggleModule);
  const refresh = useAuth((s) => s.refresh);

  // À chaque ouverture de la rubrique, ré-hydrate le catalogue depuis le serveur :
  // un module activé/désactivé dans le catalogue admin est visible immédiatement,
  // sans action préalable sur un module existant. (refresh = référence stable du
  // store — pas de risque de boucle d'effet.)
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!user) return null;

  // Une ligne par entrée du catalogue autorisée (le serveur en tient une par
  // version : v1 = id de famille, vN = `<famille>_vN`).
  const rows = authorizedModules.map((m) => ({ module: m, pluginId: m.id }));
  // Nombre de versions par famille (pour le badge vN).
  const familyCounts = new Map<string, number>();
  for (const m of authorizedModules) {
    const fam = parsePluginVersion(m.id).family;
    familyCounts.set(fam, (familyCounts.get(fam) ?? 0) + 1);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('profile.modules.hint')}</p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          {t('profile.modules.empty')}
        </p>
      ) : (
        <div className="divide-y rounded-xl border">
          {rows.map(({ module: m, pluginId }) => {
            const checked = user.selectedModuleIds.includes(pluginId);
            const multi = (familyCounts.get(parsePluginVersion(m.id).family) ?? 0) > 1;
            return (
              <label
                key={pluginId}
                className="flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/50"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-(--color-primary)"
                  checked={checked}
                  onChange={() => void toggleModule(pluginId)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {m.name}
                    {multi && <VersionBadge pluginId={pluginId} />}
                  </span>
                  <span className="text-xs text-muted-foreground">{m.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
