import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InfluxClient } from './influx.js';
import {
  InfluxShardRouter,
  InfluxShardStore,
  dbOf,
  fanOutQuery,
  fanOutQueryChunked,
  shardClients,
  shardClientsWithIds,
  shardFor,
  type InfluxShardConfig,
} from './influx-shards.js';
import type { AppContext } from './poller.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Client global de test (influx désactivé : pas de fetch réel). */
function makeGlobal(): InfluxClient {
  return new InfluxClient({
    enabled: false,
    url: 'https://global:8181',
    token: '',
    rawDb: 'raw',
    aggDb: 'consolidated',
    rrdDb: 'proxmox',
    caCert: '',
    queueMax: 1000,
    flushMaxLines: 100,
    flushMaxRetries: 3,
    queryChunkDays: 30,
    queryFileLimit: 10000,
    archiveIntervalMs: 3600_000,
    archiveAgeMs: 86400_000,
    archiveDir: '/tmp',
    backupDir: '/tmp',
  });
}

const SHARD_A: InfluxShardConfig = { endpointId: 'ep-a', url: 'https://a:8181' };
const SHARD_B: InfluxShardConfig = { endpointId: 'ep-b', url: 'https://b:8181' };

describe('InfluxShardRouter', () => {
  it('dormant : aucun shard → forEndpoint retombe sur le global, all() = [global]', () => {
    const global = makeGlobal();
    const router = new InfluxShardRouter(global, globalCfg(), logger);
    router.reload([]);
    expect(router.hasShards()).toBe(false);
    expect(router.forEndpoint('ep-a')).toBe(global);
    expect(router.forEndpoint(undefined)).toBe(global);
    expect(router.all()).toEqual([global]);
    expect(router.allWithIds()).toEqual([{ client: global, endpointId: null }]);
  });

  it('forEndpoint retourne le client du shard configuré (vérifié par url)', () => {
    const global = makeGlobal();
    const router = new InfluxShardRouter(global, globalCfg(), logger);
    router.reload([SHARD_A, SHARD_B]);
    expect(router.hasShards()).toBe(true);
    expect(router.forEndpoint('ep-a').url).toBe('https://a:8181');
    expect(router.forEndpoint('ep-b').url).toBe('https://b:8181');
    // endpoint inconnu → repli global
    expect(router.forEndpoint('inconnu')).toBe(global);
  });

  it('all() = global + shards, dédupliqué par URL', () => {
    const global = makeGlobal();
    const router = new InfluxShardRouter(global, globalCfg(), logger);
    router.reload([SHARD_A, SHARD_B]);
    const all = router.all();
    expect(all.map((c) => c.url)).toEqual(['https://global:8181', 'https://a:8181', 'https://b:8181']);
  });

  it('all() ignore un shard sur l’URL du global (dédup)', () => {
    const global = makeGlobal();
    const router = new InfluxShardRouter(global, globalCfg(), logger);
    router.reload([{ endpointId: 'ep-a', url: 'https://global:8181' }]);
    expect(router.all()).toHaveLength(1);
    expect(router.all()[0]).toBe(global);
  });

  it('allWithIds : global (null) + shards (endpointId)', () => {
    const global = makeGlobal();
    const router = new InfluxShardRouter(global, globalCfg(), logger);
    router.reload([SHARD_A]);
    const ids = router.allWithIds();
    expect(ids[0]).toEqual({ client: global, endpointId: null });
    expect(ids[1].endpointId).toBe('ep-a');
    expect(ids[1].client.url).toBe('https://a:8181');
  });

  it('reload reconstruit les clients (l’ancien est arrêté)', () => {
    const global = makeGlobal();
    const router = new InfluxShardRouter(global, globalCfg(), logger);
    router.reload([SHARD_A]);
    const first = router.forEndpoint('ep-a');
    router.reload([SHARD_B]);
    expect(router.forEndpoint('ep-a')).toBe(global); // ep-a plus configuré
    expect(router.forEndpoint('ep-b').url).toBe('https://b:8181');
    expect(router.forEndpoint('ep-b')).not.toBe(first);
  });

  it('le shard hérite du token/bases du global si non précisé', () => {
    const cfg = {
      ...globalCfg(),
      enabled: true,
      token: 'tok-global',
    };
    const global = new InfluxClient(cfg);
    const router = new InfluxShardRouter(global, cfg, logger);
    router.reload([{ endpointId: 'ep-a', url: 'https://a:8181' }]);
    const c = router.forEndpoint('ep-a');
    expect(c.enabled).toBe(true); // token global hérité
    expect(c.rawDb).toBe('raw');
    expect(c.aggDb).toBe('consolidated');
    expect(c.rrdDb).toBe('proxmox');
  });

  it('le shard peut surcharger token/bases (différents du global)', () => {
    const cfg = { ...globalCfg(), enabled: true, token: 'tok-global' };
    const global = new InfluxClient(cfg);
    const router = new InfluxShardRouter(global, cfg, logger);
    router.reload([{ endpointId: 'ep-a', url: 'https://a:8181', token: 'tok-a', rawDb: 'raw-a', aggDb: 'agg-a' }]);
    const c = router.forEndpoint('ep-a');
    expect(c.enabled).toBe(true);
    expect(c.rawDb).toBe('raw-a');
    expect(c.aggDb).toBe('agg-a');
    expect(c.rrdDb).toBe('proxmox'); // non surchargé → global
  });
});

