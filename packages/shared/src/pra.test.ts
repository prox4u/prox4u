import { describe, expect, it } from 'vitest';
import { computePra } from './pra.js';
import type { PveNodeStatus, PveVmResource, Site } from './types.js';

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

const vm = (vmid: number, nodeName: string, cpuAlloc: number, memGb: number, status: 'running' | 'stopped' = 'running'): PveVmResource => ({
  vmid,
  name: `vm-${vmid}`,
  type: 'qemu',
  status,
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

const twoSites = (): Site[] => [
  { id: 'a', name: 'Site A', nodes: ['n1', 'n2'] },
  { id: 'b', name: 'Site B', nodes: ['n3', 'n4'] },
];

describe('computePra', () => {
  it('mono-site → na, aucune pénalité', () => {
    const r = computePra(
      [{ id: 'a', name: 'A', nodes: ['n1'] }],
      [node('n1', 8, 32)],
      [vm(1, 'n1', 4, 16)],
    );
    expect(r.globalSeverity).toBe('na');
    expect(r.sites[0].absorptionPct).toBeNull();
    expect(r.affectedVms).toHaveLength(0);
  });

  it('charge équilibrée → ok (< 70 %)', () => {
    const nodes = [node('n1', 8, 32), node('n2', 8, 32), node('n3', 8, 32), node('n4', 8, 32)];
    // Site A : 6 cœurs / 24 Go alloués ; capacité B libre = 16 cœurs / 64 Go → 37.5 %
    const vms = [vm(1, 'n1', 3, 12), vm(2, 'n2', 3, 12)];
    const r = computePra(twoSites(), nodes, vms);
    expect(r.globalSeverity).toBe('ok');
    expect(r.sites.find((s) => s.siteId === 'a')!.absorptionPct!).toBeLessThan(70);
  });

  it('charge lourde sur un site → warn puis crit (> 100 %)', () => {
    const nodes = [node('n1', 8, 32), node('n2', 8, 32), node('n3', 4, 16), node('n4', 4, 16)];
    // Site A : 10 cœurs / 40 Go ; capacité B libre = 8 cœurs / 32 Go → 125 %
    const vms = [vm(1, 'n1', 5, 20), vm(2, 'n2', 5, 20)];
    const r = computePra(twoSites(), nodes, vms);
    expect(r.globalSeverity).toBe('crit');
    expect(r.sites.find((s) => s.siteId === 'a')!.absorptionPct!).toBeGreaterThan(100);
    expect(r.affectedVms.map((v) => v.vmid)).toEqual([1, 2]);
  });

  it('les VMs stopped comptent (vision prudente)', () => {
    const nodes = [node('n1', 8, 32), node('n2', 8, 32), node('n3', 4, 16), node('n4', 4, 16)];
    const vms = [vm(1, 'n1', 5, 20, 'stopped')];
    const r = computePra(twoSites(), nodes, vms);
    expect(r.sites.find((s) => s.siteId === 'a')!.demandCpu).toBe(5);
  });

  it('le disk est exclu du calcul', () => {
    const nodes = [node('n1', 8, 32), node('n2', 8, 32), node('n3', 8, 32), node('n4', 8, 32)];
    const vms = [vm(1, 'n1', 1, 2)];
    vms[0].disk = 5000 * GB; // disque énorme : sans effet
    const r = computePra(twoSites(), nodes, vms);
    expect(r.globalSeverity).toBe('ok');
  });

  it('capacité nulle ailleurs + demande > 0 → absorption impossible (999)', () => {
    const nodes = [node('n1', 8, 32), node('n3', 0, 0), node('n4', 0, 0)];
    const vms = [vm(1, 'n1', 2, 8)];
    const r = computePra(twoSites(), nodes, vms);
    expect(r.globalSeverity).toBe('crit');
    expect(r.sites.find((s) => s.siteId === 'a')!.absorptionPct).toBe(999);
  });

  it('la consommation existante des autres sites réduit la capacité', () => {
    const nodes = [node('n1', 8, 32), node('n2', 8, 32), node('n3', 8, 32), node('n4', 8, 32)];
    // Site B déjà chargé : 12 cœurs / 48 Go alloués → capacité libre 4 cœurs / 16 Go
    const vms = [vm(1, 'n1', 2, 8), vm(2, 'n3', 6, 24), vm(3, 'n4', 6, 24)];
    const r = computePra(twoSites(), nodes, vms);
    const a = r.sites.find((s) => s.siteId === 'a')!;
    expect(a.capacityElsewhereCpu).toBe(4);
    expect(a.capacityElsewhereRamBytes).toBe(16 * GB);
    // 2/4 cœurs et 8/16 Go → 50 % d'absorption
    expect(a.absorptionPct).toBe(50);
  });

  it('tous les nœuds sur le MÊME site → na (pas de répartition, même avec 2 sites définis)', () => {
    // 2 sites définis mais le site B n'a aucun nœud présent → mono-site effectif.
    const sites: Site[] = [
      { id: 'a', name: 'Site A', nodes: ['n1', 'n2'] },
      { id: 'b', name: 'Site B', nodes: ['n3'] },
    ];
    const nodes = [node('n1', 8, 32), node('n2', 8, 32)]; // n3 absent
    const r = computePra(sites, nodes, [vm(1, 'n1', 4, 16)]);
    expect(r.globalSeverity).toBe('na');
    expect(r.sites[0].absorptionPct).toBeNull();
  });

  it('cross-endpoints (noms préfixés) : un site est absorbé par les sites d\'un autre endpoint', () => {
    // Simule le PRA global : nœuds préfixés par l'endpoint, sites de 2 endpoints.
    const sites: Site[] = [
      { id: 'ep1/siteA', name: 'Site A', nodes: ['ep1/n1'] },
      { id: 'ep2/siteB', name: 'Site B', nodes: ['ep2/n2'] },
    ];
    const nodes = [node('ep1/n1', 8, 32), node('ep2/n2', 8, 32)];
    // VM sur ep1/n1 : 6 cœurs / 24 Go ; capacité libre ep2/n2 = 8 cœurs / 32 Go → 75 % (warn)
    const vms = [vm(1, 'ep1/n1', 6, 24)];
    const r = computePra(sites, nodes, vms);
    expect(r.globalSeverity).toBe('warn');
    const a = r.sites.find((s) => s.siteId === 'ep1/siteA')!;
    expect(a.absorptionPct).toBe(75);
    // L'origine (endpoint) est visible dans le nœud des VMs affectées.
    expect(r.affectedVms).toHaveLength(1);
    expect(r.affectedVms[0].node).toBe('ep1/n1');
  });

  it('unmappedNodes : nœuds du cluster non mappés dans un site', () => {
    const sites: Site[] = [{ id: 'a', name: 'Site A', nodes: ['n1'] }];
    const nodes = [node('n1', 8, 32), node('n2', 8, 32), node('n3', 8, 32)]; // n2, n3 orphelins
    const r = computePra(sites, nodes, [vm(1, 'n1', 4, 16)]);
    expect(r.unmappedNodes).toEqual(['n2', 'n3']);
  });

  it('unmappedNodes vide si tous les nœuds sont mappés', () => {
    const sites: Site[] = [
      { id: 'a', name: 'Site A', nodes: ['n1'] },
      { id: 'b', name: 'Site B', nodes: ['n2'] },
    ];
    const nodes = [node('n1', 8, 32), node('n2', 8, 32)];
    const r = computePra(sites, nodes, [vm(1, 'n1', 4, 16)]);
    expect(r.unmappedNodes).toEqual([]);
  });
});
