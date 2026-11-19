import { describe, expect, it } from 'vitest';
import {
  USER_CONFIG_SCHEMA_VERSION,
  addWidget,
  clearScopePage,
  clampWidgetItem,
  defaultStackLayout,
  getScopePage,
  mergePageConfig,
  parseUserConfig,
  removeWidget,
  setScopePage,
  type PageConfig,
  type UserConfig,
  type WidgetDef,
  type WidgetItem,
} from './user-config.js';

/** Catalogue statique de test (Vue d'ensemble, sans endpoints). */
const CATALOG: WidgetDef[] = [
  { id: 'res-cpu', title: 'CPU', default: { w: 4, h: 3 } },
  { id: 'res-ram', title: 'RAM', default: { w: 4, h: 3 } },
  { id: 'alerts', title: 'Alertes', default: { w: 5, h: 3 } },
];

const DEFAULT_LAYOUT: WidgetItem[] = [
  { widgetId: 'res-cpu', x: 0, y: 0, w: 4, h: 3 },
  { widgetId: 'res-ram', x: 4, y: 0, w: 4, h: 3 },
  { widgetId: 'alerts', x: 8, y: 0, w: 4, h: 3 },
];

const item = (widgetId: string, x = 0, y = 0, w = 4, h = 3): WidgetItem => ({ widgetId, x, y, w, h });

describe('clampWidgetItem', () => {
  it('conserve une géométrie valide', () => {
    expect(clampWidgetItem({ widgetId: 'a', x: 2, y: 3, w: 4, h: 3 })).toEqual({ widgetId: 'a', x: 2, y: 3, w: 4, h: 3 });
  });

  it('ramène dans les bornes (12 colonnes, h max 50)', () => {
    const c = clampWidgetItem({ widgetId: 'a', x: 99, y: -5, w: 20, h: 0 });
    expect(c.w).toBe(12);
    expect(c.x).toBe(0); // x ≤ cols − w
    expect(c.y).toBe(0);
    expect(c.h).toBe(1);
  });

  it('valeurs absentes / non numériques → défauts', () => {
    const c = clampWidgetItem({ widgetId: 'a', x: 'nope', y: NaN });
    expect(c).toEqual({ widgetId: 'a', x: 0, y: 0, w: 4, h: 3 });
  });

  it('x borné par w (jamais hors grille)', () => {
    expect(clampWidgetItem({ widgetId: 'a', x: 11, y: 0, w: 4, h: 3 }).x).toBe(8);
  });
});

describe('defaultStackLayout', () => {
  it('empile verticalement les widgets du catalogue', () => {
    const layout = defaultStackLayout(CATALOG);
    expect(layout).toEqual([
      { widgetId: 'res-cpu', x: 0, y: 0, w: 4, h: 3 },
      { widgetId: 'res-ram', x: 0, y: 3, w: 4, h: 3 },
      { widgetId: 'alerts', x: 0, y: 6, w: 5, h: 3 },
    ]);
  });
});

