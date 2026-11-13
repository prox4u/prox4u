import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeDiskioResponse, NodeNetResponse, NodeSystemResponse } from '@prox4u/shared';
import type { AppContext } from '../../core/poller.js';
import { diskioRateSql, diskioRowsToDevices, netRateSql, registerNodeSystemRoutes } from './system-routes.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** AppContext mock : `querySql` routé par un fragment du SQL, SQL capturés dans `sqlLog`. */
function makeCtx(dir: string, routes: Record<string, (sql: string) => unknown[]>, sqlLog?: string[]): AppContext {
  return {
    config: { authFile: path.join(dir, 'auth.json') } as AppContext['config'],
    endpoints: [],
    logger,
    influx: {
      enabled: true,
      rawDb: 'raw',
      querySql: async (_db: string, sql: string) => {
        for (const [frag, fn] of Object.entries(routes)) {
          if (sql.includes(frag)) {
            sqlLog?.push(sql);
            return fn(sql);
          }
        }
        return [];
      },
    } as unknown as AppContext['influx'],
    auth: {} as AppContext['auth'],
    hub: {} as AppContext['hub'],
  };
}

// --- Aides pures ------------------------------------------------------------------------

describe('diskioRateSql', () => {
  it('contrat : where inséré tel quel, bucket, LAG par device, busy % depuis io_time', () => {
    const sql = diskioRateSql("node = 'proxmox' AND name NOT LIKE 'dm-%'", '5 minutes', 300, '24 hours');
    expect(sql).toContain("node = 'proxmox' AND name NOT LIKE 'dm-%'");
    expect(sql).toContain("date_bin(INTERVAL '5 minutes', time)");
    expect(sql).toContain("time >= now() - INTERVAL '24 hours'");
    expect(sql).toContain('LAG(rb) OVER w');
    expect(sql).toContain('/ 300.0'); // débits / durée de bucket
    expect(sql).toContain('300000.0'); // io_time en ms → / durée
    expect(sql).toContain('MAX(io_time)'); // busy = Δ occupation réelle (pas weighted)
    expect(sql).toContain('PARTITION BY name ORDER BY t');
  });
});

describe('netRateSql', () => {
  it('contrat : where inséré tel quel, bucket, LAG des counters par interface', () => {
    const sql = netRateSql(`node = 'proxmox' AND "interface" NOT LIKE 'vnet%'`, '5 minutes', 300, '24 hours');
    expect(sql).toContain(`node = 'proxmox' AND "interface" NOT LIKE 'vnet%'`);
    expect(sql).toContain("date_bin(INTERVAL '5 minutes', time)");
    expect(sql).toContain("time >= now() - INTERVAL '24 hours'");
    expect(sql).toContain('MAX(bytes_recv)');
    expect(sql).toContain('MAX(bytes_sent)');
    expect(sql).toContain('LAG(rb) OVER w');
    expect(sql).toContain('/ 300.0'); // débits (octets/s) / durée de bucket
    expect(sql).toContain('PARTITION BY iface ORDER BY t');
    expect(sql).toContain('"interface" AS iface');
  });
});

describe('diskioRowsToDevices', () => {
  it('exclut les partitions, rend null les deltas négatifs (reset counter), trie par temps', () => {
    const rows = [
      { t: '2026-11-13T12:00:00Z', name: 'nvme0n1', read_bps: 1000, write_bps: -5, iops: 2, busy_pct: 0.5, await_ms: 3 },
      { t: '2026-11-13T11:55:00Z', name: 'sda1', read_bps: 999, write_bps: 1, iops: 1, busy_pct: 1, await_ms: 1 },
      { t: '2026-11-13T11:55:00Z', name: 'sda', read_bps: 500, write_bps: 0, iops: null, busy_pct: 0, await_ms: null },
    ];
    const devs = diskioRowsToDevices(rows);
    expect(devs.map((d) => d.device)).toEqual(['sda', 'nvme0n1']); // sda1 = partition → exclue
    expect(devs.find((d) => d.device === 'nvme0n1')).toMatchObject({ readBps: 1000, writeBps: null, iops: 2, busyPct: 0.5, awaitMs: 3 });
  });
});

