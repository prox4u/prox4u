import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { VmDiskioResponse } from '@prox4u/shared';
import type { AppContext } from '../../core/poller.js';
import { latestDmMapping, registerVmDiskioRoute } from './vm-diskio.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * AppContext mock : `querySql` routé par un fragment du SQL. `never` dans le
 * type des handlers autorise les fonctions qui lèvent (table absente).
 */
function makeCtx(dir: string, routes: Record<string, (sql: string) => unknown[] | never>): AppContext {
  return {
    config: { authFile: path.join(dir, 'auth.json'), defaultEndpointId: 'proxmox' } as AppContext['config'],
    endpoints: [{ id: 'proxmox' }] as unknown as AppContext['endpoints'],
    logger,
    influx: {
      enabled: true,
      rawDb: 'raw',
      querySql: async (_db: string, sql: string) => {
        for (const [frag, fn] of Object.entries(routes)) {
          if (sql.includes(frag)) return fn(sql);
        }
        return [];
      },
    } as unknown as AppContext['influx'],
    auth: {} as AppContext['auth'],
    hub: {} as AppContext['hub'],
  };
}

describe('latestDmMapping', () => {
  it('garde le dernier point par (node, dm), ignore les vides', () => {
    const m = latestDmMapping([
      { node: 'proxmox', dm: 'dm-3', mapper_name: 'local--vm--100--disk--0', time: '2026-11-13T14:40:00Z' },
      { node: 'proxmox', dm: 'dm-3', mapper_name: 'STALE', time: '2026-11-13T14:00:00Z' }, // plus ancien (tri DESC)
      { node: 'proxmox', dm: 'dm-10', mapper_name: 'local--vm--100--disk--1', time: '2026-11-13T14:40:00Z' },
      { node: 'ProxSite1', dm: 'dm-3', mapper_name: 'vg--root', time: '2026-11-13T14:40:00Z' }, // autre nœud → autre clé
      { node: 'proxmox', dm: '', mapper_name: 'x', time: '2026-11-13T14:40:00Z' }, // dm vide → ignoré
    ] as never[]);
    expect(m.get('proxmox/dm-3')?.mapper).toBe('local--vm--100--disk--0');
    expect(m.get('proxmox/dm-10')?.mapper).toBe('local--vm--100--disk--1');
    expect(m.get('ProxSite1/dm-3')?.mapper).toBe('vg--root');
    expect(m.size).toBe(3);
  });
});

describe('GET /api/vm-diskio', () => {
  let dir: string;
  let app: FastifyInstance;

  const dmRows = [
    { node: 'proxmox', dm: 'dm-3', mapper_name: 'local--vm--100--disk--0', time: '2026-11-13T14:40:00Z' },
    { node: 'proxmox', dm: 'dm-10', mapper_name: 'local--vm--100--disk--1', time: '2026-11-13T14:40:00Z' },
    { node: 'proxmox', dm: 'dm-12', mapper_name: 'local--vm--104--disk--0', time: '2026-11-13T14:40:00Z' }, // autre VM
    { node: 'proxmox', dm: 'dm-0', mapper_name: 'local--root', time: '2026-11-13T14:40:00Z' }, // pas un LV VM
  ];
  const diskioRows = [
    { t: '2026-11-13T12:00:00Z', name: 'dm-3', read_bps: 1e6, write_bps: 5e5, iops: 20, busy_pct: 30, await_ms: 2 },
    { t: '2026-11-13T12:00:00Z', name: 'dm-10', read_bps: 100, write_bps: 200, iops: 1, busy_pct: 2, await_ms: 1 },
  ];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vm-diskio-'));
    app = Fastify();
    registerVmDiskioRoute(
      app,
      makeCtx(dir, {
        'FROM dm_names': () => dmRows,
        'FROM diskio': () => diskioRows,
      }),
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('400 sans vmid / timeframe invalide, 404 endpoint inconnu', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/vm-diskio?endpoint=proxmox' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/vm-diskio?endpoint=proxmox&vmid=100&timeframe=decade' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/vm-diskio?vmid=100&timeframe=day&endpoint=inexistant' })).statusCode).toBe(404);
  });

  it('sélectionne les disques de la VM (vm-100) et non les autres, avec libellés lisibles', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/vm-diskio?endpoint=proxmox&vmid=100&timeframe=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VmDiskioResponse;
    expect(body.source).toBe('influx');
    expect(body.series).toHaveLength(2);
    // tri par label (disk-0 avant disk-1) → dm-3 avant dm-10
    expect(body.series.map((s) => s.device)).toEqual(['dm-3', 'dm-10']);
    expect(body.series.map((s) => s.label)).toEqual(['vm-100-disk-0 (vg local)', 'vm-100-disk-1 (vg local)']);
    const s0 = body.series.find((s) => s.device === 'dm-3')!;
    expect(s0.mapperName).toBe('local--vm--100--disk--0');
    expect(s0.points).toHaveLength(1);
    expect(s0.points[0]).toMatchObject({ readBps: 1e6, writeBps: 5e5, iops: 20, busyPct: 30, awaitMs: 2 });
  });

  it('table dm_names absente → noMapping (agent pas encore (re)déployé)', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'vm-diskio-'));
    const app2 = Fastify();
    registerVmDiskioRoute(
      app2,
      makeCtx(dir2, {
        'FROM dm_names': () => {
          throw new Error("Error during planning: table 'public.iox.dm_names' not found");
        },
      }),
    );
    await app2.ready();
    const res = await app2.inject({ method: 'GET', url: '/api/vm-diskio?endpoint=proxmox&vmid=100&timeframe=day' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ timeframe: 'day', vmid: 100, series: [], source: 'noMapping' });
    await app2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it('mapping présent mais aucun LV dm pour la VM → insufficientData (ZFS / sans volume)', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'vm-diskio-'));
    const app2 = Fastify();
    registerVmDiskioRoute(
      app2,
      makeCtx(dir2, {
        'FROM dm_names': () => [{ node: 'proxmox', dm: 'dm-0', mapper_name: 'local--root', time: '2026-11-13T14:40:00Z' }],
      }),
    );
    await app2.ready();
    const res = await app2.inject({ method: 'GET', url: '/api/vm-diskio?endpoint=proxmox&vmid=999&timeframe=day' });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('insufficientData');
    await app2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});
