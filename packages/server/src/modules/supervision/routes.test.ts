import { describe, expect, it } from 'vitest';
import type { ParsedVmNet, VmAgentNetIf } from '@prox4u/shared';
import { enrichVmAgentIps } from './routes.js';

const net = (iface: string, mac: string | null, ip: string | null = null): ParsedVmNet => ({
  iface,
  bridge: 'vmbr0',
  ip,
  mac,
  tag: null,
});
const agent = (name: string, mac: string | null, ips: string[]): VmAgentNetIf => ({ name, mac, ips });

describe('enrichVmAgentIps', () => {
  it('complète nets[].ip avec l’IP primaire (IPv4 d’abord) et renvoie la liste complète', () => {
    const r = enrichVmAgentIps(
      [net('net0', 'BC:24:11:CD:93:70'), net('net1', 'BC:24:11:AA:BA:50')],
      [
        agent('ens18', 'bc:24:11:cd:93:70', ['2a01:cb14::be24:11ff:fecd:9370/64', '192.168.1.190/24']),
        agent('ens19', 'bc:24:11:aa:ba:50', ['192.168.100.190/24']),
      ],
    );
    expect(r.nets[0].ip).toBe('192.168.1.190/24'); // v4 privilégiée sur la v6
    expect(r.nets[1].ip).toBe('192.168.100.190/24');
    expect(r.agentIps?.net0).toEqual(['2a01:cb14::be24:11ff:fecd:9370/64', '192.168.1.190/24']);
    expect(r.agentIps?.net1).toEqual(['192.168.100.190/24']);
  });

  it('ne remplace pas une IP de config (LXC)', () => {
    const r = enrichVmAgentIps(
      [net('eth0', 'BC:24:11:00:00:01', '10.0.0.5/24')],
      [agent('eth0', 'bc:24:11:00:00:01', ['172.17.0.2/16'])],
    );
    expect(r.nets[0].ip).toBe('10.0.0.5/24');
  });

  it('interfaces agent absentes de la config → ignorées, pas d’agentIps si rien ne joint', () => {
    const r = enrichVmAgentIps(
      [net('net0', 'BC:24:11:AA:BB:CC')],
      [agent('docker0', '96:55:c7:00:00:00', ['172.17.0.1/16'])],
    );
    expect(r.agentIps).toBeUndefined();
    expect(r.nets[0].ip).toBeNull();
  });

  it('liste agent vide → nets inchangées (même référence)', () => {
    const nets = [net('net0', 'BC:24:11:AA:BB:CC')];
    const r = enrichVmAgentIps(nets, []);
    expect(r.nets).toBe(nets);
    expect(r.agentIps).toBeUndefined();
  });

  it('interface agent sans IP → pas d’entrée dans agentIps', () => {
    const r = enrichVmAgentIps(
      [net('net0', 'BC:24:11:AA:BB:CC')],
      [agent('nic0', 'bc:24:11:aa:bb:cc', [])],
    );
    expect(r.agentIps).toBeUndefined();
    expect(r.nets[0].ip).toBeNull();
  });
});