// --- GET /api/node-system -----------------------------------------------------------------

describe('GET /api/node-system', () => {
  let dir: string;
  let app: FastifyInstance;

  const sysRows = [
    { node: 'proxmox', load1: 5.5, load5: 4.2, load15: 3.1, n_cpus: 24, uptime: 9378, time: '2026-11-13T14:40:00Z' },
    { node: 'proxmox', load1: 1, load5: 1, load15: 1, n_cpus: 24, uptime: 100, time: '2026-11-13T14:39:50Z' }, // plus ancien → ignoré
    { node: 'ProxSite1', load1: 0.4, load5: 0.5, load15: 0.6, n_cpus: 8, uptime: 8880, time: '2026-11-13T14:40:00Z' },
  ];
  const memRows = [
    { node: 'proxmox', swap_total: 8589930496, swap_free: 8589926400, time: '2026-11-13T14:40:00Z' },
    { node: 'ProxSite1', swap_total: 0, swap_free: 0, time: '2026-11-13T14:40:00Z' },
  ];
  const cpuRows = [
    { node: 'proxmox', cpu: 'cpu-total', usage_user: 10, usage_system: 5, usage_iowait: 2, usage_idle: 83, time: '2026-11-13T14:40:00Z' },
    { node: 'proxmox', cpu: 'cpu0', usage_user: 50, usage_system: 10, usage_iowait: 5, usage_idle: 35, time: '2026-11-13T14:40:00Z' },
    { node: 'proxmox', cpu: 'cpu1', usage_user: 1, usage_system: 1, usage_iowait: 0, usage_idle: 98, time: '2026-11-13T14:40:00Z' },
  ];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sys-routes-'));
    app = Fastify();
    registerNodeSystemRoutes(
      app,
      makeCtx(dir, {
        'FROM system': () => sysRows,
        'FROM mem': () => memRows,
        'FROM cpu': () => cpuRows,
      }),
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('merge dernier point par nœud : load + swap + CPU total + cœurs (pas cpu-total)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/node-system' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NodeSystemResponse;
    expect(body.source).toBe('influx');
    expect(body.nodes).toHaveLength(2);
    const proxmox = body.nodes.find((n) => n.node === 'proxmox')!;
    expect(proxmox.load1).toBe(5.5); // le point le plus récent gagne
    expect(proxmox.nCpus).toBe(24);
    expect(proxmox.iowaitPct).toBe(2);
    expect(proxmox.swapTotalBytes).toBe(8589930496);
    expect(proxmox.swapUsedBytes).toBe(4096);
    expect(proxmox.swapPct).toBeCloseTo(0.0000477, 5);
    expect(proxmox.cores).toHaveLength(2);
    expect(proxmox.cores[0]).toMatchObject({ core: 'cpu0', usagePct: 60 }); // 100 − idle 35 − iowait 5
    const site1 = body.nodes.find((n) => n.node === 'ProxSite1')!;
    expect(site1.swapPct).toBeNull(); // pas de swap configuré → null
    expect(site1.cores).toEqual([]);
  });

  it('InfluxDB indisponible → empty', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'sys-routes-'));
    const ctx2 = makeCtx(dir2, {});
    (ctx2.influx as { enabled: boolean }).enabled = false;
    const app2 = Fastify();
    registerNodeSystemRoutes(app2, ctx2);
    await app2.ready();
    const res = await app2.inject({ method: 'GET', url: '/api/node-system' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nodes: [], source: 'empty' });
    await app2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});

// --- GET /api/node-diskio -----------------------------------------------------------------

