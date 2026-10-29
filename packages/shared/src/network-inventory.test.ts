import { describe, expect, it } from 'vitest';
import type { NetworkTopology, TopologyNode, TopologyVm } from './network.js';
import {
  buildNetworkInventory,
  buildNetworkInventoryAll,
  decodeNetSel,
  encodeNetSel,
  filterNetworkRows,
  segmentImpact,
} from './network-inventory.js';

// --- Fixtures -------------------------------------------------------------------

function node(node: string, online: boolean, bridges: { name: string; subnet?: string }[]): TopologyNode {
  return {
    node,
    online,
    ip: null,
    nics: [],
    bridges: bridges.map((b) => ({ name: b.name, ip: null, subnet: b.subnet ?? null, gateway: null, ports: [], comment: null })),
  };
}

function vm(vmid: number, name: string, status: TopologyVm['status'], node: string, nets: TopologyVm['nets'], netIn = 0, netOut = 0): TopologyVm {
  return { vmid, name, type: 'qemu', status, node, nets, netInBps: netIn, netOutBps: netOut };
}

const NET = (iface: string, bridge: string, tag: number | null, ip: string | null = null): TopologyVm['nets'][number] => ({
  iface,
  bridge,
  ip,
  mac: 'BC:24:11:00:00:00',
  tag,
});

function topo(): NetworkTopology {
  const nodes = [
    node('pve1', true, [{ name: 'vmbr0', subnet: '192.168.1.0/24' }, { name: 'vmbr1' }]),
    node('pve2', true, [{ name: 'vmbr0', subnet: '192.168.1.0/24' }]),
    node('pve3', false, [{ name: 'vmbr0', subnet: '192.168.1.0/24' }]),
  ];
  const vms = [
    vm(100, 'web-1', 'running', 'pve1', [NET('net0', 'vmbr0', null, '192.168.1.10'), NET('net1', 'vmbr0', 10, '10.10.10.5')], 100, 50),
    vm(101, 'db-1', 'running', 'pve1', [NET('net0', 'vmbr0', 10, '10.10.10.6')], 200, 80),
    vm(102, 'isolated-vm', 'stopped', 'pve2', [NET('net0', 'vmbr0', null, '192.168.1.11')], 0, 0),
    vm(103, 'multi-iface', 'running', 'pve2', [NET('net0', 'vmbr0', 10, '10.10.10.7'), NET('net1', 'vmbr0', 10, '10.10.10.8')], 300, 90),
    vm(104, 'no-net', 'running', 'pve1', []),
    vm(105, 'down-node-vm', 'running', 'pve3', [NET('net0', 'vmbr0', null, '192.168.1.12')], 10, 5),
  ];
  return { endpointId: 'a', switches: [], nodes, vms, vlans: [10] };
}

// --- segmentImpact ----------------------------------------------------------------

describe('segmentImpact', () => {
  it('VM dont toutes les ifaces sont sur le segment → impactée', () => {
    const r = segmentImpact(topo(), 'vmbr0', null);
    expect(r.impactedVms.map((v) => v.vmid).sort()).toEqual([102, 105]);
  });

  it('VM qui garde une autre interface → dégradée', () => {
    const r = segmentImpact(topo(), 'vmbr0', null);
    expect(r.degradedVms.map((v) => v.vmid)).toEqual([100]);
  });

  it('severity crit si une VM running est impactée, ok si rien', () => {
    expect(segmentImpact(topo(), 'vmbr0', null).severity).toBe('crit'); // 105 running impactée
    expect(segmentImpact(topo(), 'vmbr1', null).severity).toBe('ok'); // aucune VM sur vmbr1
  });
});

