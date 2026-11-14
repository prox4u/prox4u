/**
 * Personnalisation d'interface par utilisateur (layouts + bibliothèque de
 * widgets) — fonctions pures (testées).
 *
 * Contexte : les pages « Vue d'ensemble » (hypervision, `/`) et « Vue VM »
 * (vm-view, onglets Monitor VM / Monitor nœud) affichent des graphiques dans
 * des grilles react-grid-layout. Chaque utilisateur peut déplacer / redimensionner /
 * retirer des widgets ; un widget retiré va dans la BIBLIOTHÈQUE de sa page et
 * peut y être réinséré. La config est persistée par utilisateur côté serveur
 * (`data/user-configs/<user>.json` — GET/PUT/DELETE /api/user-config) ; ce
 * module fournit les types et les fonctions de merge / transformation pures.
 *
 * Règles de merge (« utilisateurs présents et futurs ») :
 *  - pas de config (nouvel utilisateur) → layout par défaut + bibliothèque vide ;
 *  - id présent dans la config mais plus dans le catalogue de la page (évolution
 *    du code, endpoint retiré, disque supprimé…) → déplacé dans la bibliothèque ;
 *  - id présent dans le catalogue mais absent de la config (nouveau widget,
 *    nouveau disque, nouvelle interface…) → ajouté en fin de layout à sa taille
 *    par défaut ;
 *  - doublon (même id dans layout ET bibliothèque) → le layout prime ;
 *  - schemaVersion obsolète → le serveur refuse la config (400), le client la
 *    jette (retour aux défauts).
 *
 * Scopes : `overview` = un seul layout ; `vmView` / `nodeView` = un layout par
 * scope (VM = « endpoint/vmid » — le vmid est stable au renommage ; nœud =
 * « endpoint/nomDuNœud » — le hostname est le seul identifiant nœud PVE).
 */

/** Version du schéma de config — à incrémenter à chaque changement incompatible. */
export const USER_CONFIG_SCHEMA_VERSION = 1;

/** Nombre de colonnes de la grille (breakpoint lg) — borne du clamp géométrie. */
export const USER_CONFIG_GRID_COLS = 12;

export type UserConfigPage = 'overview' | 'vmView' | 'nodeView';

/** Position / taille d'un widget dans la grille (coordonnées react-grid-layout). */
export interface WidgetItem {
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** État d'une page (ou d'un scope vmView/nodeView). */
export interface PageConfig {
  /** Widgets affichés sur la grille (position + taille). */
  layout: WidgetItem[];
  /** Widgets retirés (bibliothèque, en attente de réajout). */
  library: string[];
}

export interface UserConfig {
  schemaVersion: number;
  pages: {
    /** Vue d'ensemble (`/`) — layout unique. */
    overview?: PageConfig;
    /** Monitor VM — un layout par scope « endpoint/vmid ». */
    vmView?: Record<string, PageConfig>;
    /** Monitor nœud — un layout par scope « endpoint/nomDuNœud ». */
    nodeView?: Record<string, PageConfig>;
  };
  /** Posé par le serveur à chaque sauvegarde (ISO 8601). */
  lastUpdated: string;
}

/** Description statique d'un widget (catalogue de page) — le web rend depuis. */
export interface WidgetDef {
  id: string;
  /** Titre affiché (déjà résolu i18n au moment de la construction du catalogue). */
  title: string;
  /** Sous-titre optionnel (nom de VM / de nœud) — affiché sous le titre de carte. */
  subtitle?: string;
  /** Taille appliquée à l'ajout du widget / à sa première apparition. */
  default: { w: number; h: number };
  minW?: number;
  minH?: number;
}

/** Bornes de taille / de complexité (validation serveur + clamp défensif). */
export const MAX_LAYOUT_ITEMS = 200;
export const MAX_LIBRARY_ITEMS = 200;
export const MAX_WIDGET_ID_LEN = 64;
export const MAX_SCOPE_LEN = 128;
export const MAX_Y = 500;
export const MAX_H = 50;

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Ramène un item de grille dans les bornes autorisées (entiers, 12 colonnes).
 * Tolère les champs absents / non numériques (valeurs par défaut).
 */
export function clampWidgetItem(
  item: { widgetId: string; x?: unknown; y?: unknown; w?: unknown; h?: unknown },
  cols = USER_CONFIG_GRID_COLS,
): WidgetItem {
  const w = clampInt(item.w, 1, cols, 4);
  return {
    widgetId: item.widgetId,
    x: clampInt(item.x, 0, cols - w, 0),
    y: clampInt(item.y, 0, MAX_Y, 0),
    w,
    h: clampInt(item.h, 1, MAX_H, 3),
  };
}

