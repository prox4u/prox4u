import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  impactAnalysis,
  ipInSubnet,
  internalNetworkSegments,
  matchAgentNetsByMac,
  parseVmNets,
  primaryAgentIp,
  segmentKey,
  subnetOf,
  type ParsedVmNet,
  type TopologyNode,
  type TopologyVm,
  type VmAgentNetIf,
} from './network.js';

describe('subnetOf', () => {
  it('calcule l’adresse de réseau IPv4', () => {
    expect(subnetOf('192.168.1.80/24')).toBe('192.168.1.0/24');
    expect(subnetOf('10.0.5.7/16')).toBe('10.0.0.0/16');
    expect(subnetOf('192.168.1.80/27')).toBe('192.168.1.64/27');
    expect(subnetOf('192.168.1.80/32')).toBe('192.168.1.80/32');
    expect(subnetOf('192.168.1.80/0')).toBe('0.0.0.0/0');
  });

  it('renvoie null sur les valeurs non CIDR (pas de crash)', () => {
    expect(subnetOf(null)).toBeNull();
    expect(subnetOf(undefined)).toBeNull();
    expect(subnetOf('')).toBeNull();
    expect(subnetOf('manual')).toBeNull();
    expect(subnetOf('192.168.1.80')).toBeNull();
    expect(subnetOf('300.1.1.1/24')).toBeNull();
    expect(subnetOf('192.168.1.80/33')).toBeNull();
  });
});

