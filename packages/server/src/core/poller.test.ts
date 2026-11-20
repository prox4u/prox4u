import { describe, expect, it } from 'vitest';
import type { PveNodeStatus, PveVmResource, Site } from '@prox4u/shared';
import { Poller, type AppContext, type EndpointRuntime } from './poller.js';

const GB = 1024 ** 3;

const node = (node: string, cpus: number, memGb: number): PveNodeStatus => ({
  node,
  online: true,
  cpu: 0,
  cpus,
  memTotal: memGb * GB,
  memUsed: 0,
  swapTotal: 0,
  swapUsed: 0,
  loadavg: null,
  uptime: 100,
  rootfsTotal: 100 * GB,
  rootfsUsed: 10 * GB,
  netin: 0,
  netout: 0,
});

const vm = (vmid: number, nodeName: string, cpuAlloc: number, memGb: number): PveVmResource => ({
  vmid,
  name: `vm-${vmid}`,
  type: 'qemu',
  status: 'running',
  node: nodeName,
  cpu: 0,
  cpuAlloc,
  mem: memGb * GB * 0.5,
  maxmem: memGb * GB,
  disk: 100 * GB,
  maxdisk: 200 * GB,
  netin: 0,
  netout: 0,
  diskread: 0,
  diskwrite: 0,
  uptime: null,
});

const ep = (id: string, sites: Site[]): EndpointRuntime => ({
  id,
  name: id,
  url: '',
  source: {} as EndpointRuntime['source'],
  sites,
});

/** Poller avec les endpoints donnés ; les champs AppContext non utilisés par computeGlobalPra sont vides. */
function makePoller(endpoints: EndpointRuntime[]): Poller {
  const ctx = { endpoints } as unknown as AppContext;
  return new Poller(ctx, {} as AppContext['hub']);
}

/** Pose l'état « pollé » d'un endpoint (snapshot + données brutes). */
function setPolled(poller: Poller, id: string, nodes: PveNodeStatus[], vms: PveVmResource[]): void {
  const st = (poller as unknown as { states: Map<string, { snapshot: unknown; lastNodes: PveNodeStatus[]; lastVms: PveVmResource[] }> }).states.get(id)!;
  st.snapshot = {};
  st.lastNodes = nodes;
  st.lastVms = vms;
}

const globalPra = (poller: Poller) =>
  (poller as unknown as { computeGlobalPra(): import('@prox4u/shared').PraReport | null }).computeGlobalPra();

describe('Poller.computeGlobalPra (PRA cross-endpoints)', () => {
  it('combine les sites/nœuds/VMs de tous les endpoints (noms préfixés, noms de sites intacts)', () => {
    const poller = makePoller([
      ep('ep1', [{ id: 'siteA', name: 'Site A', nodes: ['n1'] }]),
      ep('ep2', [{ id: 'siteB', name: 'Site B', nodes: ['n2'] }]),
    ]);
    setPolled(poller, 'ep1', [node('n1', 8, 32)], [vm(1, 'n1', 6, 24)]);
    setPolled(poller, 'ep2', [node('n2', 8, 32)], []);

    const r = globalPra(poller);
    expect(r).not.toBeNull();
    // ids de sites préfixés (clés), noms d'affichage (bâtiments) intacts.
    expect(r!.sites.map((s) => s.siteId)).toEqual(['ep1/siteA', 'ep2/siteB']);
    expect(r!.sites.find((s) => s.siteId === 'ep1/siteA')!.siteName).toBe('Site A');
    // VM de ep1 absorbable par ep2 : 6/8 cœurs, 24/32 Go → 75 % (warn).
    expect(r!.globalSeverity).toBe('warn');
    expect(r!.sites.find((s) => s.siteId === 'ep1/siteA')!.absorptionPct).toBe(75);
    // L'origine (endpoint) est visible dans le nœud des VMs affectées.
    expect(r!.affectedVms).toHaveLength(1);
    expect(r!.affectedVms[0].node).toBe('ep1/n1');
  });

  it('exclut les endpoints jamais pollés (pas de snapshot) → mono-site effectif → na', () => {
    const poller = makePoller([
      ep('ep1', [{ id: 'siteA', name: 'Site A', nodes: ['n1'] }]),
      ep('ep2', [{ id: 'siteB', name: 'Site B', nodes: ['n2'] }]),
    ]);
    setPolled(poller, 'ep1', [node('n1', 8, 32)], [vm(1, 'n1', 6, 24)]);
    // ep2 jamais pollé → exclu.

    const r = globalPra(poller);
    expect(r!.globalSeverity).toBe('na');
    expect(r!.sites).toHaveLength(1);
    expect(r!.sites[0].siteId).toBe('ep1/siteA');
  });

  it('null si aucun site défini (sites.json absent/vide)', () => {
    const poller = makePoller([ep('ep1', [])]);
    setPolled(poller, 'ep1', [node('n1', 8, 32)], []);
    expect(globalPra(poller)).toBeNull();
  });
});