describe('mergePageConfig', () => {
  it('nouvel utilisateur (stored = null) → layout par défaut + bibliothèque vide', () => {
    expect(mergePageConfig(null, CATALOG, DEFAULT_LAYOUT)).toEqual({ layout: DEFAULT_LAYOUT, library: [] });
  });

  it('config cohérente → inchangée', () => {
    const stored: PageConfig = { layout: DEFAULT_LAYOUT, library: [] };
    expect(mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT)).toEqual(stored);
  });

  it('widget retiré du catalogue (code évolué) → bibliothèque', () => {
    const stored: PageConfig = {
      layout: [item('res-cpu'), item('legacy-gauge', 8, 0, 4, 3)],
      library: [],
    };
    const merged = mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT);
    expect(merged.layout.map((i) => i.widgetId).sort()).toEqual(['alerts', 'res-cpu', 'res-ram']);
    expect(merged.library).toEqual(['legacy-gauge']);
  });

  it('nouveau widget du catalogue → ajouté en fin de layout à sa taille par défaut', () => {
    const stored: PageConfig = { layout: [item('res-cpu')], library: [] };
    const merged = mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT);
    // res-ram (w4 h3) empilé à y=3, puis alerts (w5 h3) à y=6
    expect(merged.layout.map((i) => i.widgetId)).toEqual(['res-cpu', 'res-ram', 'alerts']);
    expect(merged.layout).toContainEqual({ widgetId: 'res-ram', x: 0, y: 3, w: 4, h: 3 });
    expect(merged.layout).toContainEqual({ widgetId: 'alerts', x: 0, y: 6, w: 5, h: 3 });
  });

  it('widget retiré par lutilisateur (bibliothèque) → reste dans la bibliothèque', () => {
    const stored: PageConfig = { layout: [item('res-cpu'), item('res-ram')], library: ['alerts'] };
    const merged = mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT);
    expect(merged.library).toEqual(['alerts']);
    expect(merged.layout.map((i) => i.widgetId)).toEqual(['res-cpu', 'res-ram']);
  });

  it('doublon layout/bibliothèque → le layout prime', () => {
    const stored: PageConfig = { layout: [item('res-cpu')], library: ['res-cpu'] };
    const merged = mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT);
    expect(merged.library).toEqual([]);
    expect(merged.layout.some((i) => i.widgetId === 'res-cpu')).toBe(true);
  });

  it('id inconnu dans la bibliothèque → écarté (plus dans le catalogue)', () => {
    const stored: PageConfig = { layout: [item('res-cpu'), item('res-ram')], library: ['gone-widget', 'alerts'] };
    const merged = mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT);
    expect(merged.library).toEqual(['alerts']);
  });

  it('positions utilisateur préservées (drag/resize)', () => {
    const stored: PageConfig = { layout: [item('res-cpu', 7, 2, 5, 4), item('res-ram'), item('alerts')], library: [] };
    const merged = mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT);
    expect(merged.layout.find((i) => i.widgetId === 'res-cpu')).toEqual({ widgetId: 'res-cpu', x: 7, y: 2, w: 5, h: 4 });
  });

  it('clame la géométrie des items stockés', () => {
    const stored: PageConfig = { layout: [item('res-cpu', 50, 0, 30, 3), item('res-ram'), item('alerts')], library: [] };
    const merged = mergePageConfig(stored, CATALOG, DEFAULT_LAYOUT);
    const cpu = merged.layout.find((i) => i.widgetId === 'res-cpu')!;
    expect(cpu.w).toBe(12);
    expect(cpu.x).toBe(0);
  });

  it('endpoint dynamique (catalogue élargi) → ajouté ; catalogue réduit → bibliothèque', () => {
    const withEp = [...CATALOG, { id: 'ep-prod', title: 'Prod', default: { w: 4, h: 3 } }];
    const stored: PageConfig = { layout: DEFAULT_LAYOUT, library: [] };
    const added = mergePageConfig(stored, withEp, DEFAULT_LAYOUT);
    expect(added.layout.some((i) => i.widgetId === 'ep-prod')).toBe(true);

    const removed = mergePageConfig(added, CATALOG, DEFAULT_LAYOUT);
    expect(removed.library).toEqual(['ep-prod']);
    expect(removed.layout.some((i) => i.widgetId === 'ep-prod')).toBe(false);
  });
});

describe('removeWidget / addWidget', () => {
  const page: PageConfig = {
    layout: [item('res-cpu'), item('res-ram')],
    library: [],
  };

  it('retirer → layout − widget, bibliothèque + widget', () => {
    const next = removeWidget(page, 'res-ram');
    expect(next.layout.map((i) => i.widgetId)).toEqual(['res-cpu']);
    expect(next.library).toEqual(['res-ram']);
  });

  it('réinsérer depuis la bibliothèque → fin de grille, taille par défaut, retiré de la bibliothèque', () => {
    const next = addWidget(removeWidget(page, 'res-ram'), CATALOG.find((d) => d.id === 'res-ram')!);
    expect(next.library).toEqual([]);
    const last = next.layout[next.layout.length - 1];
    expect(last).toEqual({ widgetId: 'res-ram', x: 0, y: 3, w: 4, h: 3 });
  });

  it('réinsérer un widget déjà affiché → idempotent', () => {
    const next = addWidget(page, CATALOG[0]);
    expect(next).toEqual(page);
  });
});