describe('sélection de réseau (déroulé) — filtre + encode/decode', () => {
  it('le filtre network restreint au segment exact (pont + VLAN)', () => {
    const rows = buildNetworkInventory(topo());
    expect(filterNetworkRows(rows, '', { network: { bridge: 'vmbr0', vlan: 10 } }).map((r) => r.vlan)).toEqual([10]);
    expect(filterNetworkRows(rows, '', { network: { bridge: 'vmbr0', vlan: null } }).map((r) => r.vlan)).toEqual([null]);
    expect(filterNetworkRows(rows, '', { network: { bridge: 'vmbr1', vlan: null } })).toHaveLength(0);
  });

  it('encode/decode : aller-retour + natif + valeurs malformées', () => {
    expect(decodeNetSel(encodeNetSel('vmbr0', null))).toEqual({ bridge: 'vmbr0', vlan: null });
    expect(decodeNetSel(encodeNetSel('vmbr0', 10))).toEqual({ bridge: 'vmbr0', vlan: 10 });
    expect(decodeNetSel('vmbr0:n')).toEqual({ bridge: 'vmbr0', vlan: null });
    expect(decodeNetSel('')).toBeNull();
    expect(decodeNetSel('vmbr0')).toBeNull();
    expect(decodeNetSel('vmbr0:x')).toBeNull();
    expect(decodeNetSel('vmbr0:-1')).toBeNull();
    expect(decodeNetSel('vmbr0:1.5')).toBeNull();
  });
});

// --- buildNetworkInventory --------------------------------------------------------

describe('buildNetworkInventory — kind interne/externe', () => {
  it('management = pont sans NIC physique, external = pont branché sur une NIC (ou VLAN)', () => {
    const nodes: TopologyNode[] = [
      {
        node: 'pve1',
        online: true,
        ip: '192.168.1.10',
        nics: [],
        bridges: [
          { name: 'vmbr0', ip: '192.168.1.10/24', subnet: '192.168.1.0/24', gateway: null, ports: ['nic0'], comment: null },
          { name: 'nfs', ip: null, subnet: null, gateway: null, ports: [], comment: null },
        ],
      },
    ];
    const vms = [
      vm(100, 'web-1', 'running', 'pve1', [NET('net0', 'vmbr0', null), NET('net1', 'vmbr0', 10)], 10, 5),
      vm(101, 'storage-1', 'running', 'pve1', [NET('net0', 'nfs', null)], 0, 0),
    ];
    const t = { endpointId: 'a', switches: [], nodes, vms, vlans: [10] };
    const rows = buildNetworkInventory(t);
    const byKey = (bridge: string, vlan: number | null) => rows.find((r) => r.bridge === bridge && r.vlan === vlan)!;
    expect(byKey('vmbr0', null).kind).toBe('external'); // NIC physique → externe
    expect(byKey('vmbr0', 10).kind).toBe('external'); // VLAN → externe
    expect(byKey('nfs', null).kind).toBe('management'); // sans NIC physique → interne Proxmox
  });
});

