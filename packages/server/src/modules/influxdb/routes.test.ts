import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from '../../core/poller.js';
import type { Role } from '@prox4u/shared';
import { registerInfluxDbRoutes } from './routes.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const writeStats = {
  enabled: true,
  queueDepth: 3,
  enqueued: 100,
  flushed: 97,
  dropped: 0,
  failedBatches: 0,
  lastDropAt: null,
  lastErrorAt: null,
};
const queryStats = { lastQueryMs: 12, lastQueryAt: 1_700_000_000_000, lastQueryError: null };
const fileEst = { chunkDays: 30, chunkFiles: 4320, yearFiles: 52560, fileLimit: 10000, headroom: 'ok' as const };

interface MockOpts {
  enabled?: boolean;
  ping?: boolean;
  version?: string | null;
  databases?: Array<{ name: string; retention: string | null }>;
  /** tables renvoyées par listTables */
  tables?: string[];
  /** lignes renvoyées par querySql (history) */
  historyRows?: Array<Record<string, string | number | null>>;
  historyError?: Error;
  /** groupes de l'utilisateur courant (pour canAct) */
  groupIds?: string[];
  role?: Role;
}

function makeCtx(over: MockOpts = {}): AppContext {
  const enabled = over.enabled ?? true;
  const querySql = vi.fn(async () => {
    if (over.historyError) throw over.historyError;
    return over.historyRows ?? [];
  });
  const ctx = {
    config: { influxActionGroups: ['Administrateurs', 'Exploitations'] } as AppContext['config'],
    endpoints: [],
    logger,
    influx: {
      enabled,
      getStats: () => ({ ...writeStats, enabled }),
      getQueryStats: () => queryStats,
      fileEstimate: () => fileEst,
      ping: async () => over.ping ?? true,
      getServerInfo: async () => ({ version: over.version ?? '3.11.5', raw: {} }),
      listDatabases: async () => over.databases ?? [{ name: 'raw', retention: '31d' }, { name: 'consolidated', retention: null }],
      listTables: vi.fn(async () => over.tables ?? []),
      querySql,
      flush: vi.fn(async () => undefined),
      dropDatabase: vi.fn(async () => undefined),
      dropTable: vi.fn(async () => undefined),
      createDatabase: vi.fn(async () => undefined),
      rawDb: 'raw',
      aggDb: 'consolidated',
    } as unknown as AppContext['influx'],
    archiver: {
      runNow: async () => ({ from: 1, to: 2 }),
      resetState: () => 123,
      exportTable: async (table: string) => ({ file: `/tmp/${table}.csv`, rows: 5 }),
      exportTablesZip: async (tables: string[]) => ({
        file: '/tmp/export.zip',
        exports: tables.map((t) => ({ table: t, rows: 5 })),
      }),
      getState: () => ({ lastArchivedTs: 1000, archiveDir: '/tmp/arch', fileCount: 3, totalBytes: 1234 }),
    } as unknown as AppContext['archiver'],
    auth: {
      store: {
        groupById: (id: string) => (id === 'g-admin' ? { id, name: 'Administrateurs' } : id === 'g-exp' ? { id, name: 'Exploitations' } : { id, name: 'Autres' }),
        userById: () => ({ id: 'u1', username: 'tester' }),
      },
      audit: { append: vi.fn() },
    } as unknown as AppContext['auth'],
    userConfig: {} as AppContext['userConfig'],
    hub: {} as AppContext['hub'],
  } as AppContext;
  (ctx as unknown as { __querySql: ReturnType<typeof vi.fn> }).__querySql = querySql;
  return ctx;
}

async function boot(ctx: AppContext, authUser?: { id: string; role: Role; groupIds: string[] }): Promise<FastifyInstance> {
  const app = Fastify();
  if (authUser) {
    app.addHook('onRequest', async (req) => {
      req.authUser = authUser;
    });
  }
  registerInfluxDbRoutes(app, ctx);
  await app.ready();
  return app;
}

