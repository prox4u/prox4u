import { describe, expect, it } from 'vitest';
import type { VmSummary } from './types';
import { buildVmTree, DEFAULT_VM_FILTER, filterVmRows, sortVmRows } from './vm-view';

function vm(partial: Partial<VmSummary> & Pick<VmSummary, 'vmid' | 'name'>): VmSummary {
  return {
    type: 'qemu',
    status: 'running',
    node: 'n1',
    cpuPct: 0,
    memBytes: 0,
    maxmemBytes: null,
    diskBytes: null,
    maxdiskBytes: null,
    cpuAllocCores: 0,
    os: null,
    uptimeSec: null,
    netInBps: null,
    netOutBps: null,
    diskReadBps: null,
    diskWriteBps: null,
    ipAddresses: [],
    agentActive: null,
    ...partial,
  };
}

describe('filterVmRows', () => {
  const vms = [
    vm({ vmid: 100, name: 'web-frontend', node: 'n1', status: 'running' }),
    vm({ vmid: 101, name: 'db-postgres', node: 'n2', status: 'stopped' }),
    vm({ vmid: 200, name: 'ct-mail', node: 'n1', status: 'running', type: 'lxc' }),
  ];

  it('recherche par nom (insensible à la casse)', () => {
    expect(filterVmRows(vms, 'WEB', DEFAULT_VM_FILTER).map((v) => v.vmid)).toEqual([100]);
  });

  it('recherche par vmid exact (pas de préfixe partiel)', () => {
    expect(filterVmRows(vms, '200', DEFAULT_VM_FILTER).map((v) => v.vmid)).toEqual([200]);
    // « 20 » ne correspond ni à un nom ni à un vmid exact → aucun résultat.
    expect(filterVmRows(vms, '20', DEFAULT_VM_FILTER)).toHaveLength(0);
  });

  it('filtre par nœud / statut / type', () => {
    expect(filterVmRows(vms, '', { ...DEFAULT_VM_FILTER, node: 'n2' }).map((v) => v.vmid)).toEqual([101]);
    expect(filterVmRows(vms, '', { ...DEFAULT_VM_FILTER, status: 'running' }).map((v) => v.vmid)).toEqual([100, 200]);
    expect(filterVmRows(vms, '', { ...DEFAULT_VM_FILTER, type: 'lxc' }).map((v) => v.vmid)).toEqual([200]);
  });

  it('combine recherche + filtres', () => {
    const rows = filterVmRows(vms, 'mail', { ...DEFAULT_VM_FILTER, node: 'n1', type: 'lxc' });
    expect(rows.map((v) => v.vmid)).toEqual([200]);
  });
});

describe('sortVmRows', () => {
  const vms = [
    vm({ vmid: 3, name: 'c', cpuPct: 50, memBytes: 3, diskBytes: null }),
    vm({ vmid: 1, name: 'a', cpuPct: 10, memBytes: 1, diskBytes: 100 }),
    vm({ vmid: 2, name: 'b', cpuPct: 90, memBytes: 2, diskBytes: 50 }),
  ];

  it('trie par nom asc/desc', () => {
    expect(sortVmRows(vms, 'name', 'asc').map((v) => v.vmid)).toEqual([1, 2, 3]);
    expect(sortVmRows(vms, 'name', 'desc').map((v) => v.vmid)).toEqual([3, 2, 1]);
  });

  it('trie par mémo desc', () => {
    expect(sortVmRows(vms, 'memBytes', 'desc').map((v) => v.vmid)).toEqual([3, 2, 1]);
  });

  it('diskBytes : null toujours en fin de liste', () => {
    expect(sortVmRows(vms, 'diskBytes', 'asc').map((v) => v.vmid)).toEqual([2, 1, 3]);
    expect(sortVmRows(vms, 'diskBytes', 'desc').map((v) => v.vmid)).toEqual([1, 2, 3]);
  });

  it('agentActive : inactif (critique) d’abord en asc, nulls last dans les deux sens', () => {
    const rows = [
      vm({ vmid: 1, name: 'ok', agentActive: true }),
      vm({ vmid: 2, name: 'down', agentActive: false }),
      vm({ vmid: 3, name: 'na', agentActive: null }),
    ];
    // asc : down (2) avant ok (1), null (3) en fin
    expect(sortVmRows(rows, 'agentActive', 'asc').map((v) => v.vmid)).toEqual([2, 1, 3]);
    // desc : ok (1) avant down (2), null (3) toujours en fin
    expect(sortVmRows(rows, 'agentActive', 'desc').map((v) => v.vmid)).toEqual([1, 2, 3]);
  });

  it('statut : running avant stopped (ordre vivant)', () => {
    const rows = [
      vm({ vmid: 1, name: 'x', status: 'stopped' }),
      vm({ vmid: 2, name: 'y', status: 'running' }),
    ];
    expect(sortVmRows(rows, 'status', 'asc').map((v) => v.vmid)).toEqual([2, 1]);
  });

  it('ne mute pas le tableau d’entrée', () => {
    const before = vms.map((v) => v.vmid);
    sortVmRows(vms, 'name', 'desc');
    expect(vms.map((v) => v.vmid)).toEqual(before);
  });
});

