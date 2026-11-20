import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeSensorsResponse, SensorHistoryResponse, SensorThresholdsResponse, SmartHistoryResponse } from '@prox4u/shared';
import { influxTsToUnix } from '../../core/influx.js';
import type { AppContext } from '../../core/poller.js';
import { registerNodeSensors, registerSensorHistoryRoute, registerSensorThresholdRoutes, registerSmartHistoryRoute } from './routes.js';
import { SensorThresholdStore } from './thresholds.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** AppContext mock : `querySql` renvoie les lignes SMART si `FROM smart_device`, les capteurs si `FROM sensors`, sinon rien. */
function makeCtx(
  dir: string,
  sensorRows: Record<string, string | number | null>[],
  smartRows: Record<string, string | number | null | boolean>[] = [],
): AppContext {
  return {
    config: { authFile: path.join(dir, 'auth.json') } as AppContext['config'],
    endpoints: [],
    logger,
    influx: {
      enabled: true,
      rawDb: 'raw',
      querySql: async (_db: string, sql: string) => {
        if (sql.includes('FROM smart_device')) return smartRows;
        if (sql.includes('FROM sensors')) return sensorRows;
        return [];
      },
    } as unknown as AppContext['influx'],
    auth: {} as AppContext['auth'],
    userConfig: {} as AppContext['userConfig'],
    hub: {} as AppContext['hub'],
  };
}

const sensorRows = [
  { node: 'proxmox', chip: 'amdgpu-pci-2300', feature: 'mem', temp_input: 70, temp_crit: 110, time: '2026-11-10T00:00:00Z' },
  { node: 'proxmox', chip: 'cpu-vid', feature: 'edge', temp_input: 45, temp_crit: 105, time: '2026-11-10T00:00:00Z' },
];

const byFeature = <T extends { feature: string }>(sensors: T[], feature: string): T => sensors.find((s) => s.feature === feature)!;

describe('registerSensorThresholdRoutes', () => {
  let dir: string;
  let app: FastifyInstance;
  let store: SensorThresholdStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sensor-thr-routes-'));
    store = new SensorThresholdStore(path.join(dir, 'sensor-thresholds.json'), logger);
    store.init();
    app = Fastify();
    registerSensorThresholdRoutes(app, makeCtx(dir, sensorRows), store);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET → capteurs avec firmware + temp, pas de seuil perso', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/sensor-thresholds' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SensorThresholdsResponse;
    expect(body.thresholds).toEqual({});
    expect(body.sensors).toHaveLength(2);
    expect(byFeature(body.sensors, 'mem')).toMatchObject({ node: 'proxmox', chip: 'amdgpu-pci-2300', temp: 70, firmware: 110, custom: null });
  });

  it('PUT clamp : perso > firmware → ramené au firmware', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/sensor-thresholds', payload: { thresholds: { 'proxmox/amdgpu-pci-2300/mem': 120 } } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SensorThresholdsResponse;
    expect(body.thresholds['proxmox/amdgpu-pci-2300/mem']).toBe(110); // clampé
    expect(byFeature(body.sensors, 'mem').custom).toBe(110);
  });

  it('PUT conserve perso < firmware', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/sensor-thresholds', payload: { thresholds: { 'proxmox/amdgpu-pci-2300/mem': 85 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().thresholds['proxmox/amdgpu-pci-2300/mem']).toBe(85);
  });

  it('PUT ignore les valeurs invalides (<= 0)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/sensor-thresholds', payload: { thresholds: { 'proxmox/amdgpu-pci-2300/mem': -5, 'proxmox/cpu-vid/edge': 0 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().thresholds).toEqual({});
  });

  it('PUT body invalide (tableau) → 400', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/sensor-thresholds', payload: { thresholds: [1, 2] } });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE :node/:chip/:feature réinitialise un seul capteur', async () => {
    await app.inject({ method: 'PUT', url: '/api/admin/sensor-thresholds', payload: { thresholds: { 'proxmox/amdgpu-pci-2300/mem': 85 } } });
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/sensor-thresholds/proxmox/amdgpu-pci-2300/mem' });
    expect(res.statusCode).toBe(200);
    expect(res.json().thresholds).toEqual({});
  });

  it('DELETE (tout) réinitialise tous les capteurs', async () => {
    await app.inject({ method: 'PUT', url: '/api/admin/sensor-thresholds', payload: { thresholds: { 'proxmox/amdgpu-pci-2300/mem': 85, 'proxmox/cpu-vid/edge': 90 } } });
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/sensor-thresholds' });
    expect(res.statusCode).toBe(200);
    expect(res.json().thresholds).toEqual({});
  });
});

