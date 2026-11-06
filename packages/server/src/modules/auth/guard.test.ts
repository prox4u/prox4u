import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { User } from '@prox4u/shared';
import { hashPassword } from './password.js';
import { SessionStore, SESSION_COOKIE } from './session.js';
import { AuthStore } from './store.js';
import { LocalProvider } from './providers.js';
import { registerAuthGuard } from './guard.js';
import type { AuthContext } from './runtime.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('registerAuthGuard', () => {
  let dir: string;
  let app: FastifyInstance;
  let auth: AuthContext;
  let admin: User;
  let user: User;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'auth-guard-'));
    const store = new AuthStore(path.join(dir, 'auth.json'), logger);
    await store.init(hashPassword);
    admin = store.listUsers().find((u) => u.role === 'admin')!;
    user = store.createUser({
      username: 'carol',
      displayName: 'Carol',
      passwordHash: await hashPassword('carol1234'),
      role: 'user',
      groupIds: [],
    });
    auth = { store, sessions: new SessionStore(3_600_000), provider: new LocalProvider(store) };
    app = Fastify();
    registerAuthGuard(app, auth);
    // routes dummy pour tester le filtrage du guard
    app.get('/api/admin/state', async () => ({ ok: 'admin' }));
    app.get('/api/alarms/config', async () => ({ ok: 'config-read' }));
    app.put('/api/alarms/config', async () => ({ ok: 'config-write' }));
    app.get('/api/dashboard', async () => ({ ok: 'dash' }));
    app.post('/api/auth/login', async () => ({ ok: 'login' }));
    app.get('/api/health', async () => ({ ok: 'health' }));
    app.get('/sample', async () => 'sample-page');
    app.get('/public-spa', async () => 'spa');
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cookie = (u: User) => `${SESSION_COOKIE}=${auth.sessions.create(u.id)}`;

  it('public : /api/auth/login et /api/health passent sans session', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/login' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('sans session → 401 sur toute route protégée', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/sample' })).statusCode).toBe(401);
  });

  it('avec session non-admin → les routes de module passent', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: cookie(user) } })).statusCode).toBe(200);
    // lecture de la config alarms reste accessible (masquée)
    expect((await app.inject({ method: 'GET', url: '/api/alarms/config', headers: { cookie: cookie(user) } })).statusCode).toBe(200);
  });

  it('PUT /api/alarms/config réservé aux admins (403 non-admin, 200 admin)', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/alarms/config', headers: { cookie: cookie(user) } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/alarms/config', headers: { cookie: cookie(admin) } })).statusCode).toBe(200);
  });

  it('/api/admin/* réservé aux admins', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/state', headers: { cookie: cookie(user) } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/state', headers: { cookie: cookie(admin) } })).statusCode).toBe(200);
  });

  it('/sample exige une session (plus de contenu public)', async () => {
    expect((await app.inject({ method: 'GET', url: '/sample' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/sample', headers: { cookie: cookie(user) } });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('sample-page');
  });

  it('les statiques / SPA restent publiques', async () => {
    expect((await app.inject({ method: 'GET', url: '/public-spa' })).statusCode).toBe(200);
  });

  it('compte désactivé → session invalidée immédiatement', async () => {
    const tok = auth.sessions.create(user.id);
    auth.store.updateUser(user.id, { active: false });
    expect((await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: `${SESSION_COOKIE}=${tok}` } })).statusCode).toBe(401);
  });
});
