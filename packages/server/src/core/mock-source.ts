import type { AgentFsUsage, ParsedVmNet, PveClusterStatus, PveNodeStatus, PvePool, PveReplicationStatus, PveStorage, PveVmResource, PveVmSnapshot, QuorumState, RrddataPoint, VmAgentNetIf, VmOsInfo } from '@prox4u/shared';
import type { DataSource, NodeNetwork, Timeframe, VmConfigInfo } from './data-source.js';

const GB = 1024 ** 3;
const DAY = 86_400;

export interface MockSite {
  id: string;
  name: string;
  nodes: string[];
}

/** Topologie de démo : 3 bâtiments (indépendante de sites.json). */
export const MOCK_SITES: MockSite[] = [
  { id: 'bat-a', name: 'Bâtiment A', nodes: ['pve1', 'pve2', 'pve3'] },
  { id: 'bat-b', name: 'Bâtiment B', nodes: ['pve4', 'pve5', 'pve6'] },
  { id: 'bat-c', name: 'Bâtiment C', nodes: ['pve7', 'pve8'] },
];

/** Bâtiments avec un 2e pont « nfs » sans IP (comme le cluster réel). */
const NFS_SITES = new Set(['bat-a']);

/** Sous-réseau du bâtiment n (10 + 10×index) : bat-a → 192.168.10.0/24, etc. */
function siteSubnet(si: number): string {
  return `192.168.${10 + si * 10}.0/24`;
}

function siteNodeIp(si: number, node: string): string {
  return `192.168.${10 + si * 10}.${10 + Number(node.slice(3))}`;
}

type Scenario = 'nominal' | 'degraded' | 'critical';

/** Profils d'allocation [cœurs, Go] par site — calibrés pour les 3 jauges PRA. */
const PROFILES: Record<Scenario, { a: [number, number][]; b: [number, number][]; c: [number, number][]; offline?: string }> = {
  nominal: {
    a: [[8, 32], [8, 32], [6, 24], [6, 24], [4, 16], [4, 16], [4, 16]],
    b: [[8, 32], [6, 24], [4, 16], [4, 16], [4, 16], [2, 8], [2, 8]],
    c: [[4, 16], [2, 8]],
  },
  degraded: {
    a: [[12, 48], [12, 48], [10, 40], [10, 40], [8, 32]],
    b: [[8, 32], [6, 24], [4, 16], [4, 16], [4, 16], [2, 8]],
    c: [[4, 16], [2, 8]],
  },
  critical: {
    a: [[16, 64], [16, 64], [14, 56], [14, 56], [12, 48], [8, 32]],
    b: [[10, 40], [8, 32], [6, 24], [6, 24], [4, 16], [4, 16]],
    c: [[4, 16], [2, 8]],
    offline: 'pve3',
  },
};

const POOLS = ['prod', 'finance', 'rd', 'lab'];
const NAMES: Record<string, string[]> = {
  prod: ['web', 'api', 'db', 'cache', 'mq'],
  finance: ['erp', 'compta', 'paie', 'factur'],
  rd: ['ci', 'staging', 'dev', 'test'],
  lab: ['poc', 'sandbox', 'demo'],
};

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MAC déterministe dérivée du vmid (démo). */
function mockMac(vmid: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `BC:24:11:${h((vmid >> 8) & 0xff)}:${h(vmid & 0xff)}:${h((vmid * 7) & 0xff)}`;
}

interface MockVm {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  node: string;
  siteId: string;
  cpuAlloc: number;
  maxmem: number;
  os: string;
  pool: string | null;
  /** datastore qui héberge le disque de la VM (ceph partagé ou local-{node}). */
  storage: string;
  /** facteur d'utilisation courant (0..1) */
  usageCpu: number;
  usageMem: number;
}

/**
 * Source mock déterministe (seed fixe) avec léger jitter « live » à chaque tick.
 * Scénarios : nominal (vert), degraded (PRA orange + RAM haute), critical
 * (nœud down + PRA rouge).
 *
 * `sites` restreint la topologie simulée (démo multi-endpoints : chaque
 * endpoint reçoit son propre sous-ensemble de bâtiments).
 */
export class MockSource implements DataSource {
  readonly isMock = true;
  private vms: MockVm[] = [];
  private nodeLoad: Record<string, number> = {};
  private cephUsedRatio: number;

