import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Poller } from '../../core/poller.js';
import { NscaStore } from './store.js';

// Mock du provisioning et de l'envoi NSCA (pas de vrai Centreon en test).
vi.mock('./provision.js', () => ({
  provisionService: vi.fn(async () => ({ ok: true, message: 'provisionné (mock)' })),
}));
vi.mock('./nsca.js', () => ({
  sendNsca: vi.fn(async () => ({ ok: true, code: null, message: 'trame acceptée (mock)' })),
}));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const poller = { getMulti: () => null } as unknown as Poller;

describe('registerAlarmRoutes', () => {
  let dir: string;
  let app: FastifyInstance;
  let store: NscaStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nsca-routes-'));
    store = new NscaStore(path.join(dir, 'centreon-nsca.json'), logger);
    store.init();
    app = Fastify();
    const { registerAlarmRoutes } = await import('./routes.js');
    registerAlarmRoutes(app, store, dir, poller);
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

  it('DELETE /api/alarms/rules/:id → supprime', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/alarms/rules', payload: validRule() })).json();
    const res = await app.inject({ method: 'DELETE', url: `/api/alarms/rules/${created.rule.id}` });
    expect(res.statusCode).toBe(200);
    expect(store.listRules()).toHaveLength(0);
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
});
