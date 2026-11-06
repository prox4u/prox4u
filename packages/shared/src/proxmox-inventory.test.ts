import { describe, expect, it } from 'vitest';
import type { InvVm } from './proxmox-inventory';
import {
  DEFAULT_INV_FILTER,
  filterInvRows,
  fmtSize,
  invSummary,
  invToCsv,
  invToJson,
  invToTxt,
  invTotalDiskMb,
  archLabel,
  osDisplay,
  osFamilyFromId,
  osPrettyFromOstype,
  ostypeFamily,
  sortInvRows,
} from './proxmox-inventory';

function inv(partial: Partial<InvVm> & Pick<InvVm, 'vmid' | 'name'>): InvVm {
  return {
    host: 'ep1',
    hostname: null,
    node: 'n1',
    type: 'qemu',
    status: 'running',
    template: false,
    osType: 'Linux/Unix',
    osPretty: 'Ubuntu 24.04 LTS',
    osKernel: '6.17.0-generic',
    osArch: 'x86_64',
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
    agentActive: null,
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
  it('osDisplay : OS réel sinon distro (ostype) sinon famille', () => {
    expect(osDisplay({ osType: 'Linux/Unix', osPretty: 'Ubuntu 24.04 LTS' })).toBe('Ubuntu 24.04 LTS');
    expect(osDisplay({ osType: 'Linux/Unix', osPretty: 'Debian' })).toBe('Debian');
    expect(osDisplay({ osType: 'Linux/Unix', osPretty: null })).toBe('Linux/Unix');
  });
  it('osPrettyFromOstype : distro amicale (LXC) / null (code QEMU)', () => {
    expect(osPrettyFromOstype('debian')).toBe('Debian');
    expect(osPrettyFromOstype('ubuntu')).toBe('Ubuntu');
    expect(osPrettyFromOstype('linux')).toBe('Linux');
    expect(osPrettyFromOstype('w2k22')).toBe('Windows');
    expect(osPrettyFromOstype('l26')).toBeNull(); // code court → pas de distro connue
    expect(osPrettyFromOstype(undefined)).toBeNull();
  });
  it('archLabel : normalise amd64/x86_64/arm64', () => {
    expect(archLabel('amd64')).toBe('x86_64');
    expect(archLabel('x86_64')).toBe('x86_64');
    expect(archLabel('i386')).toBe('x86');
    expect(archLabel('aarch64')).toBe('arm64');
    expect(archLabel(null)).toBeNull();
  });
  it('fmtSize : unités Mo / Go / To', () => {
    expect(fmtSize(6)).toBe('6 Mo');
    expect(fmtSize(1073)).toBe('1.0 Go');
    expect(fmtSize(7606)).toBe('7.4 Go');
    expect(fmtSize(1466031)).toBe('1.40 To');
    expect(fmtSize(815781)).toBe('796.7 Go'); // sous le To → reste en Go
    expect(fmtSize(1048576)).toBe('1.00 To');
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
  it('filtre par état de l’agent (actif / inactif / n-a)', () => {
    const rows = [
      inv({ vmid: 1, name: 'ok', agentActive: true }),
      inv({ vmid: 2, name: 'down', agentActive: false }),
      inv({ vmid: 3, name: 'na', type: 'lxc', agentActive: null }),
    ];
    expect(filterInvRows(rows, { ...DEFAULT_INV_FILTER, agent: 'active' }).map((v) => v.vmid)).toEqual([1]);
    expect(filterInvRows(rows, { ...DEFAULT_INV_FILTER, agent: 'down' }).map((v) => v.vmid)).toEqual([2]);
    expect(filterInvRows(rows, { ...DEFAULT_INV_FILTER, agent: 'na' }).map((v) => v.vmid)).toEqual([3]);
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
  it('agentActive : inactif (critique) d’abord en asc, nulls last dans les deux sens', () => {
    const rows = [
      inv({ vmid: 1, name: 'ok', agentActive: true }),
      inv({ vmid: 2, name: 'down', agentActive: false }),
      inv({ vmid: 3, name: 'na', agentActive: null }),
    ];
    expect(sortInvRows(rows, 'agentActive', 'asc').map((v) => v.vmid)).toEqual([2, 1, 3]);
    expect(sortInvRows(rows, 'agentActive', 'desc').map((v) => v.vmid)).toEqual([1, 2, 3]);
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
  it('agentOk = nombre de VMs dont l’agent invité est actif (null exclu)', () => {
    const s = invSummary([
      inv({ vmid: 1, name: 'a', agentActive: true }),
      inv({ vmid: 2, name: 'b', agentActive: false }),
      inv({ vmid: 3, name: 'c', type: 'lxc', agentActive: null }),
    ]);
    expect(s.agentOk).toBe(1);
  });
});

describe('exports', () => {
  const vms = [inv({ vmid: 100, name: 'web', hostname: 'web-01', tags: ['prod'], notes: 'Serveur web' })];
  it('CSV a un BOM + séparateur ; + multi | + nom d\'hôte', () => {
    const csv = invToCsv(vms);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Nom;Nom d\'hôte;VMID;Host');
    expect(csv).toContain('"web";"web-01";"100";');
    expect(csv).toContain('"prod";');
  });
  it('JSON est une liste hiérarchique (+ hostname)', () => {
    const parsed = JSON.parse(invToJson(vms));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].cpu.cores).toBe(4);
    expect(parsed[0].tags).toEqual(['prod']);
    expect(parsed[0].hostname).toBe('web-01');
    expect(parsed[0].os.name).toBe('Ubuntu 24.04 LTS');
  });
  it('TXT a un en-tête + bloc par VM (+ hôte)', () => {
    const txt = invToTxt(vms);
    expect(txt).toContain('INVENTAIRE PROXMOX — 1 VM(s)');
    expect(txt).toContain('[100] web');
    expect(txt).toContain('Hôte     : web-01');
  });
});