  constructor(private scenario: Scenario, private sites: MockSite[] = MOCK_SITES) {
    const rng = mulberry32(42);
    let vmid = 100;
    const profile = PROFILES[scenario];
    // Le datastore « ceph » partagé n'existe que si l'endpoint héberge bat-a
    // (cohérent avec getStorage — pas de double-comptage en vue d'ensemble).
    const hasCeph = this.sites.some((s) => s.id === 'bat-a');

    const buildSite = (siteId: string, nodes: string[], allocs: [number, number][], extra: number) => {
      for (let i = 0; i < extra; i++) allocs.push([1, 2]);
      for (const [cpu, memGb] of allocs) {
        const pool = POOLS[Math.floor(rng() * POOLS.length)];
        const family = NAMES[pool][Math.floor(rng() * NAMES[pool].length)];
        const isLxc = rng() < 0.2;
        const os = isLxc ? 'LXC' : rng() < 0.65 ? 'Linux/Unix' : 'Windows';
        const node = nodes[Math.floor(rng() * nodes.length)];
        // ~70 % des disques sur le Ceph partagé, le reste sur le local du nœud.
        const storage = hasCeph && rng() < 0.7 ? 'ceph' : `local-${node}`;
        this.vms.push({
          vmid: vmid++,
          name: `${family}-${String(vmid).padStart(2, '0')}`,
          type: isLxc ? 'lxc' : 'qemu',
          node,
          siteId,
          cpuAlloc: cpu,
          maxmem: memGb * GB,
          os,
          pool: rng() < 0.85 ? pool : null,
          storage,
          usageCpu: 0.1 + rng() * 0.4,
          usageMem: 0.35 + rng() * 0.35,
        });
      }
    };

    const allocsBySite: Record<string, [number, number][]> = { 'bat-a': profile.a, 'bat-b': profile.b, 'bat-c': profile.c };
    for (const s of this.sites) buildSite(s.id, s.nodes, [...(allocsBySite[s.id] ?? [])], 3);

    const base = scenario === 'nominal' ? 0.3 : scenario === 'degraded' ? 0.55 : 0.7;
    for (const s of this.sites) for (const n of s.nodes) this.nodeLoad[n] = base + rng() * 0.15;

    this.cephUsedRatio = scenario === 'nominal' ? 0.4 : scenario === 'degraded' ? 0.6 : 0.85;
  }

  private jitter(v: number, amp: number): number {
    return Math.max(0.01, Math.min(0.99, v + (Math.random() - 0.5) * amp));
  }

  async getNodes(): Promise<PveClusterStatus> {
    const offline = PROFILES[this.scenario].offline;
    const nodes = this.sites.flatMap((s, si) =>
      s.nodes.map((node) => {
        const online = node !== offline;
        if (!online) {
          return {
            node, online: false, cpu: null, cpus: 32, memTotal: 128 * GB, memUsed: null,
            swapTotal: 8 * GB, swapUsed: null, loadavg: null, uptime: null,
            rootfsTotal: 200 * GB, rootfsUsed: null, netin: null, netout: null,
          } satisfies PveNodeStatus;
        }
        const vms = this.vms.filter((v) => v.node === node);
        const cpu = vms.reduce((sum, v) => sum + v.cpuAlloc * this.jitter(v.usageCpu, 0.1), 0);
        const memUsed = 4 * GB + vms.reduce((sum, v) => sum + v.maxmem * this.jitter(v.usageMem, 0.06), 0);
        return {
          node,
          online: true,
          ip: siteNodeIp(si, node),
          cpu,
          cpus: 32,
          memTotal: 128 * GB,
          memUsed,
          swapTotal: 8 * GB,
          swapUsed: 0.5 * GB,
          loadavg: [cpu / 4, cpu / 4, cpu / 4],
          uptime: 30 * DAY + Number(node.slice(3)) * DAY,
          rootfsTotal: 200 * GB,
          rootfsUsed: (60 + Number(node.slice(3)) * 5) * GB,
          netin: vms.reduce((s) => s + 1e6 + Math.random() * 5e6, 0),
          netout: vms.reduce((s) => s + 1e6 + Math.random() * 5e6, 0),
        } satisfies PveNodeStatus;
      }),
    );
    // Quorum de démo : majorité des nœuds. Le scénario « critical » force la perte
    // de quorum pour tester la chaîne complète (pénalité health + alerte + badge).
    const quorum = Math.floor(nodes.length / 2) + 1;
    const quorumState: QuorumState = this.scenario === 'critical' ? 'lost' : 'ok';
    return { nodes, quorum, quorumState };
  }