/**
 * Layout par défaut générique : empilement vertical (x=0, pleine largeur par
 * défaut) — utilisé quand la page n'a pas de layout « design validé » propre.
 */
export function defaultStackLayout(catalog: WidgetDef[]): WidgetItem[] {
  let y = 0;
  return catalog.map((def) => {
    const w = clampInt(def.default.w, 1, USER_CONFIG_GRID_COLS, 12);
    const h = clampInt(def.default.h, 1, MAX_H, 3);
    const item: WidgetItem = { widgetId: def.id, x: 0, y, w, h };
    y += h;
    return item;
  });
}

/**
 * Fusion d'une PageConfig stockée avec le catalogue courant de la page.
 * C'est LA fonction « utilisateurs présents et futurs » : elle absorbe les
 * évolutions du catalogue (widgets ajoutés / retirés par le code, endpoints,
 * disques, interfaces) sans casser le travail de l'utilisateur.
 *
 * @param stored        la PageConfig du fichier utilisateur (null = jamais personnalisé)
 * @param catalog       le catalogue courant de la page (widgets statiques + dynamiques)
 * @param defaultLayout le layout « design validé » de la page (utilisé si stored = null)
 */
export function mergePageConfig(
  stored: PageConfig | null | undefined,
  catalog: WidgetDef[],
  defaultLayout: WidgetItem[],
): PageConfig {
  if (!stored) {
    // (flèche : `Array.map` passe l'index en 2ᵉ arg — ne pas l'interpréter comme `cols`)
    return { layout: defaultLayout.map((it) => clampWidgetItem(it)), library: [] };
  }
  const catalogIds = new Set(catalog.map((d) => d.id));

  // 1) Items du layout conservés (ids du catalogue uniquement) + dédoublonnage.
  const seen = new Set<string>();
  const kept: WidgetItem[] = [];
  for (const item of stored.layout) {
    if (!item || typeof item.widgetId !== 'string') continue;
    if (!catalogIds.has(item.widgetId) || seen.has(item.widgetId)) continue;
    seen.add(item.widgetId);
    kept.push(clampWidgetItem(item));
  }

  // 2) Bibliothèque : le layout prime sur la bibliothèque. Deux sources
  //    d'ids à considérer :
  //    - orphelins DU LAYOUT (ids absents du catalogue courant — endpoint
  //      retiré, widget supprimé par le code) → conservés dans la bibliothèque
  //      (ils peuvent revenir : le widget réapparaît alors dans le catalogue) ;
  //    - ids DE LA BIBLIOTHÈQUE → conservés seulement s'ils sont encore dans
  //      le catalogue (sinon écartés : pas d'accumulation de bruit).
  const library: string[] = [];
  const libSeen = new Set<string>();
  for (const item of stored.layout) {
    if (item && typeof item.widgetId === 'string' && item.widgetId.length > 0 && !catalogIds.has(item.widgetId) && !libSeen.has(item.widgetId)) {
      libSeen.add(item.widgetId);
      library.push(item.widgetId);
    }
  }
  for (const id of stored.library ?? []) {
    if (typeof id === 'string' && id.length > 0 && catalogIds.has(id) && !seen.has(id) && !libSeen.has(id)) {
      libSeen.add(id);
      library.push(id);
    }
  }

  // 3) Widgets du catalogue absents de layout ∪ bibliothèque → ajoutés en fin
  //    de grille à leur taille par défaut (nouveau widget du code, nouveau
  //    disque / interface / endpoint).
  const missing = catalog.filter((d) => !seen.has(d.id) && !libSeen.has(d.id));
  if (missing.length > 0) {
    let bottom = kept.reduce((m, i) => Math.max(m, i.y + i.h), 0);
    for (const def of missing) {
      const w = clampInt(def.default.w, 1, USER_CONFIG_GRID_COLS, 4);
      const h = clampInt(def.default.h, 1, MAX_H, 3);
      kept.push({ widgetId: def.id, x: 0, y: bottom, w, h });
      bottom += h;
    }
  }

  return { layout: kept, library };
}

/** Retire un widget de la grille → bibliothèque (retour aux défauts de la page). */
export function removeWidget(page: PageConfig, widgetId: string): PageConfig {
  return {
    layout: page.layout.filter((i) => i.widgetId !== widgetId),
    library: page.library.includes(widgetId) ? page.library : [...page.library, widgetId],
  };
}

/** Réinsère un widget depuis la bibliothèque → fin de grille, taille par défaut. */
export function addWidget(page: PageConfig, def: WidgetDef): PageConfig {
  if (page.layout.some((i) => i.widgetId === def.id)) {
    return { layout: page.layout, library: page.library.filter((id) => id !== def.id) };
  }
  const bottom = page.layout.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  const w = clampInt(def.default.w, 1, USER_CONFIG_GRID_COLS, 4);
  const h = clampInt(def.default.h, 1, MAX_H, 3);
  return {
    layout: [...page.layout, { widgetId: def.id, x: 0, y: bottom, w, h }],
    library: page.library.filter((id) => id !== def.id),
  };
}