describe('buildVmTree', () => {
  it('construit Datacenter → endpoints → nœuds avec compteurs', () => {
    const tree = buildVmTree(
      'Datacenter',
      [
        { id: 'ep1', name: 'Cluster A' },
        { id: 'ep2', name: 'Cluster B' },
      ],
      {
        ep1: [
          vm({ vmid: 1, name: 'a', node: 'n2' }),
          vm({ vmid: 2, name: 'b', node: 'n1' }),
          vm({ vmid: 3, name: 'c', node: 'n1', status: 'stopped' }),
        ],
        ep2: [],
      },
    );
    expect(tree.kind).toBe('datacenter');
    expect(tree.vmCount).toBe(3);
    expect(tree.runningCount).toBe(2);
    expect(tree.children?.map((e) => e.id)).toEqual(['ep1', 'ep2']);
    const ep1 = tree.children![0];
    expect(ep1.vmCount).toBe(3);
    expect(ep1.runningCount).toBe(2);
    // nœuds triés par nom
    expect(ep1.children?.map((n) => [n.id, n.vmCount])).toEqual([
      ['ep1/n1', 2],
      ['ep1/n2', 1],
    ]);
    expect(ep1.children![0].runningCount).toBe(1);
  });

  it('endpoint absent de la map → 0 VMs, pas de crash', () => {
    const tree = buildVmTree('DC', [{ id: 'epX', name: 'X' }], {});
    expect(tree.vmCount).toBe(0);
    expect(tree.children![0].children).toEqual([]);
  });

  it('includeVms : feuilles VM sous chaque nœud (ids, tri par nom, vmid/type)', () => {
    const tree = buildVmTree(
      'Datacenter',
      [{ id: 'ep1', name: 'Cluster A' }],
      {
        ep1: [
          vm({ vmid: 2, name: 'b-web', node: 'n1', type: 'qemu' }),
          vm({ vmid: 10, name: 'a-db', node: 'n1', type: 'lxc', status: 'stopped' }),
          vm({ vmid: 3, name: 'c-mail', node: 'n2' }),
        ],
      },
      { includeVms: true },
    );
    const ep1 = tree.children![0];
    const n1 = ep1.children!.find((n) => n.id === 'ep1/n1')!;
    // tri par nom (pas par vmid) : a-db < b-web
    expect(n1.children?.map((c) => c.id)).toEqual(['ep1/n1/10', 'ep1/n1/2']);
    expect(n1.children![0]).toMatchObject({ kind: 'vm', label: 'a-db', vmid: 10, type: 'lxc', runningCount: 0 });
    expect(n1.children![1]).toMatchObject({ kind: 'vm', label: 'b-web', vmid: 2, type: 'qemu', runningCount: 1 });
    // compteurs du nœud inchangés par l'ajout des feuilles
    expect(n1.vmCount).toBe(2);
    expect(n1.runningCount).toBe(1);
    expect(ep1.children!.find((n) => n.id === 'ep1/n2')?.children?.map((c) => c.vmid)).toEqual([3]);
  });

  it('sans includeVms (défaut) : aucune feuille VM — comportement v1 conservé', () => {
    const tree = buildVmTree('DC', [{ id: 'ep1', name: 'A' }], {
      ep1: [vm({ vmid: 1, name: 'a', node: 'n1' })],
    });
    expect(tree.children![0].children![0].children).toBeUndefined();
    expect(tree.children![0].children![0].kind).toBe('node');
  });
});