function globalCfg() {
  return {
    enabled: false, url: 'https://global:8181', token: '', rawDb: 'raw', aggDb: 'consolidated',
    rrdDb: 'proxmox', caCert: '', queueMax: 1000, flushMaxLines: 100, flushMaxRetries: 3,
    queryChunkDays: 30, queryFileLimit: 10000, archiveIntervalMs: 3600_000, archiveAgeMs: 86400_000,
    archiveDir: '/tmp', backupDir: '/tmp',
  };
}

describe('dbOf', () => {
  it('résout le nom de base selon le kind', () => {
    const c = makeGlobal();
    expect(dbOf(c, 'raw')).toBe('raw');
    expect(dbOf(c, 'agg')).toBe('consolidated');
    expect(dbOf(c, 'rrd')).toBe('proxmox');
  });
});

// ---------------------------------------------------------------------------
// Helpers de routage (ctx sans router = dormant → global)
// ---------------------------------------------------------------------------

function mockClient(url: string, over: { rows?: unknown[]; error?: Error; chunkRows?: unknown[] } = {}) {
  return {
    url,
    rawDb: 'raw',
    aggDb: 'consolidated',
    rrdDb: 'proxmox',
    enabled: true,
    querySql: vi.fn(async () => {
      if (over.error) throw over.error;
      return (over.rows ?? []) as never;
    }),
    querySqlChunked: vi.fn(async () => {
      if (over.error) throw over.error;
      return (over.chunkRows ?? over.rows ?? []) as never;
    }),
  } as unknown as InfluxClient;
}

function makeCtx(global: InfluxClient, router?: { all: () => InfluxClient[]; forEndpoint: (id?: string) => InfluxClient }): AppContext {
  return {
    config: {} as AppContext['config'],
    endpoints: [],
    logger,
    influx: global,
    influxShards: router as never,
  } as AppContext;
}