/** PageConfig d'une page / d'un scope dans la config (null = absent du fichier). */
export function getScopePage(
  config: UserConfig | null | undefined,
  page: UserConfigPage,
  scope?: string,
): PageConfig | null {
  if (!config) return null;
  if (page === 'overview') return config.pages.overview ?? null;
  const map = page === 'vmView' ? config.pages.vmView : config.pages.nodeView;
  if (!map || !scope) return null;
  return map[scope] ?? null;
}

/** Nouvelle config avec la page / le scope positionné (base vide si config absente). */
export function setScopePage(
  config: UserConfig | null | undefined,
  page: UserConfigPage,
  scope: string | undefined,
  pageCfg: PageConfig,
): UserConfig {
  const base: UserConfig = config
    ? { schemaVersion: config.schemaVersion, pages: { ...config.pages }, lastUpdated: config.lastUpdated }
    : { schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: {}, lastUpdated: '' };
  if (page === 'overview') {
    base.pages.overview = pageCfg;
  } else {
    if (!scope) return base;
    const key = page; // 'vmView' | 'nodeView'
    const map = { ...(base.pages[key] ?? {}) };
    map[scope] = pageCfg;
    base.pages[key] = map;
  }
  return base;
}

/** Nouvelle config avec la page / le scope supprimé (map vidée → supprimée). */
export function clearScopePage(
  config: UserConfig | null | undefined,
  page: UserConfigPage,
  scope: string | undefined,
): UserConfig {
  if (!config) return { schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: {}, lastUpdated: '' };
  const base: UserConfig = { schemaVersion: config.schemaVersion, pages: { ...config.pages }, lastUpdated: config.lastUpdated };
  if (page === 'overview') {
    delete base.pages.overview;
  } else if (scope) {
    const key = page; // 'vmView' | 'nodeView'
    const map = { ...(base.pages[key] ?? {}) };
    delete map[scope];
    if (Object.keys(map).length > 0) base.pages[key] = map;
    else delete base.pages[key];
  }
  return base;
}

function parsePageConfig(raw: unknown): PageConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.layout) || r.layout.length > MAX_LAYOUT_ITEMS) return null;
  const layout: WidgetItem[] = [];
  const seen = new Set<string>();
  for (const it of r.layout) {
    if (typeof it !== 'object' || it === null) return null;
    const o = it as Record<string, unknown>;
    if (typeof o.widgetId !== 'string' || o.widgetId.length === 0 || o.widgetId.length > MAX_WIDGET_ID_LEN) return null;
    if (seen.has(o.widgetId)) continue; // doublon → le premier gagne
    seen.add(o.widgetId);
    layout.push(clampWidgetItem({ widgetId: o.widgetId, x: o.x, y: o.y, w: o.w, h: o.h }));
  }
  let library: string[] = [];
  if (r.library !== undefined) {
    if (!Array.isArray(r.library) || r.library.length > MAX_LIBRARY_ITEMS) return null;
    const libSeen = new Set<string>();
    for (const id of r.library) {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_WIDGET_ID_LEN) return null;
      if (libSeen.has(id) || seen.has(id)) continue; // doublon / déjà au layout → ignoré
      libSeen.add(id);
      library.push(id);
    }
  }
  return { layout, library };
}

/**
 * Validation structurelle stricte d'une config (utilisée par le serveur au PUT).
 * Renvoie `null` si la forme est invalide (→ 400) ; sinon la config clampée /
 * dédoublonnée. `lastUpdated` est ignoré ici (le serveur le pose).
 */
export function parseUserConfig(raw: unknown): UserConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== USER_CONFIG_SCHEMA_VERSION) return null;
  if (typeof r.pages !== 'object' || r.pages === null || Array.isArray(r.pages)) return null;
  const p = r.pages as Record<string, unknown>;
  const out: UserConfig = { schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: {}, lastUpdated: '' };

  if (p.overview !== undefined) {
    const pc = parsePageConfig(p.overview);
    if (!pc) return null;
    out.pages.overview = pc;
  }
  for (const key of ['vmView', 'nodeView'] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const map: Record<string, PageConfig> = {};
    for (const [scope, scopeRaw] of Object.entries(v as Record<string, unknown>)) {
      if (scope.length === 0 || scope.length > MAX_SCOPE_LEN) return null;
      const pc = parsePageConfig(scopeRaw);
      if (!pc) return null;
      map[scope] = pc;
    }
    out.pages[key] = map;
  }
  return out;
}