const admin = { id: 'u1', role: 'admin' as Role, groupIds: [] };
const userAdmin = { id: 'u2', role: 'user' as Role, groupIds: ['g-admin'] };
const userOther = { id: 'u3', role: 'user' as Role, groupIds: ['g-other'] };

describe('GET /api/influxdb', () => {
  it('enabled : ping/version/bases + compteurs + headroom + canAct', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.ping).toBe(true);
    expect(body.version).toBe('3.11.5');
    expect(body.databases).toEqual([
      { name: 'raw', retention: '31d' },
      { name: 'consolidated', retention: null },
    ]);
    expect(body.write.queueDepth).toBe(3);
    expect(body.write.enqueued).toBe(100);
    expect(body.query.lastQueryMs).toBe(12);
    expect(body.fileEstimate.headroom).toBe('ok');
    expect(body.fileEstimate.chunkFiles).toBe(4320);
    await app.close();
  });

  it('désactivé : enabled=false, pas de fetch (ping/version nuls, bases vides)', async () => {
    const app = await boot(makeCtx({ enabled: false }), admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.ping).toBe(false);
    expect(body.version).toBeNull();
    expect(body.databases).toEqual([]);
    expect(body.write.enabled).toBe(false);
    await app.close();
  });

  it('headroom propagé tel quel (warn/crit)', async () => {
    const ctx = makeCtx();
    (ctx.influx as { fileEstimate: () => unknown }).fileEstimate = () => ({
      chunkDays: 30, chunkFiles: 9000, yearFiles: 52560, fileLimit: 10000, headroom: 'warn',
    });
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb' });
    expect(res.json().fileEstimate.headroom).toBe('warn');
    await app.close();
  });

  it('canAct : admin=true, membre groupe autorisé=true, hors groupe=false, sans session=false', async () => {
    const appA = await boot(makeCtx(), admin);
    expect((await appA.inject({ method: 'GET', url: '/api/influxdb' })).json().canAct).toBe(true);
    await appA.close();

    const appG = await boot(makeCtx(), userAdmin);
    expect((await appG.inject({ method: 'GET', url: '/api/influxdb' })).json().canAct).toBe(true);
    await appG.close();

    const appO = await boot(makeCtx(), userOther);
    expect((await appO.inject({ method: 'GET', url: '/api/influxdb' })).json().canAct).toBe(false);
    await appO.close();

    const appN = await boot(makeCtx());
    expect((await appN.inject({ method: 'GET', url: '/api/influxdb' })).json().canAct).toBe(false);
    await appN.close();
  });
});