describe('GET /api/node-diskio', () => {
  let dir: string;
  let app: FastifyInstance;
  let sqlLog: string[];

  const diskioRows = [
    { t: '2026-11-13T12:00:00Z', name: 'nvme0n1', read_bps: 1e6, write_bps: 5e5, iops: 10, busy_pct: 12, await_ms: 4 },
    { t: '2026-11-13T12:00:00Z', name: 'sda1', read_bps: 9e5, write_bps: 0, iops: 1, busy_pct: 5, await_ms: 1 },
  ];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'diskio-routes-'));
    sqlLog = [];
    app = Fastify();
    registerNodeSystemRoutes(app, makeCtx(dir, { 'FROM diskio': () => diskioRows }, sqlLog));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('400 sans node ou timeframe invalide', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/node-diskio' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/node-diskio?node=proxmox&timeframe=decade' })).statusCode).toBe(400);
  });

  it('contrat SQL (nœud, exclusions dm/loop/md, bucket du tf) + devices physiques seulement', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/node-diskio?node=proxmox&timeframe=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NodeDiskioResponse;
    expect(body.source).toBe('influx');
    expect(body.devices.map((d) => d.device)).toEqual(['nvme0n1']); // sda1 = partition → exclue
    const sql = sqlLog.find((s) => s.includes('FROM diskio'));
    expect(sql).toBeDefined();
    expect(sql).toContain("node = 'proxmox'");
    expect(sql).toContain("NOT LIKE 'dm-%'");
    expect(sql).toContain("NOT LIKE 'loop%'");
    expect(sql).toContain("INTERVAL '5 minutes'"); // bucket day
    expect(sql).toContain("INTERVAL '24 hours'");
    expect(sql).toContain('/ 300.0');
  });
});

// --- GET /api/node-net --------------------------------------------------------------------

describe('GET /api/node-net', () => {
  let dir: string;
  let app: FastifyInstance;
  let sqlLog: string[];

  const netRows = [
    { t: '2026-11-13T12:00:00Z', iface: 'vmbr0', in_bps: 1e7, out_bps: 2e7 },
    { t: '2026-11-13T12:00:00Z', iface: 'enp1s0f0', in_bps: 5e6, out_bps: -1 }, // delta négatif → null
  ];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'node-net-routes-'));
    sqlLog = [];
    app = Fastify();
    registerNodeSystemRoutes(app, makeCtx(dir, { 'FROM net': () => netRows }, sqlLog));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('400 sans node ou timeframe invalide', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/node-net' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/node-net?node=proxmox&timeframe=decade' })).statusCode).toBe(400);
  });

  it('contrat SQL (exclusions tap des VMs + lo) + lignes triées, delta négatif → null', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/node-net?node=proxmox&timeframe=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NodeNetResponse;
    expect(body.source).toBe('influx');
    expect(body.node).toBe('proxmox');
    expect(body.rows).toEqual([
      { t: 1794571200, iface: 'enp1s0f0', inBps: 5e6, outBps: null },
      { t: 1794571200, iface: 'vmbr0', inBps: 1e7, outBps: 2e7 },
    ]);
    const sql = sqlLog.find((s) => s.includes('FROM net'));
    expect(sql).toBeDefined();
    expect(sql).toContain("node = 'proxmox'");
    expect(sql).toContain("NOT LIKE 'vnet%'");
    expect(sql).toContain("NOT LIKE 'tap%'");
    expect(sql).toContain("NOT LIKE 'veth%'");
    expect(sql).toContain("<> 'lo'");
    expect(sql).toContain("INTERVAL '5 minutes'");
  });

  it('insufficientData si table net absente (agent non déployé)', async () => {
    const app2 = Fastify();
    registerNodeSystemRoutes(
      app2,
      makeCtx(dir, {
        'FROM net': () => {
          throw new Error("Error during planning: table 'public.iox.net' not found");
        },
      }),
    );
    const res = await app2.inject({ method: 'GET', url: '/api/node-net?node=proxmox&timeframe=day' });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('insufficientData');
  });
});
