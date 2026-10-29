import { describe, expect, it } from 'vitest';
import type { InvVm } from './types';
import {
  DEFAULT_INV_FILTER,
  filterInvRows,
  invSummary,
  invToCsv,
  invToJson,
  invToTxt,
  invTotalDiskMb,
  osDisplay,
  osFamilyFromId,
  ostypeFamily,
  sortInvRows,
} from './proxmox-inventory';

function inv(partial: Partial<InvVm> & Pick<InvVm, 'vmid' | 'name'>): InvVm {
  return {
    host: 'ep1',
    node: 'n1',
    type: 'qemu',
    status: 'running',
    template: false,
    osType: 'Linux/Unix',
    osPretty: 'Ubuntu 24.04 LTS',
    osKernel: '6.17.0-generic',
    cpuCores: 4,
    cpuPct: 10,
    ramAllocMb: 8192,
    ramUsedMb: 4096,
    ramUsedPct: 50,
    uptimeS: 1000,
    tags: [],
    notes: null,
    disks: [],
    interfaces: [],
    ips: [],
    ...partial,
  };
}

describe('invTotalDiskMb', () => {
  it('somme des disques, null si aucun', () => {
    expect(invTotalDiskMb(inv({ vmid: 1, name: 'a' }))).toBeNull();
    expect(invTotalDiskMb(inv({
      vmid: 2, name: 'b',
      disks: [
        { mountpoint: '/', dev: 'sda1', totalMb: 100, usedMb: 50, freeMb: 50, usedPct: 50 },
        { mountpoint: '/data', dev: 'sda2', totalMb: 200, usedMb: 100, freeMb: 100, usedPct: 50 },
      ],
    }))).toBe(300);
  });
});

describe('décodage famille OS', () => {
  it('osFamilyFromId : id QGA → famille', () => {
    expect(osFamilyFromId('ubuntu')).toBe('Linux/Unix');
    expect(osFamilyFromId('debian')).toBe('Linux/Unix');
    expect(osFamilyFromId('windows')).toBe('Windows');
    expect(osFamilyFromId(null)).toBe('Autre');
  });
  it('ostypeFamily : code config PVE → famille', () => {
    // codes courts QEMU
    expect(ostypeFamily('l26')).toBe('Linux/Unix');
    expect(ostypeFamily('w2k22')).toBe('Windows');
    expect(ostypeFamily('w11')).toBe('Windows');
    // noms de distro complets LXC
    expect(ostypeFamily('debian')).toBe('Linux/Unix');
    expect(ostypeFamily('ubuntu')).toBe('Linux/Unix');
    expect(ostypeFamily('windows')).toBe('Windows');
    expect(ostypeFamily('none')).toBe('Autre');
    expect(ostypeFamily(undefined)).toBe('Autre');
  });
  it('osDisplay : OS réel sinon famille (LXC prioritaire)', () => {
    expect(osDisplay({ type: 'qemu', osType: 'Linux/Unix', osPretty: 'Ubuntu 24.04 LTS' })).toBe('Ubuntu 24.04 LTS');
    expect(osDisplay({ type: 'qemu', osType: 'Linux/Unix', osPretty: null })).toBe('Linux/Unix');
    expect(osDisplay({ type: 'lxc', osType: 'Linux/Unix', osPretty: 'Debian 13' })).toBe('LXC');
  });
});

describe('filterInvRows', () => {
  const vms = [
    inv({ vmid: 100, name: 'web', node: 'n1', status: 'running', ips: ['10.0.0.10'], tags: ['prod'] }),
    inv({ vmid: 101, name: 'db', node: 'n2', status: 'stopped', type: 'lxc' }),
    inv({ vmid: 200, name: 'mail', node: 'n1', status: 'running', cpuPct: 90, ramUsedMb: 8000 }),
  ];
  it('filtre par statut', () => {
    expect(filterInvRows(vms, { ...DEFAULT_INV_FILTER, status: 'running' }).map((v) => v.vmid)).toEqual([100, 200]);
  });
  it('filtre par type', () => {
    expect(filterInvRows(vms, { ...DEFAULT_INV_FILTER, type: 'lxc' }).map((v) => v.vmid)).toEqual([101]);
  });
  it('recherche globale sur nom/ip/tag', () => {
    expect(filterInvRows(vms, { ...DEFAULT_INV_FILTER, search: '10.0.0.10' }).map((v) => v.vmid)).toEqual([100]);
    expect(filterInvRows(vms, { ...DEFAULT_INV_FILTER, search: 'prod' }).map((v) => v.vmid)).toEqual([100]);
  });
  it('plage CPU', () => {
    expect(filterInvRows(vms, { ...DEFAULT_INV_FILTER, cpuMin: 50 }).map((v) => v.vmid)).toEqual([200]);
  });
});

describe('sortInvRows', () => {
  const vms = [
    inv({ vmid: 1, name: 'c', cpuPct: 50 }),
    inv({ vmid: 2, name: 'a', cpuPct: 10 }),
    inv({ vmid: 3, name: 'b', cpuPct: 90 }),
  ];
  it('tri cpuPct décroissant', () => {
    expect(sortInvRows(vms, 'cpuPct', 'desc').map((v) => v.vmid)).toEqual([3, 1, 2]);
  });
  it('tri nom croissant', () => {
    expect(sortInvRows(vms, 'name', 'asc').map((v) => v.name)).toEqual(['a', 'b', 'c']);
  });
  it('nulls last sur cpuPct', () => {
    const withNull = [...vms, inv({ vmid: 9, name: 'null', cpuPct: null })];
    expect(sortInvRows(withNull, 'cpuPct', 'asc').map((v) => v.vmid)).toEqual([2, 1, 3, 9]);
  });
});

describe('invSummary', () => {
  it('agrège RAM/CPU/états', () => {
    const s = invSummary([
      inv({ vmid: 1, name: 'a', status: 'running', ramUsedMb: 1000, cpuPct: 10 }),
      inv({ vmid: 2, name: 'b', status: 'stopped', ramUsedMb: 2000, cpuPct: null }),
    ]);
    expect(s.total).toBe(2);
    expect(s.running).toBe(1);
    expect(s.stopped).toBe(1);
    expect(s.ramUsedMb).toBe(3000);
    expect(s.cpuPctAvg).toBe(10); // moyenne sur les VMs avec cpu défini
  });
});

describe('exports', () => {
  const vms = [inv({ vmid: 100, name: 'web', tags: ['prod'], notes: 'Serveur web' })];
  it('CSV a un BOM + séparateur ; + multi |', () => {
    const csv = invToCsv(vms);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Nom;VMID;Host');
    expect(csv).toContain('"web";"100";');
    expect(csv).toContain('"prod";');
  });
  it('JSON est une liste hiérarchique', () => {
    const parsed = JSON.parse(invToJson(vms));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].cpu.cores).toBe(4);
    expect(parsed[0].tags).toEqual(['prod']);
  });
  it('TXT a un en-tête + bloc par VM', () => {
    const txt = invToTxt(vms);
    expect(txt).toContain('INVENTAIRE PROXMOX — 1 VM(s)');
    expect(txt).toContain('[100] web');
  });
});
