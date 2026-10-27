import { defaultPluginVersion, groupPluginFamilies, parsePluginVersion } from '@prox4u/shared';
import { hostLogger, pluginLogger } from './logger';
import { registry, type PluginStatus } from './registry';
import { pluginManifestSchema, type Plugin, type PluginContext } from './types';

/** Version utilisable (active ou disponible en A/B) — satisfait les dépendances. */
function isInitialized(status: PluginStatus | undefined): boolean {
  return status === 'active' || status === 'available';
}

/**
 * Charge et initialise les plugins, sans jamais faire planter le host :
 * 1. manifeste validé (zod) ;
 * 2. dépendances vérifiées (chaque famille requise doit avoir une version active) ;
 * 3. init(ctx) dans un try/catch — un échec marque le plugin « failed »
 *    et le chargement continue avec les suivants.
 *
 * Versionnement : les plugins sont groupés par famille (`<id>` ou `<id>_vN`).
 * TOUTES les versions sont initialisées et exposées (menu, profil, ?v=<id>).
 * La version la plus récente de chaque famille porte la route canonique +
 * l'entrée de menu principale ; les autres sont en statut 'available' —
 * comparables en A/B via ?v=<id> et disponibles en rollback.
 */
export async function loadPlugins(plugins: Plugin[], ctx: PluginContext): Promise<void> {
  const byId = new Map(plugins.map((p) => [p.manifest.id, p]));
  for (const [family, ids] of groupPluginFamilies(plugins.map((p) => p.manifest.id))) {
    const activeId = defaultPluginVersion(family, ids);
    for (const id of ids) {
      const plugin = byId.get(id);
      if (!plugin) continue;

      // Manifeste validé pour toutes les versions (une v2 cassée ne doit pas passer silencieusement).
      const parsed = pluginManifestSchema.safeParse(plugin.manifest);
      if (!parsed.success) {
        registry.register(plugin);
        registry.setActive(id, false, new Error(`manifeste invalide : ${parsed.error.issues.map((i) => i.message).join(' · ')}`));
        hostLogger.error(`plugin « ${id} » : manifeste invalide`, parsed.error.issues);
        continue;
      }

      registry.register(plugin);

      try {
        // Dépendances : famille requise = une version de la famille est initialisée.
        const missing = (plugin.manifest.dependencies ?? []).filter((dep) => {
          if (isInitialized(registry.get(dep)?.status)) return false;
          const depFamily = parsePluginVersion(dep).family;
          return !plugins.some(
            (p) => parsePluginVersion(p.manifest.id).family === depFamily && isInitialized(registry.get(p.manifest.id)?.status),
          );
        });
        if (missing.length > 0) {
          throw new Error(`dépendances manquantes : ${missing.join(', ')}`);
        }

        // Logger dédié au plugin (prefixe = son id), même bus et client API partagés.
        const pluginCtx: PluginContext = { ...ctx, logger: pluginLogger(id) };
        await plugin.init(pluginCtx);
        if (id === activeId) {
          registry.setActive(id, true);
          hostLogger.info(`plugin « ${id} » v${plugin.manifest.version} canonique (route par défaut de la famille)`);
        } else {
          registry.setAvailable(id);
          hostLogger.info(`plugin « ${id} » v${plugin.manifest.version} disponible en A/B (?v=${id})`);
        }
      } catch (err) {
        registry.setActive(id, false, err);
        hostLogger.error(`plugin « ${id} » en échec — le host continue sans lui`, err);
      }
    }
  }
}

/** Cleanup : dispose() de chaque version initialisée, dans l'ordre inverse du chargement. */
export async function disposePlugins(): Promise<void> {
  const initialized = registry.initialized().slice().reverse();
  for (const plugin of initialized) {
    try {
      await plugin.dispose?.();
    } catch (err) {
      hostLogger.error(`dispose « ${plugin.manifest.id} » en échec`, err);
    }
  }
}