describe('helpers de routage', () => {
  it('dormant (pas de router) : shardFor/shardClients retombent sur le global', () => {
    const global = makeGlobal();
    const ctx = makeCtx(global);
    expect(shardFor(ctx, 'ep-a')).toBe(global);
    expect(shardClients(ctx)).toEqual([global]);
    expect(shardClientsWithIds(ctx)).toEqual([{ client: global, endpointId: null }]);
  });

  it('shardFor retourne le shard si configuré, sinon le global', () => {
    const global = makeGlobal();
    const shard = mockClient('https://a:8181');
    const ctx = makeCtx(global, {
      all: () => [global, shard],
      forEndpoint: (id?: string) => (id === 'ep-a' ? shard : global),
    });
    expect(shardFor(ctx, 'ep-a')).toBe(shard);
    expect(shardFor(ctx, 'ep-x')).toBe(global);
  });

  it('fanOutQuery dormant = querySql du global (1 appel)', async () => {
    const global = mockClient('https://global:8181', { rows: [{ a: 1 }] });
    const ctx = makeCtx(global);
    const rows = await fanOutQuery(ctx, 'raw', 'SELECT 1');
    expect(rows).toEqual([{ a: 1 }]);
    expect(global.querySql).toHaveBeenCalledTimes(1);
    expect(global.querySql).toHaveBeenCalledWith('raw', 'SELECT 1');
  });

  it('fanOutQuery merge les résultats de tous les clients', async () => {
    const global = mockClient('https://global:8181', { rows: [{ n: 'g' }] });
    const a = mockClient('https://a:8181', { rows: [{ n: 'a' }] });
    const b = mockClient('https://b:8181', { rows: [{ n: 'b' }] });
    const ctx = makeCtx(global, { all: () => [global, a, b], forEndpoint: () => global });
    const rows = await fanOutQuery(ctx, 'raw', 'SELECT n');
    expect(rows).toEqual([{ n: 'g' }, { n: 'a' }, { n: 'b' }]);
  });

  it('fanOutQuery tolère un client en échec (résultat partiel)', async () => {
    const global = mockClient('https://global:8181', { rows: [{ n: 'g' }] });
    const a = mockClient('https://a:8181', { rows: [{ n: 'a' }], error: new Error('down') });
    const ctx = makeCtx(global, { all: () => [global, a], forEndpoint: () => global });
    const rows = await fanOutQuery(ctx, 'raw', 'SELECT n');
    expect(rows).toEqual([{ n: 'g' }]); // a en échec → ignoré
  });

  it('fanOutQuery lève si TOUS les clients échouent', async () => {
    const global = mockClient('https://global:8181', { error: new Error('down-g') });
    const a = mockClient('https://a:8181', { error: new Error('down-a') });
    const ctx = makeCtx(global, { all: () => [global, a], forEndpoint: () => global });
    await expect(fanOutQuery(ctx, 'raw', 'SELECT n')).rejects.toThrow('down-g');
  });

  it('fanOutQueryChunked merge les tranches de tous les clients', async () => {
    const global = mockClient('https://global:8181', { chunkRows: [{ t: 1 }] });
    const a = mockClient('https://a:8181', { chunkRows: [{ t: 2 }] });
    const ctx = makeCtx(global, { all: () => [global, a], forEndpoint: () => global });
    const rows = await fanOutQueryChunked(ctx, 'agg', (_f, _t) => 'SELECT t', 0, 100);
    expect(rows).toEqual([{ t: 1 }, { t: 2 }]);
  });

  it('fanOutQueryChunked dormant = querySqlChunked du global', async () => {
    const global = mockClient('https://global:8181', { chunkRows: [{ t: 1 }] });
    const ctx = makeCtx(global);
    const rows = await fanOutQueryChunked(ctx, 'raw', (_f, _t) => 'SELECT t', 0, 100);
    expect(rows).toEqual([{ t: 1 }]);
    expect(global.querySqlChunked).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Store (data/influx-shards.json)
// ---------------------------------------------------------------------------

describe('InfluxShardStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'influx-shards-'));
    file = path.join(dir, 'influx-shards.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('init crée un fichier vide (dormant) + chmod 600', () => {
    const store = new InfluxShardStore(file, logger);
    store.init();
    expect(store.getShards()).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ shards: [] });
  });

  it('init charge un fichier existant', () => {
    writeFileSync(file, JSON.stringify({ shards: [SHARD_A] }));
    const store = new InfluxShardStore(file, logger);
    store.init();
    expect(store.getShards()).toEqual([SHARD_A]);
  });

  it('init lève si le JSON est corrompu', () => {
    writeFileSync(file, '{ pas du json');
    const store = new InfluxShardStore(file, logger);
    expect(() => store.init()).toThrow(/invalide \(JSON\)/);
  });

  it('upsertShard ajoute puis met à jour (par endpointId)', () => {
    const store = new InfluxShardStore(file, logger);
    store.init();
    store.upsertShard(SHARD_A);
    expect(store.getShards()).toEqual([SHARD_A]);
    store.upsertShard({ ...SHARD_A, token: 'tok' });
    expect(store.getShards()).toEqual([{ ...SHARD_A, token: 'tok' }]);
    // un 2e shard
    store.upsertShard(SHARD_B);
    expect(store.getShards()).toHaveLength(2);
  });

  it('deleteShard retire un shard', () => {
    const store = new InfluxShardStore(file, logger);
    store.init();
    store.upsertShard(SHARD_A);
    store.upsertShard(SHARD_B);
    const remaining = store.deleteShard('ep-a');
    expect(remaining).toEqual([SHARD_B]);
  });

  it('setShards remplace l’ensemble', () => {
    const store = new InfluxShardStore(file, logger);
    store.init();
    store.upsertShard(SHARD_A);
    store.setShards([SHARD_B]);
    expect(store.getShards()).toEqual([SHARD_B]);
  });

  it('persistance : le fichier reflète les mutations', () => {
    const store = new InfluxShardStore(file, logger);
    store.init();
    store.upsertShard(SHARD_A);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({ shards: [SHARD_A] });
  });
});
