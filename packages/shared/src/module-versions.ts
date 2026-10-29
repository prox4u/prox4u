/**
 * Versionnement des modules (plugins) — fonctions pures (testées).
 *
 * Convention : toute modification d'un module existant crée un NOUVEAU plugin
 * `<id>_vN+1` (ex. `vm-view` → `vm-view_v2`). On ne modifie jamais
 * une version en place ; la v1 reste disponible en rollback. TOUTES les
 * versions sont exposées (menu, profil, ?v=<id>) ; la plus récente sert de
 * version canonique par défaut sur l'URL partagée de la famille.
 *
 * - famille : id du plugin sans le suffixe `_vN` (`vm-view_v2` → `vm-view`)
 * - version : N du suffixe, ou 1 pour l'id de base
 */

/** Id de plugin valide : minuscules/chiffres/tirets + suffixe de version optionnel. */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(?:_v\d+)?$/;

const VERSION_SUFFIX_RE = /^(.+)_v(\d+)$/;

export interface PluginVersionRef {
  /** famille (id sans suffixe) — correspond à l'id du module dans le catalogue auth */
  family: string;
  /** numéro de version (1 pour l'id de base) */
  version: number;
}

/** Décompose un id de plugin en famille + version. */
export function parsePluginVersion(id: string): PluginVersionRef {
  const m = VERSION_SUFFIX_RE.exec(id);
  if (m) return { family: m[1], version: Number(m[2]) };
  return { family: id, version: 1 };
}

/**
 * Version canonique d'une famille : la version la plus RÉCENTE enregistrée —
 * c'est elle qui est servie par défaut sur l'URL partagée. Les versions
 * antérieures restent accessibles via `?v=<id de plugin>` (comparaison A/B).
 */
export function defaultPluginVersion(family: string, availableIds: string[]): string {
  const sorted = [...availableIds].sort(
    (a, b) => parsePluginVersion(b).version - parsePluginVersion(a).version,
  );
  return sorted[0] ?? family;
}

/**
 * Groupe des ids de plugins par famille (triées par version croissante).
 * Renvoie un tableau [famille, ids] stable (ordre d'insertion des familles).
 */
export function groupPluginFamilies(ids: string[]): Array<[string, string[]]> {
  const map = new Map<string, string[]>();
  for (const id of ids) {
    const { family } = parsePluginVersion(id);
    const list = map.get(family) ?? [];
    list.push(id);
    map.set(family, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => parsePluginVersion(a).version - parsePluginVersion(b).version);
  }
  return [...map.entries()];
}