  async getResources(): Promise<PveVmResource[]> {
    const offline = PROFILES[this.scenario].offline;
    return this.vms.map((v) => {
      const running = v.node !== offline && Math.random() > 0.03;
      const cpu = running ? v.cpuAlloc * this.jitter(v.usageCpu, 0.1) : 0;
      const mem = running ? v.maxmem * this.jitter(v.usageMem, 0.06) : 0;
      return {
        vmid: v.vmid,
        name: v.name,
        type: v.type,
        status: running ? 'running' : 'stopped',
        node: v.node,
        cpu,
        cpuAlloc: v.cpuAlloc,
        os: v.os,
        mem,
        maxmem: v.maxmem,
        disk: Math.round(v.maxmem * 2),
        maxdisk: v.maxmem * 4,
        netin: running ? 1e6 + Math.random() * 5e6 : 0,
        netout: running ? 1e6 + Math.random() * 5e6 : 0,
        diskread: running ? Math.random() * 2e7 : 0,
        diskwrite: running ? Math.random() * 2e7 : 0,
        uptime: running ? 3 * DAY + Math.random() * 20 * DAY : null,
        pool: v.pool,
        storage: v.storage,
        // Disques (datastore + taille allouée) — synthétisés du datastore de la VM (démo),
        // cohérent avec maxdisk. Permet à la cartographie / ratio thin de fonctionner en mock.
        disks: v.storage ? [{ storage: v.storage, sizeBytes: v.maxmem * 4 }] : undefined,
        // IP « détectées » déterministes par vmid (démo — en prod, l'agent invité doit les rapporter)
        ipAddresses: running ? [`10.9.${Math.floor(v.vmid / 250)}.${(v.vmid % 250) + 1}`] : [],
      } satisfies PveVmResource;
    });
  }

  async getStorage(): Promise<PveStorage[]> {
    const storages: PveStorage[] = [];
    const allNodes = this.sites.flatMap((s) => s.nodes);
    // Ceph « partagé » : rattaché à l'endpoint qui contient bat-a (pas de double-comptage en vue d'ensemble)
    if (this.sites.some((s) => s.id === 'bat-a')) {
      const cephTotal = 20 * 1024 * GB;
      storages.push({
        storage: 'ceph',
        type: 'rbd',
        content: ['rootdir', 'images', 'iso', 'backup'],
        used: Math.round(cephTotal * this.jitter(this.cephUsedRatio, 0.01)),
        total: cephTotal,
        shared: true,
        nodes: allNodes,
      });
    }
    for (const s of this.sites) {
      for (const n of s.nodes) {
        storages.push({
          storage: `local-${n}`,
          type: 'dir',
          content: ['iso', 'backup'],
          used: Math.round(60 * GB),
          total: 200 * GB,
          nodes: [n],
        });
      }
    }
    return storages;
  }

  async getPools(): Promise<PvePool[]> {
    return POOLS.map((p) => ({ poolid: p, comment: `Équipe ${p}` }));
  }

  /** Réseau simulé : vmbr0 par nœud (IP du sous-réseau du bâtiment) + pont « nfs » sans IP sur bat-a. */
  async getNetwork(): Promise<NodeNetwork[]> {
    const offline = PROFILES[this.scenario].offline;
    return this.sites.flatMap((s, si) =>
      s.nodes.map((node): NodeNetwork => {
        const online = node !== offline;
        const ip = siteNodeIp(si, node);
        return {
          node,
          online,
          ip: online ? ip : null,
          nics: [
            { name: 'nic0', ip: null, subnet: null, comment: null },
            { name: 'nic1', ip: null, subnet: null, comment: null },
          ],
          bridges: [
            {
              name: 'vmbr0',
              ip: `${ip}/24`,
              subnet: siteSubnet(si),
              gateway: `192.168.${10 + si * 10}.254`,
              ports: ['nic0'],
              comment: null,
            },
            ...(NFS_SITES.has(s.id)
              ? [{ name: 'nfs', ip: null, subnet: null, gateway: null, ports: [], comment: 'Stockage NFS' }]
              : []),
          ],
          bonds: [],
        };
      }),
    );
  }