describe('registerNodeSensors — merge des seuils perso dans la réponse', () => {
  it('GET /api/node-sensors expose sensorThresholds + les capteurs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sensor-thr-merge-'));
    const store = new SensorThresholdStore(path.join(dir, 'sensor-thresholds.json'), logger);
    store.init();
    store.setThresholds({ 'proxmox/amdgpu-pci-2300/mem': 85 });
    const app = Fastify();
    registerNodeSensors(app, makeCtx(dir, sensorRows), store);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/node-sensors' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NodeSensorsResponse;
    expect(body.sensorThresholds).toEqual({ 'proxmox/amdgpu-pci-2300/mem': 85 });
    expect(body.source).toBe('influx');
    expect(byFeature(body.sensors, 'mem')).toMatchObject({ tempInput: 70, tempCrit: 110 });
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('registerNodeSensors — unités systemd : seules les vraies alertes', () => {
  /** Unités telles que vues par le nœud : 1 vrai échec, 1 erreur de chargement,
   *  et les états dead NORMAUX (one-shot terminé, unité non installée). */
  const unitRows = [
    { node: 'proxmox', name: 'openipmi.service', active: 'failed', sub: 'failed', load: 'loaded', time: '2026-11-13T12:00:00Z' },
    { node: 'proxmox', name: 'broken-unit.service', active: 'inactive', sub: 'dead', load: 'error', time: '2026-11-13T12:00:00Z' },
    { node: 'proxmox', name: 'apt-daily.service', active: 'inactive', sub: 'dead', load: 'loaded', time: '2026-11-13T12:00:00Z' },
    { node: 'proxmox', name: 'NetworkManager.service', active: 'inactive', sub: 'dead', load: 'not-found', time: '2026-11-13T12:00:00Z' },
  ];

  it('le SQL filtre active=failed / load=error — plus de sub=dead (dead normal ≠ échec)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sensor-units-'));
    const seenSql: string[] = [];
    const ctx: AppContext = {
      config: { authFile: path.join(dir, 'auth.json') } as AppContext['config'],
      endpoints: [],
      logger,
      influx: {
        enabled: true,
        rawDb: 'raw',
        querySql: async (_db: string, sql: string) => {
          if (sql.includes('FROM systemd_units')) {
            seenSql.push(sql);
            return unitRows;
          }
          return [];
        },
      } as unknown as AppContext['influx'],
      auth: {} as AppContext['auth'],
      userConfig: {} as AppContext['userConfig'],
      hub: {} as AppContext['hub'],
    };
    const store = new SensorThresholdStore(path.join(dir, 'sensor-thresholds.json'), logger);
    store.init();
    const app = Fastify();
    registerNodeSensors(app, ctx, store);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/node-sensors' });
    expect(res.statusCode).toBe(200);
    // Contrat du SQL : seules les vraies alertes (le filtrage est côté requête,
    // le mock ne l'applique pas — d'où l'assertion sur le SQL lui-même).
    const sql = seenSql.find((s) => s.includes('FROM systemd_units'));
    expect(sql).toBeDefined();
    expect(sql).toContain("active = 'failed'");
    expect(sql).toContain("load = 'error'");
    expect(sql).not.toContain("sub = 'dead'");
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('registerNodeSensors — parsing SMART tri-state (vrai matériel)', () => {
  /** Disque virtuel QEMU : pas de SMART → health_ok NULL, temp_c 0. */
  const qemuRow = { node: 'ProxSite1', device: 'sda', model: 'QEMU HARDDISK', health_ok: null, temp_c: 0, time: '2026-11-10T00:00:00Z' };
  /** Volume logique RAID : pas de SMART exposé → health_ok NULL. */
  const raidRow = { node: 'proxmox', device: 'sdb', model: 'RAID5', health_ok: null, temp_c: null, time: '2026-11-10T00:00:00Z' };
  /** Disque réel PASSED. */
  const passedRow = { node: 'proxmox', device: 'nvme0n1', model: 'CT4000', health_ok: true, temp_c: 39, time: '2026-11-10T00:00:00Z' };
  /** Disque réel FAILED (panne prédictive). */
  const failedRow = { node: 'proxmox', device: 'sdc', model: 'ST1000', health_ok: false, temp_c: 45, time: '2026-11-10T00:00:00Z' };

  async function getSmart(rows: Record<string, string | number | null | boolean>[]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'smart-tristate-'));
    const store = new SensorThresholdStore(path.join(dir, 'sensor-thresholds.json'), logger);
    store.init();
    const app = Fastify();
    registerNodeSensors(app, makeCtx(dir, [], rows), store);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/node-sensors' });
    const body = res.json() as NodeSensorsResponse;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    return body.smart;
  }

  const byDevice = <T extends { device: string }>(smart: T[], device: string): T => smart.find((d) => d.device === device)!;

  it('health_ok NULL → healthOk null (inconnu, PAS critique) — disque QEMU', async () => {
    const smart = await getSmart([qemuRow]);
    expect(byDevice(smart, 'sda').healthOk).toBeNull();
  });

  it('health_ok NULL → healthOk null — volume logique RAID (vrai matériel sans SMART)', async () => {
    const smart = await getSmart([raidRow]);
    expect(byDevice(smart, 'sdb').healthOk).toBeNull();
  });

  it('health_ok true → true (SMART PASSED) ; false → false (FAILED)', async () => {
    const smart = await getSmart([passedRow, failedRow]);
    expect(byDevice(smart, 'nvme0n1').healthOk).toBe(true);
    expect(byDevice(smart, 'sdc').healthOk).toBe(false);
  });

  it('représentations numériques/chaînes : 1/0/true/false → booléen tri-state', async () => {
    const smart = await getSmart([
      { ...passedRow, device: 'a', health_ok: 1 },
      { ...failedRow, device: 'b', health_ok: 0 },
      { ...passedRow, device: 'c', health_ok: 'true' },
      { ...failedRow, device: 'd', health_ok: 'false' },
    ]);
    expect(byDevice(smart, 'a').healthOk).toBe(true);
    expect(byDevice(smart, 'b').healthOk).toBe(false);
    expect(byDevice(smart, 'c').healthOk).toBe(true);
    expect(byDevice(smart, 'd').healthOk).toBe(false);
  });

  it('temp_c 0 (disque virtuel) conservé à 0 côté API (affichage « — » géré au front)', async () => {
    const smart = await getSmart([qemuRow]);
    expect(byDevice(smart, 'sda').tempC).toBe(0);
  });
});

