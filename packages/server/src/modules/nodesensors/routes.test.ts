import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeSensorsResponse, SensorThresholdsResponse } from '@prox4u/shared';
import type { AppContext } from '../../core/poller.js';
import { registerNodeSensors, registerSensorThresholdRoutes } from './routes.js';
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