  /** Aucun job de réplication dans le mock. */
  async getReplicationStatus(): Promise<PveReplicationStatus[]> {
    return [];
  }

  async getVmConfig(node: string, vmid: number): Promise<VmConfigInfo | null> {
    const v = this.vms.find((x) => x.node === node && x.vmid === vmid);
    if (!v) return null;
    const site = this.sites.find((s) => s.nodes.includes(node));
    // bat-a : VLAN déterministe sur l'interface principale (10/20/30/40 selon vmid) ;
    // les autres bâtiments restent sans VLAN (couche segment masquée → path adaptative).
    const vlan = site?.id === 'bat-a' ? 10 + (vmid % 4) * 10 : null;
    const nets: ParsedVmNet[] = [{ iface: 'net0', bridge: 'vmbr0', ip: null, mac: mockMac(vmid), tag: vlan }];
    // ~1/3 des VMs du bâtiment NFS ont aussi une 2e interface sur le pont nfs (sans VLAN)
    if (site && NFS_SITES.has(site.id) && vmid % 3 === 0) {
      nets.push({ iface: 'net1', bridge: 'nfs', ip: null, mac: mockMac(vmid + 1), tag: null });
    }
    return { cpuAlloc: v.cpuAlloc, os: v.os, pool: v.pool, nets, diskStorage: v.storage };
  }

  async getVmSnapshots(node: string, vmid: number): Promise<PveVmSnapshot[]> {
    const v = this.vms.find((x) => x.node === node && x.vmid === vmid);
    if (!v) return [];
    // Déterministe : ~1/4 des VMs running ont 2 snapshots, ~1/4 un snapshot.
    const now = Math.floor(Date.now() / 1000);
    if (vmid % 4 === 0) {
      return [
        { name: `snap-${vmid}-b`, time: now - 7 * 86400, memory: true, note: 'avant migration' },
        { name: `snap-${vmid}-a`, time: now - 30 * 86400, memory: false },
      ];
    }
    if (vmid % 4 === 2) {
      return [{ name: `snap-${vmid}`, time: now - 14 * 86400, memory: true }];
    }
    return [];
  }

  async getVmAgentNets(node: string, vmid: number): Promise<VmAgentNetIf[]> {
    return this.mockLiveNets(node, vmid, 'qemu');
  }

  async getLxcInterfaces(node: string, vmid: number): Promise<VmAgentNetIf[]> {
    return this.mockLiveNets(node, vmid, 'lxc');
  }

  /** Mock : usage disque simulé PAR FILESYSTEM (une fraction déterministe de l'allocation) si la VM est running. */
  async getAgentFsUsage(node: string, vmid: number): Promise<AgentFsUsage[] | null> {
    const v = this.vms.find((x) => x.node === node && x.vmid === vmid);
    // même règle que getResources : running si le nœud est online (pas de tirage aléatoire ici, déterminisme)
    if (!v || v.type !== 'qemu' || node === PROFILES[this.scenario].offline) return null;
    // même allocation que getResources (maxdisk = maxmem * 4)
    const total = v.maxmem * 4;
    if (total <= 0) return null;
    // fraction déterministe (55–85 %) selon le vmid — usage simulé mais stable
    const frac = 0.55 + ((vmid * 7) % 30) / 100;
    // deux partitions simulées : `/` (sda1, 20 % de l'allocation) + `/data` (sda2, 80 %)
    const rootTotal = Math.round(total * 0.2);
    const dataTotal = total - rootTotal;
    return [
      { mountpoint: '/', dev: 'sda1', usedBytes: Math.round(rootTotal * frac), totalBytes: rootTotal },
      { mountpoint: '/data', dev: 'sda2', usedBytes: Math.round(dataTotal * frac), totalBytes: dataTotal },
    ];
  }

  /** Démo : pas d'agent invité → pas d'OS réel (la famille OS se replie sur la config `ostype`). */
  async getOsInfo(_node: string, _vmid: number): Promise<VmOsInfo | null> {
    return null;
  }