describe('scopes (vmView / nodeView)', () => {
  it('setScopePage / getScopePage round-trip', () => {
    const cfg: UserConfig = setScopePage(null, 'vmView', 'ep1/102', { layout: [item('cpu')], library: ['net'] });
    expect(getScopePage(cfg, 'vmView', 'ep1/102')).toEqual({ layout: [item('cpu')], library: ['net'] });
    expect(getScopePage(cfg, 'vmView', 'ep1/999')).toBeNull();
    expect(getScopePage(cfg, 'overview')).toBeNull();
  });

  it('clearScopePage supprime le scope puis la map vidée', () => {
    let cfg: UserConfig = setScopePage(null, 'vmView', 'ep1/102', { layout: [], library: [] });
    cfg = clearScopePage(cfg, 'vmView', 'ep1/102');
    expect(cfg.pages.vmView).toBeUndefined();
    expect(cfg.schemaVersion).toBe(USER_CONFIG_SCHEMA_VERSION);
  });

  it('overview : set/clear sans scope', () => {
    const cfg = setScopePage(null, 'overview', undefined, { layout: [item('res-cpu')], library: [] });
    expect(getScopePage(cfg, 'overview')).toEqual({ layout: [item('res-cpu')], library: [] });
    expect(getScopePage(clearScopePage(cfg, 'overview', undefined), 'overview')).toBeNull();
  });

  it('endpointView / nodePage (hypervision v4) : round-trip + isolation des scopes', () => {
    let cfg: UserConfig = setScopePage(null, 'endpointView', 'ep1', { layout: [item('res-cpu')], library: ['pra'] });
    cfg = setScopePage(cfg, 'nodePage', 'ep1/pve1', { layout: [item('kpi-cpu')], library: ['vms'] });
    expect(getScopePage(cfg, 'endpointView', 'ep1')).toEqual({ layout: [item('res-cpu')], library: ['pra'] });
    expect(getScopePage(cfg, 'nodePage', 'ep1/pve1')).toEqual({ layout: [item('kpi-cpu')], library: ['vms'] });
    // Isolation : nodePage ne lit pas nodeView (catalogues distincts) et inversement.
    cfg = setScopePage(cfg, 'nodeView', 'ep1/pve1', { layout: [item('system')], library: [] });
    expect(getScopePage(cfg, 'nodeView', 'ep1/pve1')).toEqual({ layout: [item('system')], library: [] });
    expect(getScopePage(cfg, 'nodePage', 'ep1/pve1')).toEqual({ layout: [item('kpi-cpu')], library: ['vms'] });
    // clearScopePage supprime le scope puis la map vidée.
    cfg = clearScopePage(cfg, 'endpointView', 'ep1');
    expect(cfg.pages.endpointView).toBeUndefined();
    expect(getScopePage(cfg, 'nodePage', 'ep1/pve1')).toEqual({ layout: [item('kpi-cpu')], library: ['vms'] });
  });

  it('vmSummary / storageView / sensorHistory : round-trip + isolation des scopes', () => {
    let cfg: UserConfig = setScopePage(null, 'vmSummary', 'ep1/103', { layout: [item('vm-os')], library: ['capacity'] });
    cfg = setScopePage(cfg, 'storageView', 'ep1/local-lvm', { layout: [item('storage-occupancy')], library: [] });
    cfg = setScopePage(cfg, 'sensorHistory', 'pve1/cpu-core-0', { layout: [], library: ['history'] });
    expect(getScopePage(cfg, 'vmSummary', 'ep1/103')).toEqual({ layout: [item('vm-os')], library: ['capacity'] });
    expect(getScopePage(cfg, 'storageView', 'ep1/local-lvm')).toEqual({ layout: [item('storage-occupancy')], library: [] });
    expect(getScopePage(cfg, 'sensorHistory', 'pve1/cpu-core-0')).toEqual({ layout: [], library: ['history'] });
    // Isolation : vmSummary ne lit pas vmView (Monitor) et inversement.
    cfg = setScopePage(cfg, 'vmView', 'ep1/103', { layout: [item('cpu')], library: [] });
    expect(getScopePage(cfg, 'vmView', 'ep1/103')).toEqual({ layout: [item('cpu')], library: [] });
    expect(getScopePage(cfg, 'vmSummary', 'ep1/103')).toEqual({ layout: [item('vm-os')], library: ['capacity'] });
    // clearScopePage supprime le scope puis la map vidée.
    cfg = clearScopePage(cfg, 'storageView', 'ep1/local-lvm');
    expect(cfg.pages.storageView).toBeUndefined();
    expect(getScopePage(cfg, 'vmSummary', 'ep1/103')).toEqual({ layout: [item('vm-os')], library: ['capacity'] });
  });
});

