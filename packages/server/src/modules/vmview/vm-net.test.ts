import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { VmNetResponse } from '@prox4u/shared';
import type { AppContext, Poller } from '../../core/poller.js';
import { latestIfMacMapping, registerVmNetRoute, vmNetLabel } from './vm-net.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** VM 100 du snapshot : 2 cartes (net0 → vmbr0, net1 → bridge nfs) sur le nœud proxmox. */
const SNAP_VMS = [
  { vmid: 100, name: 'ia-u24-01', type: 'qemu', status: 'running', node: 'proxmox' },
  { vmid: 101, name: 'opencode', type: 'qemu', status: 'stopped', node: 'proxmox' },
];

function makePoller(): Poller {
  return {
    getMulti: () => ({
      endpoints: [
        {
          id: 'proxmox',
          snapshot: { vms: SNAP_VMS, nodes: [], cluster: [], storages: [], health: {} },
        },
      ],
    }),
  } as unknown as Poller;
}

/**
 * AppContext mock : `querySql` routé par un fragment du SQL, `source.getVmConfig`
 * renvoie les cartes de la VM (MAC), `never` autorise les handlers qui lèvent
 * (table absente).
 */
function makeCtx(dir: string, routes: Record<string, (sql: string) => unknown[] | never>): AppContext {
  return {
    config: { authFile: path.join(dir, 'auth.json'), defaultEndpointId: 'proxmox' } as AppContext['config'],
    endpoints: [
      {
        id: 'proxmox',
        source: {
          getVmConfig: async (_node: string, vmid: number) =>
            vmid === 100
              ? {
                  nets: [
                    { iface: 'net0', bridge: 'vmbr0', ip: null, mac: 'BC:24:11:42:F0:77', tag: null },
                    { iface: 'net1', bridge: 'nfs', ip: null, mac: 'BC:24:11:5F:29:52', tag: null },
                  ],
                }
              : { nets: [] },
        },
      },
    ] as unknown as AppContext['endpoints'],
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

const macRows = [
  { iface: 'vnet100', mac: 'BC:24:11:42:F0:77', time: '2026-11-13T14:40:00Z' },
  { iface: 'vnet101', mac: 'BC:24:11:00:00:01', time: '2026-11-13T14:40:00Z' },
  { iface: 'vmbr0', mac: 'bc:24:11:00:aa:00', time: '2026-11-13T14:40:00Z' },
];
const netRows = [
  { t: '2026-11-13T12:00:00Z', iface: 'vnet100', in_bps: 1e6, out_bps: 2e6 },
  { t: '2026-11-13T12:05:00Z', iface: 'vnet100', in_bps: 5e5, out_bps: -1 }, // delta négatif (reset) → null
];

describe('latestIfMacMapping', () => {
  it('garde le dernier point par interface, MAC minuscules, 1er device par MAC', () => {
    const m = latestIfMacMapping([
      { iface: 'vnet100', mac: 'BC:24:11:42:F0:77', time: '2026-11-13T14:40:00Z' },
      { iface: 'vnet100', mac: 'STALE:00:00:00:00:00', time: '2026-11-13T14:00:00Z' }, // plus ancien (tri DESC)
      { iface: 'veth1', mac: 'aa:bb:cc:dd:ee:ff', time: '2026-11-13T14:40:00Z' },
      { iface: 'veth2', mac: 'aa:bb:cc:dd:ee:ff', time: '2026-11-13T14:39:00Z' }, // même MAC (paire veth) → 1er gagne
      { iface: '', mac: 'aa:bb:cc:00:00:01', time: '2026-11-13T14:40:00Z' }, // iface vide → ignoré
      { iface: 'lo', mac: '', time: '2026-11-13T14:40:00Z' }, // mac vide → ignoré
    ] as never[]);
    expect(m.get('bc:24:11:42:f0:77')).toBe('vnet100');
    expect(m.get('aa:bb:cc:dd:ee:ff')).toBe('veth1');
    expect(m.size).toBe(2);
  });

  it('vide si aucune ligne', () => {
    expect(latestIfMacMapping([]).size).toBe(0);
  });
});

describe('vmNetLabel', () => {
  it('iface (bridge) — sans parenthèses si bridge vide', () => {
    expect(vmNetLabel('net0', 'vmbr0')).toBe('net0 (vmbr0)');
    expect(vmNetLabel('net0', '')).toBe('net0');
  });
});

describe('GET /api/vm-net', () => {
  let dir: string;
  let app: FastifyInstance;

  const register = (routes: Record<string, (sql: string) => unknown[] | never>) => {
    registerVmNetRoute(app, makeCtx(dir, routes), makePoller());
  };

  const get = (q: string): Promise<{ status: number; body: VmNetResponse }> =>
    app.inject({ method: 'GET', url: `/api/vm-net?${q}` }).then((r) => ({ status: r.statusCode, body: r.json() as VmNetResponse }));

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vm-net-'));
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('404 endpoint inconnu · 400 vmid/timeframe invalides', async () => {
    register({});
    expect((await get('endpoint=nul&vmid=100&timeframe=day')).status).toBe(404);
    expect((await get('vmid=abc&timeframe=day')).status).toBe(400);
    expect((await get('vmid=100&timeframe=decade')).status).toBe(400);
  });

  it('noMapping si net_if_mac absente (table non créée)', async () => {
    register({
      'FROM net_if_mac': () => {
        throw new Error('Error during planning: table \'public.iox.net_if_mac\' not found');
      },
    });
    const r = await get('vmid=100&timeframe=day');
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('noMapping');
    expect(r.body.series).toEqual([]);
  });

  it('noMapping si mapping vide (agent silencieux) · insufficientData si VM absente du snapshot', async () => {
    register({});
    expect((await get('vmid=100&timeframe=day')).body.source).toBe('noMapping');
    expect((await get('vmid=999&timeframe=day')).body.source).toBe('insufficientData');
  });

  it('insufficientData si la VM n\'a aucune carte lue', async () => {
    register({ 'FROM net_if_mac': () => macRows });
    expect((await get('vmid=101&timeframe=day')).body.source).toBe('insufficientData');
  });

  it('séries par carte : MAC joint au tap, débits, MAC non trouvée → points vides', async () => {
    register({
      'FROM net_if_mac': () => macRows,
      'FROM net': () => netRows,
    });
    const r = await get('vmid=100&timeframe=day');
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('influx');
    expect(r.body.vmid).toBe(100);
    expect(r.body.series.map((s) => s.iface)).toEqual(['net0', 'net1']);
    const net0 = r.body.series[0];
    expect(net0.hostIface).toBe('vnet100');
    expect(net0.label).toBe('net0 (vmbr0)');
    expect(net0.mac).toBe('BC:24:11:42:F0:77');
    expect(net0.points).toEqual([
      { t: 1794571200, inBps: 1e6, outBps: 2e6 },
      { t: 1794571500, inBps: 5e5, outBps: null },
    ]);
    const net1 = r.body.series[1]; // MAC absente du mapping (bridge nfs) → tap inconnu
    expect(net1.hostIface).toBeNull();
    expect(net1.points).toEqual([]);
  });

  it('VM arrêtée : cartes listées sans tap, source influx (pas de valeur inventée)', async () => {
    register({
      'FROM net_if_mac': () => [
        { iface: 'vnet101', mac: 'BC:24:11:00:00:01', time: '2026-11-13T14:40:00Z' },
      ],
      'FROM net': () => [],
    });
    const r = await get('vmid=100&timeframe=day');
    expect(r.body.source).toBe('influx');
    expect(r.body.series.every((s) => s.hostIface === null && s.points.length === 0)).toBe(true);
  });
});
