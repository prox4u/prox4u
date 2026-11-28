import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from '../../core/poller.js';
import { InfluxShardStore } from '../../core/influx-shards.js';
import { registerInfluxShardAdminRoutes } from './shard-routes.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface RouterMock {
  reload: ReturnType<typeof vi.fn>;
  forEndpoint: ReturnType<typeof vi.fn>;
}

function makeCtx(over: {
  endpoints?: Array<{ id: string; name: string }>;
  router?: RouterMock;
  store?: InfluxShardStore;
  clientUrl?: string;
  ping?: boolean;
} = {}): AppContext {
  const endpoints = over.endpoints ?? [
    { id: 'proxmox', name: 'Proxmox' },
    { id: 'cluster-b', name: 'Cluster B' },
  ];
  const router: RouterMock = over.router ?? {
    reload: vi.fn(),
    forEndpoint: vi.fn((id?: string) => ({ url: id === 'proxmox' ? 'https://a:8181' : 'https://global:8181', ping: async () => over.ping ?? true })),
  };
  const ctx = {
    config: {} as AppContext['config'],
    endpoints,
    logger,
    influx: {} as AppContext['influx'],
    influxShards: router as never,
    influxShardStore: over.store,
  } as AppContext;
  return ctx;
}

async function boot(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { id: 'u1', role: 'admin', groupIds: [] };
  });
  registerInfluxShardAdminRoutes(app, ctx);
  await app.ready();
  return app;
}

describe('admin /api/admin/influx-shards', () => {
  let dir: string;
  let store: InfluxShardStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'shard-routes-'));
    store = new InfluxShardStore(path.join(dir, 'influx-shards.json'), logger);
    store.init();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET : liste vide (dormant) + endpoints valides', async () => {
    const ctx = makeCtx({ store });
    const app = await boot(ctx);
    const res = await app.inject({ method: 'GET', url: '/api/admin/influx-shards' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      shards: [],
      endpoints: [
        { id: 'proxmox', name: 'Proxmox' },
        { id: 'cluster-b', name: 'Cluster B' },
      ],
    });
    await app.close();
  });

  it('POST : upsert un shard → persisté + router rechargé', async () => {
    const ctx = makeCtx({ store });
    const app = await boot(ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/influx-shards',
      payload: { endpointId: 'proxmox', url: 'https://a:8181' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shards).toEqual([{ endpointId: 'proxmox', url: 'https://a:8181' }]);
    expect(ctx.influxShards.reload).toHaveBeenCalledWith([{ endpointId: 'proxmox', url: 'https://a:8181' }]);
    // persisté sur disque
    expect(store.getShards()).toEqual([{ endpointId: 'proxmox', url: 'https://a:8181' }]);
    await app.close();
  });

  it('POST : endpoint inconnu → 404', async () => {
    const ctx = makeCtx({ store });
    const app = await boot(ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/influx-shards',
      payload: { endpointId: 'inconnu', url: 'https://a:8181' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('unknown-endpoint');
    await app.close();
  });

  it('POST : url invalide → 400', async () => {
    const ctx = makeCtx({ store });
    const app = await boot(ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/influx-shards',
      payload: { endpointId: 'proxmox', url: 'pas une url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-url');
    await app.close();
  });

  it('POST : slash final de l’URL normalisé', async () => {
    const ctx = makeCtx({ store });
    const app = await boot(ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/influx-shards',
      payload: { endpointId: 'proxmox', url: 'https://a:8181/' },
    });
    expect(res.json().shards).toEqual([{ endpointId: 'proxmox', url: 'https://a:8181' }]);
    await app.close();
  });

  it('DELETE /:endpointId : retire un shard + router rechargé', async () => {
    const ctx = makeCtx({ store });
    store.upsertShard({ endpointId: 'proxmox', url: 'https://a:8181' });
    store.upsertShard({ endpointId: 'cluster-b', url: 'https://b:8181' });
    const app = await boot(ctx);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/influx-shards/proxmox' });
    expect(res.statusCode).toBe(200);
    expect(res.json().shards).toEqual([{ endpointId: 'cluster-b', url: 'https://b:8181' }]);
    expect(ctx.influxShards.reload).toHaveBeenCalledWith([{ endpointId: 'cluster-b', url: 'https://b:8181' }]);
    await app.close();
  });

  it('DELETE (tout) : vide la liste + router rechargé []', async () => {
    const ctx = makeCtx({ store });
    store.upsertShard({ endpointId: 'proxmox', url: 'https://a:8181' });
    const app = await boot(ctx);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/influx-shards' });
    expect(res.statusCode).toBe(200);
    expect(res.json().shards).toEqual([]);
    expect(ctx.influxShards.reload).toHaveBeenCalledWith([]);
    await app.close();
  });

  it('POST /:endpointId/test : ping du shard configuré', async () => {
    const ctx = makeCtx({ store, ping: true });
    store.upsertShard({ endpointId: 'proxmox', url: 'https://a:8181' });
    const app = await boot(ctx);
    const res = await app.inject({ method: 'POST', url: '/api/admin/influx-shards/proxmox/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ endpointId: 'proxmox', url: 'https://a:8181', ping: true });
    await app.close();
  });

  it('POST /:endpointId/test : shard non configuré → 404 (pas de ping global trompeur)', async () => {
    const ctx = makeCtx({ store });
    const app = await boot(ctx);
    const res = await app.inject({ method: 'POST', url: '/api/admin/influx-shards/proxmox/test' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('no-shard');
    await app.close();
  });
});