describe('parseVmNets', () => {
  it('qemu : MAC = 1er token, bridge=, tri numérique des ifaces', () => {
    const nets = parseVmNets('qemu', {
      net1: 'virtio=BC:24:11:5F:29:52,bridge=nfs,mtu=9000',
      net0: 'virtio=BC:24:11:42:F0:77,bridge=vmbr0',
      cores: '2',
    });
    expect(nets).toEqual([
      { iface: 'net0', bridge: 'vmbr0', ip: null, mac: 'BC:24:11:42:F0:77', tag: null },
      { iface: 'net1', bridge: 'nfs', ip: null, mac: 'BC:24:11:5F:29:52', tag: null },
    ]);
  });

  it('qemu : le VLAN est lu dans tag= (absent → null)', () => {
    const nets = parseVmNets('qemu', {
      net0: 'virtio=BC:24:11:42:F0:77,bridge=vmbr0,tag=100',
      net1: 'virtio=BC:24:11:5F:29:52,bridge=vmbr0',
    });
    expect(nets[0].tag).toBe(100);
    expect(nets[1].tag).toBeNull();
  });

  it('lxc : tag= accepté aussi (VLAN sur conteneur)', () => {
    const nets = parseVmNets('lxc', { net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:4A:8B:80,ip=192.168.1.185/24,tag=20,type=veth' });
    expect(nets[0].tag).toBe(20);
  });

  it('qemu : tag non numérique ignoré (→ null, pas de crash)', () => {
    const nets = parseVmNets('qemu', { net0: 'virtio=BC:24:11:42:F0:77,bridge=vmbr0,tag=abc' });
    expect(nets[0].tag).toBeNull();
  });

  it('qemu : ignore les interfaces sans pont (absent ou « none »)', () => {
    expect(parseVmNets('qemu', { net0: 'virtio=BC:24:11:00:00:00' })).toEqual([]);
    expect(parseVmNets('qemu', { net0: 'virtio=BC:24:11:00:00:00,bridge=none' })).toEqual([]);
  });

  it('lxc : hwaddr + ip (type=veth), « manual » → ip null + ipMode', () => {
    const nets = parseVmNets('lxc', {
      mp0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:4A:8B:80,ip=192.168.1.185/24,type=veth',
    });
    expect(nets).toEqual([{ iface: 'mp0', bridge: 'vmbr0', ip: '192.168.1.185/24', mac: 'BC:24:11:4A:8B:80', tag: null }]);
    expect(nets[0].ipMode).toBeUndefined();

    const manual = parseVmNets('lxc', { mp0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:9C:F4:D0,ip=manual,type=veth' });
    expect(manual[0].ip).toBeNull();
    expect(manual[0].ipMode).toBe('manual');

    const dhcp = parseVmNets('lxc', { mp0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:9C:F4:D1,ip=dhcp,type=veth' });
    expect(dhcp[0].ip).toBeNull();
    expect(dhcp[0].ipMode).toBe('dhcp');
  });

  it('lxc : les deux notations de clés (netN PVE ≥ 8.1 et mpN ancien) sont acceptées', () => {
    const v9 = parseVmNets('lxc', { net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:4A:8B:80,ip=192.168.1.185/24,type=veth' });
    expect(v9).toEqual([{ iface: 'net0', bridge: 'vmbr0', ip: '192.168.1.185/24', mac: 'BC:24:11:4A:8B:80', tag: null }]);

    const legacy = parseVmNets('lxc', { mp0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:9C:F4:D0,ip=manual,type=veth' });
    expect(legacy[0].iface).toBe('mp0');
    expect(legacy[0].ip).toBeNull();
  });
});

const node = (over: Partial<TopologyNode> = {}): TopologyNode => ({
  node: 'n1',
  online: true,
  ip: null,
  nics: [],
  bridges: [{ name: 'vmbr0', ip: '192.168.1.10/24', subnet: '192.168.1.0/24', gateway: null, ports: ['nic0'], comment: null }],
  ...over,
});

const vm = (over: Partial<TopologyVm> = {}): TopologyVm => ({
  vmid: 100,
  name: 'vm-100',
  type: 'qemu',
  status: 'running',
  node: 'n1',
  nets: [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: null, tag: null }],
  netInBps: null,
  netOutBps: null,
  ...over,
});

const topo = (over: Partial<ReturnType<typeof buildTopology>> = {}): ReturnType<typeof buildTopology> =>
  buildTopology({ endpointId: 'ep1', nodes: [node()], vms: [vm()], ...over });

describe('buildTopology', () => {
  it('même pont + même sous-réseau sur 2 nœuds = 1 switch inféré', () => {
    const t = buildTopology({
      endpointId: 'ep1',
      nodes: [node(), node({ node: 'n2', ip: '192.168.1.11' })],
      vms: [],
    });
    expect(t.switches).toHaveLength(1);
    expect(t.switches[0]).toMatchObject({ id: 'sw-vmbr0-192-168-1-0-24', name: 'vmbr0 · 192.168.1.0/24', inferred: true });
  });

  it('même pont, sous-réseaux différents = 2 switches', () => {
    const t = buildTopology({
      endpointId: 'ep1',
      nodes: [
        node(),
        node({
          node: 'n2',
          bridges: [{ name: 'vmbr0', ip: '10.0.0.5/24', subnet: '10.0.0.0/24', gateway: null, ports: ['nic0'], comment: null }],
        }),
      ],
      vms: [],
    });
    expect(t.switches).toHaveLength(2);
  });

  it('pont sans IP groupé par nom seul (ex. « nfs »)', () => {
    const nfs = { name: 'nfs', ip: null, subnet: null, gateway: null, ports: [], comment: null };
    const t = buildTopology({
      endpointId: 'ep1',
      nodes: [node({ bridges: [nfs] }), node({ node: 'n2', bridges: [{ ...nfs }] })],
      vms: [],
    });
    expect(t.switches).toHaveLength(1);
    expect(t.switches[0]).toMatchObject({ id: 'sw-nfs', name: 'nfs', subnet: null });
  });

  it('nœuds et VMs passés tels quels (pas de mutation)', () => {
    const nodes = [node()];
    const vms: TopologyVm[] = [vm()];
    const t = buildTopology({ endpointId: 'ep1', nodes, vms });
    expect(t.nodes).toBe(nodes);
    expect(t.vms).toBe(vms);
    expect(t.endpointId).toBe('ep1');
  });

  it('liste les VLANs utilisés (tags distincts, triés) — vide si aucun tag', () => {
    const t = buildTopology({
      endpointId: 'ep1',
      nodes: [node()],
      vms: [
        vm({ nets: [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: null, tag: 20 }] }),
        vm({ vmid: 101, nets: [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: null, tag: 10 }] }),
        vm({ vmid: 102, nets: [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: null, tag: 20 }] }),
      ],
    });
    expect(t.vlans).toEqual([10, 20]);
    expect(buildTopology({ endpointId: 'ep1', nodes: [node()], vms: [vm()] }).vlans).toEqual([]);
  });
});

describe('segmentKey', () => {
  it('distingue le VLAN natif (null) des VLAN tagués', () => {
    expect(segmentKey('vmbr0', null)).not.toBe(segmentKey('vmbr0', 10));
    expect(segmentKey('vmbr0', 10)).toBe(segmentKey('vmbr0', 10));
    expect(segmentKey('vmbr0', 10)).not.toBe(segmentKey('nfs', 10));
  });
});

describe('ipInSubnet', () => {
  it('IP dans le CIDR → true (y compris /32 et /0)', () => {
    expect(ipInSubnet('192.168.1.42', '192.168.1.0/24')).toBe(true);
    expect(ipInSubnet('192.168.1.0', '192.168.1.0/24')).toBe(true);
    expect(ipInSubnet('192.168.1.255', '192.168.1.0/24')).toBe(true);
    expect(ipInSubnet('10.2.3.4', '10.2.3.4/32')).toBe(true);
    expect(ipInSubnet('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('IP hors du CIDR → false', () => {
    expect(ipInSubnet('192.168.2.42', '192.168.1.0/24')).toBe(false);
    expect(ipInSubnet('10.2.3.5', '10.2.3.4/32')).toBe(false);
  });

  it('entrées malformées → false (pas de crash)', () => {
    expect(ipInSubnet('300.1.1.1', '192.168.1.0/24')).toBe(false);
    expect(ipInSubnet('abc', '192.168.1.0/24')).toBe(false);
    expect(ipInSubnet('192.168.1.42', '192.168.1.0/33')).toBe(false);
    expect(ipInSubnet('192.168.1.42', '192.168.1.0')).toBe(false);
    expect(ipInSubnet('192.168.1.42', '')).toBe(false);
  });
});

describe('internalNetworkSegments', () => {
  it('pont sans port physique → segment interne Proxmox', () => {
    const nfs = { name: 'nfs', ip: null, subnet: null, gateway: null, ports: [], comment: null };
    const t = topo({ nodes: [node({ bridges: [nfs] })] });
    expect(internalNetworkSegments(t)).toEqual(new Set([segmentKey('nfs', null)]));
  });

  it('pont branché sur une NIC physique (ou aucun pont) → aucun segment interne', () => {
    // Le vmbr0 par défaut porte ports:['nic0'] (NIC physique) → réseau externe.
    expect(internalNetworkSegments(topo())).toEqual(new Set());
    expect(internalNetworkSegments(topo({ nodes: [node({ bridges: [] })] }))).toEqual(new Set());
  });

  it('plusieurs nœuds, chacun avec un pont sans port → tous les segments internes', () => {
    const nfs = { name: 'nfs', ip: null, subnet: null, gateway: null, ports: [], comment: null };
    const storage = { name: 'storage', ip: null, subnet: null, gateway: null, ports: [], comment: null };
    const t = buildTopology({
      endpointId: 'ep1',
      nodes: [node({ node: 'n1', bridges: [nfs] }), node({ node: 'n2', bridges: [storage] })],
      vms: [vm()],
    });
    expect(internalNetworkSegments(t)).toEqual(new Set([segmentKey('nfs', null), segmentKey('storage', null)]));
  });
});

describe('impactAnalysis', () => {
  it('nœud tombé → toutes ses VMs impactées, sévérité crit si en marche', () => {
    const t = topo({ vms: [vm(), vm({ vmid: 101, status: 'stopped' })] });
    const r = impactAnalysis(t, { kind: 'node', node: 'n1' });
    expect(r.impactedVms.map((v) => v.vmid).sort()).toEqual([100, 101]);
    expect(r.severity).toBe('crit');
  });

  it('pont tombé → VMs sur ce pont impactées ; les autres épargnées', () => {
    const nfs = { name: 'nfs', ip: null, subnet: null, gateway: null, ports: [], comment: null };
    const t = topo({
      nodes: [node({ bridges: [{ name: 'vmbr0', ip: '192.168.1.10/24', subnet: '192.168.1.0/24', gateway: null, ports: ['nic0'], comment: null }, nfs] })],
      vms: [
        vm(),
        vm({ vmid: 101, nets: [{ iface: 'net0', bridge: 'nfs', ip: null, mac: null, tag: null }] }),
      ],
    });
    const r = impactAnalysis(t, { kind: 'bridge', node: 'n1', bridge: 'vmbr0' });
    expect(r.impactedVms.map((v) => v.vmid)).toEqual([100]);
    expect(r.affectedBridges).toEqual([{ node: 'n1', bridge: 'vmbr0' }]);
  });

  it('VM multi-ifaces : perte d’une seule iface = dégradée, pas impactée', () => {
    const nfs = { name: 'nfs', ip: null, subnet: null, gateway: null, ports: [], comment: null };
    const t = topo({
      nodes: [node({ bridges: [{ name: 'vmbr0', ip: '192.168.1.10/24', subnet: '192.168.1.0/24', gateway: null, ports: ['nic0'], comment: null }, nfs] })],
      vms: [
        vm({ nets: [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: null, tag: null }, { iface: 'net1', bridge: 'nfs', ip: null, mac: null, tag: null }] }),
      ],
    });
    const r = impactAnalysis(t, { kind: 'bridge', node: 'n1', bridge: 'vmbr0' });
    expect(r.impactedVms).toHaveLength(0);
    expect(r.degradedVms.map((v) => v.vmid)).toEqual([100]);
  });

  it('NIC unique perdue → pont coupé ; NIC d’un bond (2 ports) → dégradé', () => {
    const single = node({ bridges: [{ name: 'vmbr0', ip: '192.168.1.10/24', subnet: '192.168.1.0/24', gateway: null, ports: ['nic0'], comment: null }] });
    const bond = node({ node: 'n2', bridges: [{ name: 'vmbr0', ip: '192.168.1.11/24', subnet: '192.168.1.0/24', gateway: null, ports: ['nic0', 'nic1'], comment: null }] });
    const t = topo({
      nodes: [single, bond],
      vms: [vm(), vm({ vmid: 101, node: 'n2' })],
    });
    expect(impactAnalysis(t, { kind: 'nic', node: 'n1', nic: 'nic0' }).impactedVms.map((v) => v.vmid)).toEqual([100]);
    const bondImpact = impactAnalysis(t, { kind: 'nic', node: 'n2', nic: 'nic0' });
    expect(bondImpact.impactedVms).toHaveLength(0);
    expect(bondImpact.degradedVms.map((v) => v.vmid)).toEqual([101]);
  });

  it('VLAN perdu → seules les VMs taguées avec ce VLAN sont impactées', () => {
    const t = topo({
      vms: [
        vm({ nets: [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: null, tag: 10 }] }),
        vm({ vmid: 101, nets: [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: null, tag: 20 }] }),
      ],
    });
    const r = impactAnalysis(t, { kind: 'vlan', vlan: 10 });
    expect(r.impactedVms.map((v) => v.vmid)).toEqual([100]);
  });

  it('switch tombé → ponts de tous les nœuds du groupe + switches touchés remontés', () => {
    const t = topo({
      nodes: [node(), node({ node: 'n2', ip: '192.168.1.11' })],
      vms: [vm(), vm({ vmid: 101, node: 'n2' })],
    });
    const swId = t.switches[0].id;
    const r = impactAnalysis(t, { kind: 'switch', id: swId });
    expect(r.impactedVms.map((v) => v.vmid).sort()).toEqual([100, 101]);
    expect(r.affectedSwitchIds).toEqual([swId]);
    expect(r.affectedBridges).toHaveLength(2);
  });

  it('défaillance inconnue / sans VM concernée → sévérité ok', () => {
    expect(impactAnalysis(topo(), { kind: 'switch', id: 'sw-inexistant' }).severity).toBe('ok');
    const r = impactAnalysis(topo(), { kind: 'vlan', vlan: 999 });
    expect(r.severity).toBe('ok');
    expect(r.impactedVms).toHaveLength(0);
  });
});

describe('primaryAgentIp', () => {
  it('privilégie l’IPv4 sur l’IPv6', () => {
    expect(primaryAgentIp(['2a01:cb14::be24:11ff:fecd:9370/64', '192.168.1.190/24'])).toBe('192.168.1.190/24');
  });

  it('retombe sur la première adresse si IPv6 uniquement', () => {
    expect(primaryAgentIp(['2a01:cb14::be24:11ff:fecd:9370/64'])).toBe('2a01:cb14::be24:11ff:fecd:9370/64');
  });

  it('liste vide → undefined', () => {
    expect(primaryAgentIp([])).toBeUndefined();
  });
});

describe('matchAgentNetsByMac', () => {
  const net = (iface: string, mac: string | null): ParsedVmNet => ({
    iface,
    bridge: 'vmbr0',
    ip: null,
    mac,
    tag: null,
  });
  const agent = (name: string, mac: string | null, ips: string[]): VmAgentNetIf => ({ name, mac, ips });

  it('jointure par MAC insensible à la casse', () => {
    const m = matchAgentNetsByMac([net('net0', 'BC:24:11:42:F0:77')], [agent('enp6s18', 'bc:24:11:42:f0:77', ['192.168.1.180/24'])]);
    expect(m.get('net0')).toEqual(['192.168.1.180/24']);
  });

  it('plusieurs interfaces agent avec la même MAC → IPs fusionnées (dedup)', () => {
    const m = matchAgentNetsByMac(
      [net('net0', 'BC:24:11:E4:56:5E')],
      [agent('nic0', 'bc:24:11:e4:56:5e', []), agent('vmbr0', 'bc:24:11:e4:56:5e', ['192.168.1.201/24'])],
    );
    expect(m.get('net0')).toEqual(['192.168.1.201/24']);
  });

  it('interfaces agent absentes de la config (docker0, veth) → ignorées', () => {
    const m = matchAgentNetsByMac(
      [net('net0', 'BC:24:11:AA:BB:CC')],
      [agent('docker0', '96:55:c7:7c:b0:50', ['172.17.0.1/16']), agent('enp6s18', 'bc:24:11:aa:bb:cc', ['10.0.0.5/24'])],
    );
    expect(m.get('net0')).toEqual(['10.0.0.5/24']);
    expect(m.size).toBe(1);
  });

  it('MAC config nulle ou sans IP côté agent → pas d’entrée', () => {
    const m = matchAgentNetsByMac(
      [net('net0', null), net('net1', 'BC:24:11:00:00:01')],
      [agent('eth0', 'bc:24:11:00:00:01', [])],
    );
    expect(m.size).toBe(0);
  });

  it('entrées vides → Map vide', () => {
    expect(matchAgentNetsByMac([], []).size).toBe(0);
    expect(matchAgentNetsByMac([net('net0', 'BC:24:11:00:00:02')], []).size).toBe(0);
  });
});