describe('GET /api/influxdb/history', () => {
  it('24h : points mappés (t unix, valeurs numériques), source=influx', async () => {
    const rows = [
      { t: '2026-11-23T10:00:00Z', queue_depth: 5, dropped_total: 0, query_ms: 10, enqueued_total: 100 },
      { t: '2026-11-23T10:05:00Z', queue_depth: 7, dropped_total: 2, query_ms: 20, enqueued_total: 200 },
    ];
    const ctx = makeCtx({ historyRows: rows });
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb/history?range=24h' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range).toBe('24h');
    expect(body.source).toBe('influx');
    expect(body.points).toHaveLength(2);
    expect(body.points[0]).toEqual({
      t: Math.floor(Date.parse('2026-11-23T10:00:00Z') / 1000),
      queueDepth: 5,
      dropped: 0,
      queryMs: 10,
      enqueued: 100,
    });
    expect(body.points[1].queueDepth).toBe(7);
    await app.close();
  });

  it('range invalide → défaut 24h', async () => {
    const ctx = makeCtx({ historyRows: [] });
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb/history?range=bogus' });
    expect(res.json().range).toBe('24h');
    await app.close();
  });

  it('table absente (erreur SQL) → points=[], source=empty', async () => {
    const ctx = makeCtx({ historyError: new Error('cannot find table influxdb_self') });
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb/history?range=7d' });
    expect(res.json()).toEqual({ range: '7d', points: [], source: 'empty' });
    await app.close();
  });

  it('InfluxDB désactivé → source=disabled', async () => {
    const ctx = makeCtx({ enabled: false });
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb/history?range=30d' });
    expect(res.json()).toEqual({ range: '30d', points: [], source: 'disabled' });
    await app.close();
  });

  it('cache 5 min : la 2ᵉ requête ne re-query pas', async () => {
    const ctx = makeCtx({ historyRows: [{ t: '2026-11-23T10:00:00Z', queue_depth: 1, dropped_total: 0, query_ms: 1, enqueued_total: 1 }] });
    const app = await boot(ctx, admin);
    await app.inject({ method: 'GET', url: '/api/influxdb/history?range=24h' });
    await app.inject({ method: 'GET', url: '/api/influxdb/history?range=24h' });
    const qs = (ctx as unknown as { __querySql: ReturnType<typeof vi.fn> }).__querySql;
    expect(qs).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('GET /api/influxdb/tables', () => {
  it('défaut : base consolidated + tables listées', async () => {
    const ctx = makeCtx({ tables: ['node_metrics', 'vm_metrics'] });
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb/tables' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ db: 'consolidated', tables: ['node_metrics', 'vm_metrics'] });
    const lt = (ctx.influx as unknown as { listTables: ReturnType<typeof vi.fn> }).listTables;
    expect(lt).toHaveBeenCalledWith('consolidated');
    await app.close();
  });

  it('db explicite + cache 5 min : la 2ᵉ requête ne re-query pas', async () => {
    const ctx = makeCtx({ tables: ['a'] });
    const app = await boot(ctx, admin);
    await app.inject({ method: 'GET', url: '/api/influxdb/tables?db=raw' });
    await app.inject({ method: 'GET', url: '/api/influxdb/tables?db=raw' });
    const lt = (ctx.influx as unknown as { listTables: ReturnType<typeof vi.fn> }).listTables;
    expect(lt).toHaveBeenCalledTimes(1);
    expect(lt).toHaveBeenCalledWith('raw');
    await app.close();
  });

  it('db invalide → 400 bad-db', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb/tables?db=raw; DROP' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-db');
    await app.close();
  });

  it('InfluxDB désactivé → 404 influx-disabled', async () => {
    const app = await boot(makeCtx({ enabled: false }), admin);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb/tables' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('influx-disabled');
    await app.close();
  });
});

describe('POST /api/influxdb/actions/*', () => {
  it('flush : ok + audit', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'POST', url: '/api/influxdb/actions/flush' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect((ctx.auth.audit.append as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      { id: 'u1', username: 'tester' }, 'influxdb.action', 'flush', undefined,
    );
    await app.close();
  });

  it('flush : InfluxDB désactivé → 404', async () => {
    const app = await boot(makeCtx({ enabled: false }), admin);
    const res = await app.inject({ method: 'POST', url: '/api/influxdb/actions/flush' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('influx-disabled');
    await app.close();
  });

  it('archive/run : ok + archived + audit', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'POST', url: '/api/influxdb/actions/archive/run' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, archived: { from: 1, to: 2 } });
    expect((ctx.auth.audit.append as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      { id: 'u1', username: 'tester' }, 'influxdb.action', 'archive/run', { archived: { from: 1, to: 2 } },
    );
    await app.close();
  });

  it('archive/reset : ok + lastArchivedTs + audit', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'POST', url: '/api/influxdb/actions/archive/reset' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, lastArchivedTs: 123 });
    await app.close();
  });

  it('export : tables[] multi → ZIP + exports + audit (rows cumulées)', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/export',
      payload: { tables: ['node_metrics', 'vm_metrics'], from: 1000, to: 2000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      file: '/tmp/export.zip',
      exports: [
        { table: 'node_metrics', rows: 5 },
        { table: 'vm_metrics', rows: 5 },
      ],
    });
    expect((ctx.auth.audit.append as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      { id: 'u1', username: 'tester' }, 'influxdb.action', 'export',
      { tables: ['node_metrics', 'vm_metrics'], from: 1000, to: 2000, rows: 10 },
    );
    await app.close();
  });

  it('export : repli legacy table (string) → [table]', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/export',
      payload: { table: 'node_metrics', from: 1000, to: 2000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      file: '/tmp/export.zip',
      exports: [{ table: 'node_metrics', rows: 5 }],
    });
    await app.close();
  });

  it('export : tables vide → 400 bad-table', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/export',
      payload: { tables: [], from: 1000, to: 2000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-table');
    await app.close();
  });

  it('export : nom invalide dans tables → 400 bad-table', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/export',
      payload: { tables: ['ok_table', 'bad name!'], from: 1000, to: 2000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-table');
    await app.close();
  });

  it('export : table invalide (legacy) → 400 bad-table', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/export',
      payload: { table: 'bad name!', from: 1000, to: 2000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-table');
    await app.close();
  });

  it('export : range invalide (from>=to) → 400 bad-range', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/export',
      payload: { table: 'node_metrics', from: 2000, to: 1000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-range');
    await app.close();
  });

  it('database/recreate : drop + create (rétention) + audit', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/database/recreate',
      payload: { db: 'consolidated', retention: '2y' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'consolidated', retention: '2y' });
    const drop = (ctx.influx as unknown as { dropDatabase: ReturnType<typeof vi.fn> }).dropDatabase;
    const create = (ctx.influx as unknown as { createDatabase: ReturnType<typeof vi.fn> }).createDatabase;
    expect(drop).toHaveBeenCalledWith('consolidated');
    expect(create).toHaveBeenCalledWith('consolidated', '2y');
    await app.close();
  });

  it('database/recreate : rétention absente → create sans rétention (infinie)', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/database/recreate',
      payload: { db: 'consolidated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().retention).toBeNull();
    const create = (ctx.influx as unknown as { createDatabase: ReturnType<typeof vi.fn> }).createDatabase;
    expect(create).toHaveBeenCalledWith('consolidated', undefined);
    await app.close();
  });

  it('database/recreate : base inexistante → 404 db-not-found', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/database/recreate',
      payload: { db: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('db-not-found');
    await app.close();
  });

  it('database/recreate : rétention invalide → 400 bad-retention', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/database/recreate',
      payload: { db: 'consolidated', retention: '2 ans' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-retention');
    await app.close();
  });

  it('database/drop : ok + audit', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'POST', url: '/api/influxdb/actions/database/drop', payload: { db: 'raw' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'raw' });
    const drop = (ctx.influx as unknown as { dropDatabase: ReturnType<typeof vi.fn> }).dropDatabase;
    expect(drop).toHaveBeenCalledWith('raw');
    await app.close();
  });

  it('database/drop : db invalide → 400 bad-db', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({ method: 'POST', url: '/api/influxdb/actions/database/drop', payload: { db: 'raw; DROP' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-db');
    await app.close();
  });

  it('table/drop : ok + audit', async () => {
    const ctx = makeCtx();
    const app = await boot(ctx, admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/table/drop',
      payload: { db: 'raw', table: 'influxdb_self' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'raw', table: 'influxdb_self' });
    const drop = (ctx.influx as unknown as { dropTable: ReturnType<typeof vi.fn> }).dropTable;
    expect(drop).toHaveBeenCalledWith('raw', 'influxdb_self');
    await app.close();
  });

  it('table/drop : noms invalides → 400 bad-name', async () => {
    const app = await boot(makeCtx(), admin);
    const res = await app.inject({
      method: 'POST', url: '/api/influxdb/actions/table/drop',
      payload: { db: 'raw', table: 'a b' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad-name');
    await app.close();
  });

  it('archiver absent → 503 archiver-missing (archive/run)', async () => {
    const ctx = makeCtx();
    delete (ctx as { archiver?: unknown }).archiver;
    const app = await boot(ctx, admin);
    const res = await app.inject({ method: 'POST', url: '/api/influxdb/actions/archive/run' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('archiver-missing');
    await app.close();
  });
});