describe('parseUserConfig (validation serveur)', () => {
  const valid = {
    schemaVersion: USER_CONFIG_SCHEMA_VERSION,
    pages: {
      overview: { layout: [item('res-cpu')], library: ['alerts'] },
      vmView: { 'ep1/102': { layout: [item('cpu')], library: [] } },
      nodeView: { 'ep1/pve1': { layout: [], library: ['net'] } },
      endpointView: { ep1: { layout: [item('res-cpu')], library: [] } },
      nodePage: { 'ep1/pve1': { layout: [item('kpi-cpu')], library: ['vms'] } },
      vmSummary: { 'ep1/103': { layout: [item('vm-os')], library: ['capacity'] } },
      storageView: { 'ep1/local-lvm': { layout: [item('storage-occupancy')], library: [] } },
      sensorHistory: { 'pve1/cpu-core-0': { layout: [], library: ['history'] } },
    },
  };

  it('parse les scopes endpointView / nodePage (hypervision v4)', () => {
    const parsed = parseUserConfig(JSON.parse(JSON.stringify(valid)))!;
    expect(parsed.pages.endpointView?.['ep1']).toEqual({ layout: [item('res-cpu')], library: [] });
    expect(parsed.pages.nodePage?.['ep1/pve1']).toEqual({ layout: [item('kpi-cpu')], library: ['vms'] });
    // Une forme invalide dans un nouveau scope → rejet (400).
    expect(
      parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { endpointView: 'nope' } }),
    ).toBeNull();
    expect(parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { nodePage: { 'a/b': 'nope' } } })).toBeNull();
  });

  it('parse les scopes vmSummary / storageView / sensorHistory', () => {
    const parsed = parseUserConfig(JSON.parse(JSON.stringify(valid)))!;
    expect(parsed.pages.vmSummary?.['ep1/103']).toEqual({ layout: [item('vm-os')], library: ['capacity'] });
    expect(parsed.pages.storageView?.['ep1/local-lvm']).toEqual({ layout: [item('storage-occupancy')], library: [] });
    expect(parsed.pages.sensorHistory?.['pve1/cpu-core-0']).toEqual({ layout: [], library: ['history'] });
    // Une forme invalide dans un nouveau scope → rejet (400).
    expect(
      parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { vmSummary: 'nope' } }),
    ).toBeNull();
    expect(parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { sensorHistory: { 'a/b': 'nope' } } })).toBeNull();
  });

  it('accepte une config valide et clame la géométrie', () => {
    const raw = JSON.parse(JSON.stringify(valid));
    raw.pages.overview!.layout[0] = { widgetId: 'res-cpu', x: 99, y: -1, w: 99, h: 200 };
    const parsed = parseUserConfig(raw)!;
    expect(parsed).not.toBeNull();
    const i = parsed.pages.overview!.layout[0];
    expect(i.w).toBe(12);
    expect(i.x).toBe(0);
    expect(i.y).toBe(0);
    expect(i.h).toBe(50);
  });

  it('dédoublonne layout et bibliothèque', () => {
    const parsed = parseUserConfig({
      schemaVersion: USER_CONFIG_SCHEMA_VERSION,
      pages: { overview: { layout: [item('a'), item('a')], library: ['a', 'b', 'b'] } },
    })!;
    expect(parsed.pages.overview!.layout).toHaveLength(1);
    expect(parsed.pages.overview!.library).toEqual(['b']);
  });

  it('rejette : schemaVersion, forme, ids, limites', () => {
    expect(parseUserConfig(null)).toBeNull();
    expect(parseUserConfig('x')).toBeNull();
    expect(parseUserConfig({ schemaVersion: 99, pages: {} })).toBeNull();
    expect(parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: 'nope' })).toBeNull();
    expect(parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { overview: { layout: 'nope' } } })).toBeNull();
    expect(parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { overview: { layout: [{}] } } })).toBeNull();
    expect(parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { overview: { layout: [item('a')], library: [42] } } })).toBeNull();
    const big = {
      schemaVersion: USER_CONFIG_SCHEMA_VERSION,
      pages: { overview: { layout: Array.from({ length: 201 }, (_, n) => item(`w${n}`)), library: [] } },
    };
    expect(parseUserConfig(big)).toBeNull();
    expect(parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { vmView: 'nope' } })).toBeNull();
  });

  it('les pages absentes restent absentes (pas de fabrication)', () => {
    const parsed = parseUserConfig({ schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: {} })!;
    expect(Object.keys(parsed.pages)).toEqual([]);
  });
});
