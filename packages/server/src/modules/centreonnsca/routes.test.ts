import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Poller } from '../../core/poller.js';
import type { AuthContext } from '../auth/runtime.js';
import { NscaStore } from './store.js';
import { deleteCenteronService } from './provision.js';

// Mock du provisioning et de l'envoi NSCA (pas de vrai Centreon en test).
vi.mock('./provision.js', () => ({
  provisionService: vi.fn(async () => ({ ok: true, message: 'provisionné (mock)' })),
  deleteCenteronService: vi.fn(async () => ({ status: 'deleted', message: 'service supprimé (mock)' })),
}));
vi.mock('./nsca.js', () => ({
  sendNsca: vi.fn(async () => ({ ok: true, code: null, message: 'trame acceptée (mock)' })),
}));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const poller = { getMulti: () => null } as unknown as Poller;
/** Mock auth : userById('u1') → alice (les routes /ack en ont besoin). */
const auth = {
  store: { userById: (id: string) => (id === 'u1' ? { id, username: 'alice', role: 'admin' as const } : undefined) },
} as unknown as AuthContext;

describe('registerAlarmRoutes', () => {
  let dir: string;
  let app: FastifyInstance;
  let store: NscaStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nsca-routes-'));
    store = new NscaStore(path.join(dir, 'centreon-nsca.json'), logger);
    store.init();
    app = Fastify();
    // Le guard auth n'est pas enregistré en test → on pose `authUser` à la main.
    app.addHook('onRequest', async (req) => {
      (req as { authUser?: unknown }).authUser = { id: 'u1', role: 'admin', groupIds: [] };
    });
    const { registerAlarmRoutes } = await import('./routes.js');
    registerAlarmRoutes(app, store, dir, poller, auth);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function validRule(over: Record<string, unknown> = {}) {
    return {
      name: 'CPU prod',
      target: { kind: 'vm', endpointId: 'e1', vmid: 100, label: 'vm-100' },
      metric: 'cpu_pct',
      operator: '>',
      threshold: 90,
      confirmSeconds: 300,
      severity: 'crit',
      pollerId: 'linux',
      centreonHost: 'vm-100',
      centreonService: 'Prox4u-Alarm-CPU',
      messageTemplate: '{{vm}} CPU {{value}}%',
      active: true,
      ...over,
    };
  }

  it('GET /api/alarms → règles + pollers + stats + métriques dispo', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alarms' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rules).toEqual([]);
    expect(body.pollers.map((p: { id: string }) => p.id)).toEqual(['linux', 'windows', 'infra']);
    expect(body.metrics.vm).toContain('cpu_pct');
    expect(body.metrics.node).toContain('node_online');
  });

  it('POST /api/alarms/rules → crée + provisionne + upsert le mapping', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.rule.name).toBe('CPU prod');
    expect(body.rule.provisionStatus).toBe('ok');
    expect(body.provision.ok).toBe(true);
    // mapping VM→hôte créé (override manuel)
    expect(store.listMappings()).toHaveLength(1);
    expect(store.listMappings()[0].centreonHost).toBe('vm-100');
  });

  it('POST /api/alarms/rules → 400 si champs manquants', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toContain('name');
  });

  it('POST /api/alarms/rules → 409 si nom déjà pris', async () => {
    await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() });
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() });
    expect(res.statusCode).toBe(409);
  });

  it('PATCH /api/alarms/rules/:id → toggle actif', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const id = created.rule.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/alarms/rules/${id}`, payload: { active: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.active).toBe(false);
  });

  it('DELETE /api/alarms/rules/:id → supprime le service Centreon PUIS la règle (GitHub #20)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'DELETE', url: `/api/alarms/rules/${created.rule.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, centreon: 'deleted' });
    expect(store.listRules()).toHaveLength(0);
    // le service Centreon a été supprimé avec les bons args
    expect(deleteCenteronService).toHaveBeenCalledWith(
      expect.anything(), 'vm-100', 'Prox4u-Alarm-CPU', expect.anything(),
    );
  });

  it('DELETE → service absent de Centreon (not-found) → règle supprimée (idempotent)', async () => {
    vi.mocked(deleteCenteronService).mockResolvedValueOnce({ status: 'not-found', message: 'absent' });
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'DELETE', url: `/api/alarms/rules/${created.rule.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, centreon: 'not-found' });
    expect(store.listRules()).toHaveLength(0);
  });

  it('DELETE → Centreon injoignable (error) → règle conservée en « suppression en attente »', async () => {
    vi.mocked(deleteCenteronService).mockResolvedValueOnce({ status: 'error', message: 'ECONNREFUSED' });
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'DELETE', url: `/api/alarms/rules/${created.rule.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, pending: true, centreon: 'pending' });
    // la règle reste, marquée en attente
    expect(store.listRules()).toHaveLength(1);
    const r = store.ruleById(created.rule.id)!;
    expect(r.pendingDeletion).toBe(true);
    expect(r.pendingDeletionError).toBe('ECONNREFUSED');
    expect(store.listPendingDeletions()).toHaveLength(1);
  });

  it('DELETE → 404 si règle absente', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/alarms/rules/nope' });
    expect(res.statusCode).toBe(404);
    expect(deleteCenteronService).not.toHaveBeenCalled();
  });

  it('POST /api/alarms/rules/:id/test → envoie une trame de test', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'POST', url: `/api/alarms/rules/${created.rule.id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().code).toBe(0);
  });

  it('POST /api/alarms/rules/:id/provision → re-provisionne', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'POST', url: `/api/alarms/rules/${created.rule.id}/provision` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(store.ruleById(created.rule.id)!.provisionStatus).toBe('ok');
  });

  it('PUT /api/alarms/config → masque les mots de passe à la relecture', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/alarms/config',
      payload: { config: { enabled: true, clapiHost: 'central', clapiUser: 'clapi', clapiPassword: 'secret', nsca: { server: 'central', port: 5668, encrypt: true, password: 'nspass' } } },
    });
    const res = await app.inject({ method: 'GET', url: '/api/alarms/config' });
    const cfg = res.json().config;
    expect(cfg.enabled).toBe(true);
    expect(cfg.clapiHost).toBe('central');
    expect(cfg.clapiPassword).toBe('••••••'); // jamais en clair
    expect(cfg.nsca.password).toBe('••••••');
  });

  it('PUT /api/alarms/config → le masque « inchangé » conserve le mot de passe', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/alarms/config',
      payload: { config: { clapiPassword: 'secret' } },
    });
    // re-PUT avec le masque → le vrai mot de passe doit subsister
    await app.inject({
      method: 'PUT',
      url: '/api/alarms/config',
      payload: { config: { clapiPassword: '••••••', clapiUser: 'newuser' } },
    });
    expect(store.getConfig().clapiPassword).toBe('secret');
    expect(store.getConfig().clapiUser).toBe('newuser');
  });

  // --- Moteur v2 (GitHub #5) : hystérésis / suppression / ack ---

  it('POST /api/alarms/rules → persistance hystérésis + durée minimale (v2)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule({ recoveryThreshold: 80, suppressSeconds: 300 }) });
    expect(res.statusCode).toBe(201);
    const rule = res.json().rule;
    expect(rule.recoveryThreshold).toBe(80);
    expect(rule.suppressSeconds).toBe(300);
    expect(rule.acknowledgedAt).toBeNull();
    expect(rule.acknowledgedBy).toBeNull();
  });

  it('POST /api/alarms/rules → 400 si recoveryThreshold du mauvais côté (op « > »)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule({ recoveryThreshold: 95 }) }); // 95 ≥ 90
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toContain('recoveryThreshold');
  });

  it('POST /api/alarms/rules → 400 si suppressSeconds négatif', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule({ suppressSeconds: -5 }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toContain('suppressSeconds');
  });

  it('PATCH /api/alarms/rules/:id → 400 bad-recovery-threshold (incohérent avec op/seuil)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'PATCH', url: `/api/alarms/rules/${created.rule.id}`, payload: { recoveryThreshold: 95 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-recovery-threshold');
  });

  it('PATCH /api/alarms/rules/:id → recoveryThreshold null (désactive l\'hystérésis)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule({ recoveryThreshold: 80 }) })).json();
    const res = await app.inject({ method: 'PATCH', url: `/api/alarms/rules/${created.rule.id}`, payload: { recoveryThreshold: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.recoveryThreshold).toBeNull();
  });

  it('POST /api/alarms/rules/:id/ack → pose acknowledgedAt + acknowledgedBy (user session)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'POST', url: `/api/alarms/rules/${created.rule.id}/ack` });
    expect(res.statusCode).toBe(200);
    const rule = res.json().rule;
    expect(rule.acknowledgedAt).toBeTypeOf('number');
    expect(rule.acknowledgedBy).toBe('alice');
  });

  it('POST /api/alarms/rules/:id/unack → retire l\'ack', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    await app.inject({ method: 'POST', url: `/api/alarms/rules/${created.rule.id}/ack` });
    const res = await app.inject({ method: 'POST', url: `/api/alarms/rules/${created.rule.id}/unack` });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.acknowledgedAt).toBeNull();
    expect(res.json().rule.acknowledgedBy).toBeNull();
  });

  it('POST /api/alarms/rules/:id/ack → 404 si règle inconnue', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules/rule_inconnue/ack' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Métriques capteurs (GitHub #4) — validation des cibles + cibles du formulaire
// ---------------------------------------------------------------------------

describe('registerAlarmRoutes — règles capteurs (GitHub #4)', () => {
  let dir: string;
  let app: FastifyInstance;
  let store: NscaStore;
  const sensorData = {
    smart: [{ node: 'proxmox1', device: '/dev/sda', model: 'WDC', serialNo: null, healthOk: true, tempC: 35, powerOnHours: null, powerCycleCount: null, reallocatedSectors: null, pendingSectors: null, uncorrectableSectors: null, udmaCrcErrors: null, percentageUsed: null, availableSpare: null, criticalWarning: null, lastSeen: 1 }],
    sensors: [{ node: 'proxmox1', chip: 'amdgpu-pci-2300', feature: 'mem', tempInput: 70, tempCrit: 110, fanInput: null, inInput: null, lastSeen: 1 }],
    zfs: [],
    zfsPools: [{ node: 'proxmox1', arcHits: null, arcMisses: null, arcSize: null, arcCacheSize: null, poolName: 'rpool', poolState: 'ONLINE', poolSize: null, poolAllocated: null, poolFree: null, lastSeen: 1 }],
    failedUnits: [],
    units: [{ node: 'proxmox1', name: 'pve-firewall.service', active: 'active', sub: 'running', load: 'loaded', lastSeen: 1 }],
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nsca-routes-sensor-'));
    store = new NscaStore(path.join(dir, 'centreon-nsca.json'), logger);
    store.init();
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as { authUser?: unknown }).authUser = { id: 'u1', role: 'admin', groupIds: [] };
    });
    const { registerAlarmRoutes } = await import('./routes.js');
    registerAlarmRoutes(app, store, dir, poller, auth, async () => sensorData);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function sensorRule(over: Record<string, unknown> = {}) {
    return {
      name: 'SMART temp',
      target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', device: '/dev/sda', label: 'proxmox1 / /dev/sda' },
      metric: 'smart_temp_c',
      operator: '>',
      threshold: 80,
      confirmSeconds: 300,
      severity: 'crit',
      pollerId: 'linux',
      centreonHost: 'proxmox1',
      centreonService: 'Prox4u-Alarm-SMART-TEMP',
      messageTemplate: '{{vm}} SMART {{value}}°C',
      active: true,
      ...over,
    };
  }

  it('GET /api/alarms → les métriques capteurs sont dans la liste node', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alarms' });
    const body = res.json();
    for (const m of ['smart_temp_c', 'smart_health', 'sensor_temp_c', 'systemd_unit_failed', 'zfs_pool_state']) {
      expect(body.metrics.node).toContain(m);
    }
  });

  it('GET /api/alarms/targets → section sensors (smart/sensors/units/pools)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alarms/targets' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sensors.smart).toHaveLength(1);
    expect(body.sensors.smart[0].device).toBe('/dev/sda');
    expect(body.sensors.sensors[0].chip).toBe('amdgpu-pci-2300');
    expect(body.sensors.units[0].name).toBe('pve-firewall.service');
    expect(body.sensors.pools[0].poolName).toBe('rpool');
  });

  it('POST règle capteur valide → 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: sensorRule() });
    expect(res.statusCode).toBe(201);
    expect(res.json().rule.target.device).toBe('/dev/sda');
  });

  it('POST smart_temp_c sans target.device → 400 (target.device)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: sensorRule({ target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', label: 'proxmox1' } }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toContain('target.device');
  });

  it('POST sensor_temp_c sans chip/feature → 400 (chip + feature)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: sensorRule({ metric: 'sensor_temp_c', target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', label: 'proxmox1' } }) });
    expect(res.statusCode).toBe(400);
    const fields = res.json().fields;
    expect(fields).toContain('target.chip');
    expect(fields).toContain('target.feature');
  });

  it('POST systemd_unit_failed sans target.unit → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: sensorRule({ metric: 'systemd_unit_failed', target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', label: 'proxmox1' } }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toContain('target.unit');
  });

  it('POST métrique capteur avec kind=vm → 400 (target.kind)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: sensorRule({ target: { kind: 'vm', endpointId: 'e1', vmid: 100, device: '/dev/sda', label: 'vm-100' } }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.join(' ')).toContain('target.kind');
  });

  it('PATCH : changer vers une métrique capteur sans identifiant → 400 bad-sensor-target', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: sensorRule() })).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/alarms/rules/${created.rule.id}`,
      payload: { metric: 'systemd_unit_failed', target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', label: 'proxmox1' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-sensor-target');
    expect(res.json().fields).toContain('target.unit');
  });
});