describe('registerSensorHistoryRoute — historique des valeurs capteur', () => {
  // raw (buckets 10 min) et consolidated (buckets 15 min) : au MÊME horodatage,
  // le point raw doit primer (résolution plus fine) — pas de double comptage.
  const rawRows = [
    { t: '2026-11-10T00:00:00Z', temp: 50 },
    { t: '2026-11-10T00:10:00Z', temp: 55 },
    { t: '2026-11-10T00:20:00Z', temp: 60 },
  ];
  const aggRows = [
    { t: '2026-11-10T00:00:00Z', temp: 42 }, // écrasé par le raw au même `t`
    { t: '2026-11-10T00:15:00Z', temp: 58 }, // uniquement consolidated
    { t: '2026-11-10T00:30:00Z', temp: 62 },
  ];
  const fwRows = [{ temp_crit: 110 }];

  /** AppContext mock : route la réponse selon le SQL (raw 10 min / agg 15 min / seuil firmware). */
  function makeHistoryCtx(
    dir: string,
    raw: Record<string, string | number | null>[],
    agg: Record<string, string | number | null>[],
    fw: Record<string, string | number | null>[],
  ): AppContext {
    return {
      config: { authFile: path.join(dir, 'auth.json') } as AppContext['config'],
      endpoints: [],
      logger,
      influx: {
        enabled: true,
        rawDb: 'raw',
        aggDb: 'consolidated',
        querySql: async (_db: string, sql: string) => {
          if (sql.includes('max(temp_crit)')) return fw;
          if (sql.includes("INTERVAL '10 minutes'")) return raw;
          if (sql.includes("INTERVAL '15 minutes'")) return agg;
          return [];
        },
      } as unknown as AppContext['influx'],
      auth: {} as AppContext['auth'],
      userConfig: {} as AppContext['userConfig'],
      hub: {} as AppContext['hub'],
    };
  }

  async function boot(
    raw: Record<string, string | number | null>[] = rawRows,
    agg: Record<string, string | number | null>[] = aggRows,
    fw: Record<string, string | number | null>[] = fwRows,
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), 'sensor-history-'));
    const store = new SensorThresholdStore(path.join(dir, 'sensor-thresholds.json'), logger);
    store.init();
    const app = Fastify();
    registerSensorHistoryRoute(app, makeHistoryCtx(dir, raw, agg, fw), store);
    await app.ready();
    return { app, store, dir };
  }

  it('merge raw + consolidated : le raw prime à t égal, série triée, seuil firmware', async () => {
    const { app, dir } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/node-sensors-history?node=proxmox&chip=k10temp-pci-00c3&feature=tctl&range=month' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SensorHistoryResponse;
    expect(body.source).toBe('influx');
    expect(body.points).toEqual([
      { time: influxTsToUnix('2026-11-10T00:00:00Z'), temp: 50 }, // raw écrase l'agg (42)
      { time: influxTsToUnix('2026-11-10T00:10:00Z'), temp: 55 },
      { time: influxTsToUnix('2026-11-10T00:15:00Z'), temp: 58 }, // consolidated seul
      { time: influxTsToUnix('2026-11-10T00:20:00Z'), temp: 60 },
      { time: influxTsToUnix('2026-11-10T00:30:00Z'), temp: 62 },
    ]);
    expect(body.threshold).toBe(110); // firmware (pas de perso)
    expect(body.thresholdCustom).toBe(false);
    expect(body.thresholdFirmware).toBe(110);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('seuil perso : threshold = perso, firmware exposé pour la 2ᵉ ligne du graphe', async () => {
    const { app, store, dir } = await boot();
    store.setThresholds({ 'proxmox/k10temp-pci-00c3/tctl': 90 });
    const res = await app.inject({ method: 'GET', url: '/api/node-sensors-history?node=proxmox&chip=k10temp-pci-00c3&feature=tctl' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SensorHistoryResponse;
    expect(body.threshold).toBe(90);
    expect(body.thresholdCustom).toBe(true);
    expect(body.thresholdFirmware).toBe(110);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('identité capteur incomplète (feature absent) → 400', async () => {
    const { app, dir } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/node-sensors-history?node=proxmox&chip=k10temp-pci-00c3' });
    expect(res.statusCode).toBe(400);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aucun point → source empty (nœud éteint / jamais vu), seuil null', async () => {
    const { app, dir } = await boot([], [], []);
    const res = await app.inject({ method: 'GET', url: '/api/node-sensors-history?node=proxmox&chip=absent&feature=tctl' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SensorHistoryResponse;
    expect(body.source).toBe('empty');
    expect(body.points).toEqual([]);
    expect(body.threshold).toBe(null);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('registerSmartHistoryRoute — historique des valeurs disque SMART', () => {
  // raw (buckets 10 min) et consolidated (buckets 15 min) : le raw prime à t égal,
  // SAUF s'il est à 0 °C (pas de capteur) — il est alors exclu de la série.
  const rawRows = [
    { t: '2026-11-10T00:00:00Z', temp: 0 }, // 0 °C = pas de lecture → exclu
    { t: '2026-11-10T00:10:00Z', temp: 38 },
    { t: '2026-11-10T00:20:00Z', temp: 40 },
  ];
  const aggRows = [
    { t: '2026-11-10T00:00:00Z', temp: 36 }, // seul au même `t` (le raw y est à 0)
    { t: '2026-11-10T00:30:00Z', temp: 42 }, // uniquement consolidated
  ];

  async function boot(
    raw: Record<string, string | number | null>[] = rawRows,
    agg: Record<string, string | number | null>[] = aggRows,
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), 'smart-history-'));
    const ctx: AppContext = {
      config: { authFile: path.join(dir, 'auth.json') } as AppContext['config'],
      endpoints: [],
      logger,
      influx: {
        enabled: true,
        rawDb: 'raw',
        aggDb: 'consolidated',
        querySql: async (_db: string, sql: string) => {
          if (sql.includes("INTERVAL '10 minutes'")) return raw;
          if (sql.includes("INTERVAL '15 minutes'")) return agg;
          return [];
        },
      } as unknown as AppContext['influx'],
      auth: {} as AppContext['auth'],
      userConfig: {} as AppContext['userConfig'],
      hub: {} as AppContext['hub'],
    };
    const app = Fastify();
    registerSmartHistoryRoute(app, ctx);
    await app.ready();
    return { app, dir };
  }

  it('merge raw + consolidated : raw prime, 0 °C (pas de capteur) exclu de la série', async () => {
    const { app, dir } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/smart-device-history?node=proxmox&device=nvme0n1&range=month' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SmartHistoryResponse;
    expect(body.source).toBe('influx');
    expect(body.points).toEqual([
      { time: influxTsToUnix('2026-11-10T00:00:00Z'), temp: 36 }, // le raw y est à 0 °C → consolidé conservé
      { time: influxTsToUnix('2026-11-10T00:10:00Z'), temp: 38 },
      { time: influxTsToUnix('2026-11-10T00:20:00Z'), temp: 40 },
      { time: influxTsToUnix('2026-11-10T00:30:00Z'), temp: 42 }, // consolidated seul
    ]);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('identité disque incomplète (device absent) → 400', async () => {
    const { app, dir } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/smart-device-history?node=proxmox' });
    expect(res.statusCode).toBe(400);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aucun point → source empty (disque sans sonde / nœud éteint)', async () => {
    const { app, dir } = await boot([], []);
    const res = await app.inject({ method: 'GET', url: '/api/smart-device-history?node=proxmox&device=sda' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SmartHistoryResponse;
    expect(body.source).toBe('empty');
    expect(body.points).toEqual([]);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