describe('buildNetworkInventory', () => {
  it('une ligne par segment (pont+VLAN), natif avant VLAN', () => {
    const rows = buildNetworkInventory(topo());
    expect(rows.map((r) => `${r.bridge}:${r.vlan}`)).toEqual(['vmbr0:null', 'vmbr0:10']);
  });

  it('liste les interfaces VMs du segment (une VM multi-ifaces apparaît 2×)', () => {
    const vlan10 = buildNetworkInventory(topo()).find((r) => r.vlan === 10)!;
    expect(vlan10.vms.map((v) => `${v.vmid}/${v.iface}`).sort()).toEqual(['100/net1', '101/net0', '103/net0', '103/net1']);
  });

  it('trafic agrégé : chaque VM comptée une seule fois par segment', () => {
    const vlan10 = buildNetworkInventory(topo()).find((r) => r.vlan === 10)!;
    // 100 (100) + 101 (200) + 103 (300, une seule fois malgré 2 ifaces) = 600
    expect(vlan10.trafficIn).toBe(600);
    expect(vlan10.trafficOut).toBe(220);
  });

  it('compteurs running/stopped sur les VMs distinctes', () => {
    const natif = buildNetworkInventory(topo()).find((r) => r.vlan === null)!;
    // 100 running, 102 stopped, 105 running
    expect(natif.running).toBe(2);
    expect(natif.stopped).toBe(1);
  });

  it('sous-réseaux et nœuds hébergeant le pont', () => {
    const natif = buildNetworkInventory(topo()).find((r) => r.vlan === null)!;
    expect(natif.subnets).toEqual(['192.168.1.0/24']);
    expect(natif.nodes.sort()).toEqual(['pve1', 'pve2', 'pve3']);
  });

  it('état dérivé : tous en ligne → ok · un down mais un en ligne → warn · tous down → crit', () => {
    expect(buildNetworkInventory(topo()).find((r) => r.vlan === null)!.severity).toBe('warn'); // pve3 down
    const allOnline = topo();
    allOnline.nodes = allOnline.nodes.filter((n) => n.online);
    expect(buildNetworkInventory(allOnline)[0].severity).toBe('ok');
    const allDown = topo();
    allDown.nodes = allDown.nodes.filter((n) => !n.online);
    expect(buildNetworkInventory(allDown)[0].severity).toBe('crit');
  });

  it('impact en ligne : impactées/dégradées si le réseau tombe', () => {
    const natif = buildNetworkInventory(topo()).find((r) => r.vlan === null)!;
    expect(natif.impactedCount).toBe(2); // 102, 105
    expect(natif.degradedCount).toBe(1); // 100
  });

  it('VM sans interface branchée n’apparaît nulle part', () => {
    const rows = buildNetworkInventory(topo());
    expect(rows.flatMap((r) => r.vms.map((v) => v.vmid))).not.toContain(104);
  });
});

// --- buildNetworkInventoryAll -----------------------------------------------------

describe('buildNetworkInventoryAll', () => {
  it('agrège tous les endpoints + nom du serveur (fallback sur l’id)', () => {
    const b: NetworkTopology = {
      endpointId: 'b',
      switches: [],
      nodes: [node('pve9', true, [{ name: 'vmbr0', subnet: '10.0.0.0/24' }])],
      vms: [vm(200, 'remote-1', 'running', 'pve9', [NET('net0', 'vmbr0', null, '10.0.0.5')])],
      vlans: [],
    };
    const rows = buildNetworkInventoryAll([topo(), b], { a: 'Serveur A' });
    expect(rows).toHaveLength(3); // 2 (endpoint a) + 1 (endpoint b)
    expect(rows.find((r) => r.endpointId === 'a')!.endpointName).toBe('Serveur A');
    expect(rows.find((r) => r.endpointId === 'b')!.endpointName).toBe('b'); // pas de nom → id
  });
});

// --- filterNetworkRows ------------------------------------------------------------

describe('filterNetworkRows', () => {
  const rows = buildNetworkInventory(topo());

  it('recherche par IP de VM', () => {
    expect(filterNetworkRows(rows, '10.10.10.5')).toHaveLength(1);
    expect(filterNetworkRows(rows, '10.10.10.5')[0].vlan).toBe(10);
  });

  it('recherche par nom de VM (plusieurs segments)', () => {
    expect(filterNetworkRows(rows, 'web-1').map((r) => r.vlan).sort((a, b) => (a ?? -1) - (b ?? -1))).toEqual([null, 10]);
  });

  it('recherche par vmid', () => {
    expect(filterNetworkRows(rows, '105')[0].vlan).toBeNull();
  });

  it('recherche insensible à la casse + aucune correspondance', () => {
    expect(filterNetworkRows(rows, 'WEB-1')).toHaveLength(2);
    expect(filterNetworkRows(rows, 'inexistant')).toHaveLength(0);
  });

  it('multiFilter : bridges (ET) et vlans', () => {
    expect(filterNetworkRows(rows, '', { bridges: new Set(['vmbr0']) })).toHaveLength(2);
    expect(filterNetworkRows(rows, '', { bridges: new Set(['vmbr1']) })).toHaveLength(0); // aucune VM sur vmbr1
    expect(filterNetworkRows(rows, '', { vlans: new Set([10]) })).toHaveLength(1);
    expect(filterNetworkRows(rows, '', { vlans: new Set([10]), bridges: new Set(['vmbr1']) })).toHaveLength(0);
  });
});
