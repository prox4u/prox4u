import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AppContext } from '../../core/poller.js';
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

/** AppContext mock : `influx` avec les méthodes consommées par la route. */
function makeCtx(over: {
  enabled?: boolean;
  ping?: boolean;
  version?: string | null;
  databases?: Array<{ name: string; retention: string | null }>;
} = {}): AppContext {
  const enabled = over.enabled ?? true;
  return {
    config: {} as AppContext['config'],
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
    } as unknown as AppContext['influx'],
    auth: {} as AppContext['auth'],
    userConfig: {} as AppContext['userConfig'],
    hub: {} as AppContext['hub'],
  };
}

async function boot(ctx: AppContext) {
  const app = Fastify();
  registerInfluxDbRoutes(app, ctx);
  await app.ready();
  return app;
}

describe('GET /api/influxdb', () => {
  it('enabled : ping/version/bases + compteurs + headroom', async () => {
    const app = await boot(makeCtx());
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
    const app = await boot(makeCtx({ enabled: false }));
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
      chunkDays: 30,
      chunkFiles: 9000,
      yearFiles: 52560,
      fileLimit: 10000,
      headroom: 'warn',
    });
    const app = await boot(ctx);
    const res = await app.inject({ method: 'GET', url: '/api/influxdb' });
    expect(res.json().fileEstimate.headroom).toBe('warn');
    await app.close();
  });
});