  /** Mock : bundle agent = les méthodes individuelles (fs déterministe, osinfo null, nets simulés). */
  async getAgentBundle(
    node: string,
    vmid: number,
    type: 'qemu' | 'lxc',
    status: string,
  ): Promise<{ fs: AgentFsUsage[] | null; osinfo: VmOsInfo | null; nets: VmAgentNetIf[] }> {
    const running = status === 'running';
    const [fs, osinfo, nets] = await Promise.all([
      type === 'qemu' && running ? this.getAgentFsUsage(node, vmid) : Promise.resolve(null),
      this.getOsInfo(node, vmid),
      type === 'qemu' ? this.getVmAgentNets(node, vmid) : this.getLxcInterfaces(node, vmid),
    ]);
    return { fs, osinfo, nets };
  }

  /** Mock : pas de cache agent — toujours undefined (le poller n'écrit pas Influx en mode mock). */
  cachedFsUsage(_node: string, _vmid: number): AgentFsUsage[] | undefined {
    return undefined;
  }

  /** Déterministe : même MAC que la config net0 (mockMac) + IP identique à getResources. */
  private mockLiveNets(node: string, vmid: number, type: 'qemu' | 'lxc'): VmAgentNetIf[] {
    const v = this.vms.find((x) => x.node === node && x.vmid === vmid);
    if (!v || v.type !== type || v.node === PROFILES[this.scenario].offline) return [];
    return [{ name: 'eth0', mac: mockMac(vmid), ips: [`10.9.${Math.floor(vmid / 250)}.${(vmid % 250) + 1}/24`] }];
  }

  /** Résolution des points par timeframe (alignée sur le comportement PVE). */
  private static readonly RES: Record<Timeframe, { points: number; stepSec: number }> = {
    hour: { points: 60, stepSec: 60 },
    day: { points: 288, stepSec: 300 },
    week: { points: 168, stepSec: 3_600 },
    month: { points: 30, stepSec: DAY },
    year: { points: 365, stepSec: DAY },
  };

  async getRrddata(
    kind: 'node' | 'vm',
    node: string,
    vmid: number | undefined,
    timeframe: Timeframe,
  ): Promise<RrddataPoint[]> {
    const { points, stepSec } = MockSource.RES[timeframe];
    const now = Math.floor(Date.now() / 1000);
    const rng = mulberry32(7 + node.length * 13 + (vmid ?? 0));

    // nœud : cpu en unités de cœurs (0..cpus) ; VM : fraction des cœurs alloués (0..1)
    let cpuNow: number;
    let memNowBytes: number;
    let memTotal: number;
    if (kind === 'node') {
      const { nodes } = await this.getNodes();
      const n = nodes.find((x) => x.node === node);
      cpuNow = n?.cpu ?? 0;
      memNowBytes = n?.memUsed ?? 0;
      memTotal = 128 * GB;
    } else {
      const v = this.vms.find((x) => x.vmid === vmid);
      cpuNow = v?.usageCpu ?? 0;
      memNowBytes = v ? v.maxmem * v.usageMem : 0;
      memTotal = v?.maxmem ?? GB;
    }

    // Cycle diurne (pic en journée) + croissance douce sur la période
    return Array.from({ length: points }, (_, i) => {
      const t = now - (points - 1 - i) * stepSec;
      const progress = i / (points - 1);
      const hourOfDay = new Date(t * 1000).getHours() + new Date(t * 1000).getMinutes() / 60;
      const diurnal = 0.85 + 0.3 * Math.sin(((hourOfDay - 9) / 24) * Math.PI * 2);
      const wobble = (rng() - 0.5) * 0.04;
      const growth = 0.75 + 0.25 * progress;
      return {
        time: t,
        cpu: Math.max(0.01, cpuNow * diurnal * growth + wobble),
        mem: Math.max(GB, memNowBytes * (0.85 + 0.15 * diurnal) * (0.8 + 0.2 * progress) + wobble * memTotal),
        disk: memTotal * 2 * (0.9 + 0.1 * progress),
        netin: Math.max(1e5, (5e6 + rng() * 1e7) * diurnal),
        netout: Math.max(1e5, (5e6 + rng() * 1e7) * diurnal),
      } satisfies RrddataPoint;
    });
  }
}
