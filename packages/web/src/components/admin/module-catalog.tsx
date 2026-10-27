import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { parsePluginVersion, type ModuleDef } from '@prox4u/shared';
import type { Plugin } from '../../core/plugin/types';
import { adminApi } from '../../lib/auth-api';
import { useAuth } from '../../store/auth';
import { VersionBadge } from '../ui/version-badge';

interface Props {
  /** Catalogue du serveur — UNE ENTRÉE PAR VERSION, chacune avec SON état global. */
  modules: ModuleDef[];
  /** TOUS les plugins enregistrés (toutes versions) — pour le semver affiché. */
  plugins: Plugin[];
  onDone: () => void;
}

/**
 * Catalogue global des modules : le serveur tient UNE ENTRÉE PAR VERSION
 * (v1 = id de famille, vN = `<famille>_vN`), chacune avec SON propre toggle
 * « pour tout le monde » — cliquer sur v1 n'a AUCUN effet sur v2 et réciproque.
 * TOUTES les versions sont disponibles (menu, profil, ?v=<id>) ; la plus récente
 * sert de version canonique sur l'URL partagée. Badges vN seulement en famille
 * multi-versions. Les autorisations par groupe se gèrent dans l'onglet Groupes
 * (au niveau famille).
 */
export function ModuleCatalog({ modules, plugins, onDone }: Props) {
  const { t } = useTranslation();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manifestById = new Map(plugins.map((p) => [p.manifest.id, p.manifest]));
  // Nombre d'entrées par famille (le badge vN n'a de sens qu'en multi-versions).
  const familyCounts = new Map<string, number>();
  for (const m of modules) {
    const fam = parsePluginVersion(m.id).family;
    familyCounts.set(fam, (familyCounts.get(fam) ?? 0) + 1);
  }

  async function toggle(mod: ModuleDef) {
    if (busyId) return;
    setBusyId(mod.id);
    setError(null);
    try {
      // Bascule l'entrée de CETTE version seulement (id exact, pas la famille).
      await adminApi.setModuleGlobal(mod.id, !mod.globallyEnabled);
      onDone();
      // Re-hydrate /me : le menu du sidebar de l'admin se met à jour aussitôt.
      void useAuth.getState().refresh();
    } catch {
      setError(t('admin.error.generic'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('admin.catalog.hint')}</p>
      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}
      {/* Une CARTE par entrée du serveur : chaque version a son toggle indépendant. */}
      <div className="flex flex-col gap-3">
        {modules.map((m) => {
          const manifest = manifestById.get(m.id);
          const multi = (familyCounts.get(parsePluginVersion(m.id).family) ?? 0) > 1;
          return (
            <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {m.name}
                  {/* Badge seulement si la famille a plusieurs versions (sinon c'est du bruit). */}
                  {multi && <VersionBadge pluginId={m.id} />}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {m.description}
                  {manifest && <span className="text-muted-foreground/60"> · {manifest.version}</span>}
                </div>
              </div>
              <span className="hidden text-[10px] uppercase tracking-wide text-muted-foreground sm:block">{m.id}</span>
              <button
                type="button"
                onClick={() => void toggle(m)}
                disabled={busyId !== null}
                title={t('admin.catalog.global')}
                className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-50 ${
                  m.globallyEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full bg-white shadow transition-transform ${
                    m.globallyEnabled ? 'translate-x-4' : ''
                  }`}
                >
                  {m.globallyEnabled ? (
                    <Check className="h-3 w-3 text-primary" />
                  ) : (
                    <X className="h-3 w-3 text-muted-foreground/60" />
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
