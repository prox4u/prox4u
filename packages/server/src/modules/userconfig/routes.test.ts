import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { USER_CONFIG_SCHEMA_VERSION, type UserConfig } from '@prox4u/shared';
import { UserConfigStore } from './store.js';
import { registerUserConfigRoutes } from './routes.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cfg = (pages: UserConfig['pages']): UserConfig => ({
  schemaVersion: USER_CONFIG_SCHEMA_VERSION,
  pages,
  lastUpdated: '',
});

const overviewPage = { layout: [{ widgetId: 'res-cpu', x: 0, y: 0, w: 4, h: 3 }], library: ['alerts'] };

describe('registerUserConfigRoutes', () => {
  let dir: string;
  let app: FastifyInstance;
  let store: UserConfigStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'user-config-routes-'));
    store = new UserConfigStore(path.join(dir, 'user-configs'), logger);
    store.init();
    app = Fastify();
    // Le guard global pose req.authUser en production ; le test le simule
    // (un utilisateur « u_test » par défaut).
    app.addHook('onRequest', async (req) => {
      (req as { authUser?: { id: string; role: 'user' } }).authUser = { id: 'u_test', role: 'user' };
    });
    registerUserConfigRoutes(app, store);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET sans config → config null + lastUpdated null', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/user-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'u_test', config: null, lastUpdated: null });
  });

  it('PUT valide → sauvegardé, lastUpdated posé ; GET suivant → la même config', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/user-config',
      payload: cfg({ overview: overviewPage }),
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { userId: string; config: UserConfig; lastUpdated: string };
    expect(body.userId).toBe('u_test');
    expect(body.config.pages.overview).toEqual(overviewPage);
    expect(body.lastUpdated).toBeTypeOf('string');
    expect(new Date(body.lastUpdated).getTime()).toBeGreaterThan(0);

    const get = await app.inject({ method: 'GET', url: '/api/user-config' });
    expect(get.json().config).toEqual(body.config);
    expect(get.json().lastUpdated).toBe(body.lastUpdated);
  });

  it('PUT invalide → 400 (forme, ids, bornes, schemaVersion)', async () => {
    for (const payload of [
      JSON.stringify('pas un objet'), // body = string (pas un objet)
      { schemaVersion: 99, pages: {} },
      { schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: 'nope' },
      { schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { overview: { layout: 'nope' } } },
      { schemaVersion: USER_CONFIG_SCHEMA_VERSION, pages: { overview: { layout: [{ widgetId: '', x: 0, y: 0, w: 4, h: 3 }] } } },
      {
        schemaVersion: USER_CONFIG_SCHEMA_VERSION,
        pages: { overview: { layout: [{ widgetId: 'a', x: 0, y: 0, w: 99, h: 3 }], library: [42] } },
      },
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/user-config', payload, headers: { 'content-type': 'application/json' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('bad-config');
    }
  });

  it('PUT clame la géométrie (pas de 400 pour un w hors borne)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/user-config',
      payload: cfg({ overview: { layout: [{ widgetId: 'res-cpu', x: 99, y: -1, w: 99, h: 200 }], library: [] } }),
    });
    expect(put.statusCode).toBe(200);
    const item = (put.json() as { config: UserConfig }).config.pages.overview!.layout[0];
    expect(item).toEqual({ widgetId: 'res-cpu', x: 0, y: 0, w: 12, h: 50 });
  });

  it('DELETE → réinitialisation (GET suivant → null)', async () => {
    await app.inject({ method: 'PUT', url: '/api/user-config', payload: cfg({ overview: overviewPage }) });
    const del = await app.inject({ method: 'DELETE', url: '/api/user-config' });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ userId: 'u_test', config: null, lastUpdated: null });
    const get = await app.inject({ method: 'GET', url: '/api/user-config' });
    expect(get.json().config).toBeNull();
  });

  it('sans session (pas d’authUser) → 401', async () => {
    const anon = Fastify();
    registerUserConfigRoutes(anon, store);
    await anon.ready();
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await anon.inject({ method, url: '/api/user-config' });
      expect(res.statusCode).toBe(401);
    }
    await anon.close();
  });
});
