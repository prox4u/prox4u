import { Agent, fetch } from 'undici';
import {
  parseVmNets,
  subnetOf,
  type NodeBridge,
  type NodeNic,
  type PveNodeStatus,
  type PvePool,
  type PveStorage,
  type PveVmResource,
  type PveVmSnapshot,
  type RrddataPoint,
  type VmAgentNetIf,
} from '@prox4u/shared';
import type { EndpointConfig } from './config.js';
import type { DataSource, NodeNetwork, Timeframe, VmConfigInfo } from './data-source.js';

export class PveError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string,
  ) {
    super(`PVE ${status} sur ${path}: ${body.slice(0, 200)}`);
  }
}

const CONFIG_TTL_MS = 60 * 60 * 1000;
const AGENT_NETS_TTL_MS = 60 * 1000;

interface RawVm {
  vmid: number;
  name: string;
  type: string;
  status: string;
  node: string;
  cpu?: number | null;
  mem?: number | null;
  maxmem?: number | null;
  disk?: number | null;
  maxdisk?: number | null;
  netin?: number | null;
  netout?: number | null;
  diskread?: number | null;
  diskwrite?: number | null;
  uptime?: number | null;
  template?: number;
  pool?: string | null;
  storage?: string | null;
  /** IP détectées (guest agent / ARP) — absentes si l'agent ne les rapporte pas. */
  ipaddresses?: string[] | null;
}

/** Interface brute du guest agent (GET .../agent/network-get-interfaces). */
interface RawAgentNet {
  name?: string;
  'hardware-address'?: string | null;
  'ip-addresses'?: Array<{ 'ip-address': string; prefix?: number }> | null;
}

/** IP du guest ignorées dans l'inventaire : loopback et link-local. */
function isIgnoredGuestIp(addr: string): boolean {
  const a = addr.split('/')[0].toLowerCase();
  return a.startsWith('127.') || a === '::1' || a.startsWith('fe80');
}

/** Parsing commun guest agent QEMU / interfaces LXC : exclut lo, loopback et link-local. */
function parseLiveNets(list: RawAgentNet[]): VmAgentNetIf[] {
  return list
    .filter((n) => n.name !== 'lo')
    .map((n) => ({
      name: n.name ?? '',
      mac: n['hardware-address'] ?? null,
      ips: (n['ip-addresses'] ?? [])
        .map((ip) => `${ip['ip-address']}${ip.prefix != null ? `/${ip.prefix}` : ''}`)
        .filter((s) => !isIgnoredGuestIp(s)),
    }));
}

/**
 * Client API Proxmox VE 9.
 *
 * Particularités PVE 9 gérées ici :
 *  - auth via header `Authorization: PVEAPIToken=user@realm!tokenid=value`
 *  - pas de paramètre `no-details` sur /cluster/resources
 *  - rrddata : `cf=AVERAGE` (majuscules), réponse = tableau de points
 *  - /nodes/{n}/status : mémoire dans `memory{}`, cœurs dans `cpuinfo.cpus`,
 *    disque système dans `rootfs{}` (plus de `disks[]`)
 *  - capacités stockage : /storage ne renvoie plus used/total → complétées
 *    via /nodes/{n}/disks/lvmthin (+ rootfs pour les storages dir)
 */
export class Prox4uClient implements DataSource {
  readonly isMock = false;
  private agent: Agent;
  private configCache = new Map<string, { at: number; value: VmConfigInfo | null }>();
  private agentNetsCache = new Map<string, { at: number; value: VmAgentNetIf[] }>();

  constructor(private ep: EndpointConfig, tlsRejectUnauthorized: boolean) {
    this.agent = new Agent({ connect: { rejectUnauthorized: tlsRejectUnauthorized } });
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.ep.url}/api2/json${path}`, {
      headers: { Authorization: `PVEAPIToken=${this.ep.tokenHeader}` },
      dispatcher: this.agent,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PveError(res.status, path, body);
    }
    const json = (await res.json()) as { data: T };
    return json.data;
  }

  async getNodes(): Promise<PveNodeStatus[]> {
    // /cluster/status : le nom du nœud est dans `name` (pas `node`) ;
    // sur un cluster, la 1re entrée est le cluster lui-même (sans type/online) → on ne garde que les vrais nœuds
    const cluster = await this.get<
      Array<{ name?: string; node?: string; type?: string; online: number | boolean; ip?: string }>
    >('/cluster/status');
    return (await Promise.all(
      cluster.filter((c) => c.type === 'node').map(async (c) => {
        const nodeName = c.name ?? c.node;
        if (!nodeName) return null;
        const online = c.online === 1 || c.online === true;
        if (!online) return offlineNode(nodeName, c.ip);
        try {
          const s = await this.get<Record<string, unknown>>(`/nodes/${nodeName}/status`);
          const mem = (s.memory ?? {}) as { total?: number; used?: number };
          const swap = (s.swap ?? {}) as { total?: number; used?: number };
          const cpuinfo = (s.cpuinfo ?? {}) as { cpus?: number };
          const rootfs = (s.rootfs ?? {}) as { total?: number; used?: number };
          return {
            node: nodeName,
            online: true,
            ip: c.ip,
            cpu: num(s.cpu),
            cpus: num(cpuinfo.cpus),
            memTotal: num(mem.total),
            memUsed: num(mem.used),
            swapTotal: num(swap.total),
            swapUsed: num(swap.used),
            loadavg: loadavg(s.loadavg),
            uptime: num(s.uptime),
            rootfsTotal: num(rootfs.total),
            rootfsUsed: num(rootfs.used),
            netin: num(s.netin),
            netout: num(s.netout),
            version: str(s.pveversion),
          };
        } catch {
          return offlineNode(nodeName, c.ip);
        }
      }),
    )).filter((n): n is PveNodeStatus => n !== null);
  }

  async getResources(): Promise<PveVmResource[]> {
    const raw = await this.get<RawVm[]>('/cluster/resources?type=vm');
    const vms: PveVmResource[] = raw.map((r) => ({
      vmid: r.vmid,
      name: r.name,
      type: (r.type === 'lxc' ? 'lxc' : 'qemu') as 'qemu' | 'lxc',
      status: (r.status as PveVmResource['status']) ?? 'unknown',
      node: r.node,
      cpu: num(r.cpu),
      mem: num(r.mem),
      maxmem: num(r.maxmem),
      disk: num(r.disk),
      maxdisk: num(r.maxdisk),
      netin: num(r.netin),
      netout: num(r.netout),
      diskread: num(r.diskread),
      diskwrite: num(r.diskwrite),
      uptime: num(r.uptime),
      template: r.template,
      pool: r.pool ?? null,
      storage: r.storage ?? undefined,
      ipAddresses: Array.isArray(r.ipaddresses) ? r.ipaddresses : undefined,
    }));

    // Jointure cpuAlloc/os/pool depuis la config (cache 1 h, concurrence limitée)
    const missing = vms.filter((v) => !this.configCache.has(key(v.node, v.vmid)));
    await mapLimit(missing, 5, async (v) => {
      const info = await this.fetchVmConfig(v.node, v.vmid, v.type);
      this.configCache.set(key(v.node, v.vmid), { at: Date.now(), value: info });
    });
    for (const v of vms) {
      const cached = this.configCache.get(key(v.node, v.vmid));
      if (cached?.value) {
        v.cpuAlloc = cached.value.cpuAlloc;
        v.os = cached.value.os;
        if (!v.pool && cached.value.pool) v.pool = cached.value.pool;
        // PVE 9 : le champ `storage` de /cluster/resources est absent → on le
        // dérive du disque principal de la config (cache 1 h).
        if (!v.storage && cached.value.diskStorage) v.storage = cached.value.diskStorage;
      }
    }
    return vms;
  }

  async getStorage(): Promise<PveStorage[]> {
    const storages = await this.get<RawStorage[]>('/storage');
    // mêmes entrées que getNodes : filtrer la pseudo-entrée « cluster » d'un vrai cluster
    const cluster = await this.get<Array<{ name?: string; node?: string; type?: string }>>('/cluster/status');
    const nodeNames = cluster
      .filter((n) => n.type === 'node')
      .map((n) => n.name ?? n.node)
      .filter((n): n is string => !!n);

    // Capacités lvmthin par nœud : vg/lv -> {used, total}
    const thinCaps = new Map<string, { used: number; total: number }>();
    const rootfsByNode = new Map<string, { used: number; total: number }>();
    await Promise.all(
      nodeNames.map(async (nodeName) => {
        try {
          const thins = await this.get<Array<{ vg: string; lv: string; used: number; lv_size: number }>>(
            `/nodes/${nodeName}/disks/lvmthin`,
          );
          for (const t of thins) thinCaps.set(`${t.vg}/${t.lv}`, { used: t.used, total: t.lv_size });
        } catch {
          // nœud sans endpoint disks (ou hors ligne) : on ignore
        }
        try {
          const s = await this.get<Record<string, unknown>>(`/nodes/${nodeName}/status`);
          const rootfs = (s.rootfs ?? {}) as { total?: number; used?: number };
          if (num(rootfs.total)) rootfsByNode.set(nodeName, { used: num(rootfs.used) ?? 0, total: num(rootfs.total)! });
        } catch {
          // ignoré
        }
      }),
    );

    const firstNode = nodeNames[0];
    return storages.map((s) => {
      let used: number | null = num(s.used);
      let total: number | null = num(s.total);
      if (s.type === 'lvmthin' && s.vgname && s.thinpool) {
        const cap = thinCaps.get(`${s.vgname}/${s.thinpool}`);
        if (cap) {
          used = cap.used;
          total = cap.total;
        }
      } else if (s.type === 'dir' && firstNode && rootfsByNode.has(firstNode)) {
        // approximation : stockage dir sur le filesystem racine du nœud
        const rf = rootfsByNode.get(firstNode)!;
        used = used ?? rf.used;
        total = total ?? rf.total;
      }
      return {
        storage: s.storage,
        type: s.type as PveStorage['type'],
        content: (s.content ?? '').split(',').filter(Boolean),
        used,
        total,
        shared: s.shared === 1 || s.shared === true,
        nodes: s.nodes ? s.nodes.split(' ').filter(Boolean) : undefined,
      };
    });
  }

  async getPools(): Promise<PvePool[]> {
    const pools = await this.get<Array<{ poolid: string; comment?: string; users?: string[] }>>('/pools');
    return pools.map((p) => ({ poolid: p.poolid, comment: p.comment, users: p.users }));
  }

  /**
   * Réseau des nœuds (GET /nodes/{n}/network).
   * Champs PVE 9 : NICs physiques = `type: "eth"`, appartenance NIC→pont dans
   * `bridge_ports` (chaîne espace-séparée), IP dans `cidr` ou `address`+`netmask`,
   * passerelle dans `gateway`.
   */
  async getNetwork(): Promise<NodeNetwork[]> {
    const nodes = await this.getNodes();
    return (await Promise.all(
      nodes.map(async (n): Promise<NodeNetwork> => {
        if (!n.online) return { node: n.node, online: false, ip: n.ip ?? null, nics: [], bridges: [] };
        try {
          const raw = await this.get<RawNetIf[]>(`/nodes/${n.node}/network`);
          const nics: NodeNic[] = [];
          const bridges: NodeBridge[] = [];
          for (const e of raw) {
            const ip = str(e.cidr) ?? (str(e.address) && str(e.netmask) ? `${e.address}/${e.netmask}` : null);
            const comment = cleanComment(e.comment);
            if (e.type === 'bridge') {
              bridges.push({
                name: str(e.iface) ?? '?',
                ip,
                subnet: subnetOf(ip),
                gateway: str(e.gateway) ?? null,
                ports: (str(e.bridge_ports) ?? '').split(/\s+/).filter(Boolean),
                comment,
              });
            } else {
              nics.push({ name: str(e.iface) ?? '?', ip, subnet: subnetOf(ip), comment });
            }
          }
          return { node: n.node, online: true, ip: n.ip ?? null, nics, bridges };
        } catch {
          // nœud injoignable pour le réseau : topologie partielle (nœud affiché sans liens)
          return { node: n.node, online: false, ip: n.ip ?? null, nics: [], bridges: [] };
        }
      }),
    )) as NodeNetwork[];
  }

  async getVmConfig(node: string, vmid: number, type: 'qemu' | 'lxc'): Promise<VmConfigInfo | null> {
    const k = key(node, vmid);
    const cached = this.configCache.get(k);
    if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.value;
    const value = await this.fetchVmConfig(node, vmid, type);
    this.configCache.set(k, { at: Date.now(), value });
    return value;
  }

  private async fetchVmConfig(node: string, vmid: number, type: 'qemu' | 'lxc'): Promise<VmConfigInfo | null> {
    try {
      const c = await this.get<Record<string, unknown>>(`/nodes/${node}/${type}/${vmid}/config`);
      return {
        cpuAlloc: num(c.cores) ?? 0,
        os: type === 'qemu' ? friendlyOs(str(c.os)) : 'LXC',
        pool: str(c.pool) ?? null,
        nets: parseVmNets(type, c),
        diskStorage: diskStorageOf(c, type),
      };
    } catch {
      return null;
    }
  }

  async getVmSnapshots(node: string, vmid: number, type: 'qemu' | 'lxc'): Promise<PveVmSnapshot[]> {
    try {
      const list = await this.get<Record<string, unknown>[]>(`/nodes/${node}/${type}/${vmid}/snapshot`);
      // PVE renvoie une pseudo-entrée « current » (état courant) — ce n'est pas un snapshot.
      return list
        .filter((s) => str(s.name) !== 'current')
        .map((s) => ({
          name: str(s.name) ?? '',
          time: num(s.snaptime),
          memory: s.memory === 1 || s.memory === true,
          note: str(s.note) ?? undefined,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Interfaces réseau telles que vues par l'agent invité (QEMU guest agent) —
   * GET /nodes/{n}/qemu/{vmid}/agent/network-get-interfaces.
   * Loopback (127./::1) et link-local (fe80::) exclus. [] si VM arrêtée ou agent absent.
   */
  async getVmAgentNets(node: string, vmid: number): Promise<VmAgentNetIf[]> {
    const k = key(node, vmid);
    const cached = this.agentNetsCache.get(k);
    if (cached && Date.now() - cached.at < AGENT_NETS_TTL_MS) return cached.value;
    const value = await this.fetchVmAgentNets(node, vmid);
    this.agentNetsCache.set(k, { at: Date.now(), value });
    return value;
  }

  /**
   * Interfaces réseau d'un conteneur LXC (PVE ≥ 9) — GET /nodes/{n}/lxc/{vmid}/interfaces.
   * PVE lit le netns côté hôte : fonctionne avec ip=manual/dhcp, aucun agent requis.
   * Mêmes filtrages que le guest agent QEMU. [] si conteneur arrêté.
   */
  async getLxcInterfaces(node: string, vmid: number): Promise<VmAgentNetIf[]> {
    const k = key(node, vmid); // vmid unique par nœud (QEMU et LXC partagent l'espace d'IDs)
    const cached = this.agentNetsCache.get(k);
    if (cached && Date.now() - cached.at < AGENT_NETS_TTL_MS) return cached.value;
    const value = await this.fetchLxcInterfaces(node, vmid);
    this.agentNetsCache.set(k, { at: Date.now(), value });
    return value;
  }

  private async fetchVmAgentNets(node: string, vmid: number): Promise<VmAgentNetIf[]> {
    try {
      const raw = await this.get<{ result?: RawAgentNet[] } | RawAgentNet[]>(
        `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
      );
      return parseLiveNets(Array.isArray(raw) ? raw : (raw?.result ?? []));
    } catch {
      return [];
    }
  }

  private async fetchLxcInterfaces(node: string, vmid: number): Promise<VmAgentNetIf[]> {
    try {
      const raw = await this.get<RawAgentNet[] | { result?: RawAgentNet[] }>(`/nodes/${node}/lxc/${vmid}/interfaces`);
      return parseLiveNets(Array.isArray(raw) ? raw : (raw?.result ?? []));
    } catch {
      return [];
    }
  }

  async getRrddata(
    kind: 'node' | 'vm',
    node: string,
    vmid: number | undefined,
    timeframe: Timeframe,
    vmType?: 'qemu' | 'lxc',
  ): Promise<RrddataPoint[]> {
    const path =
      kind === 'node'
        ? `/nodes/${node}/rrddata?timeframe=${timeframe}&cf=AVERAGE`
        : `/nodes/${node}/${vmType ?? 'qemu'}/${vmid}/rrddata?timeframe=${timeframe}&cf=AVERAGE`;
    const raw = await this.get<Array<Record<string, unknown>>>(path);
    return raw
      .map((p) => ({
        time: num(p.time) ?? 0,
        cpu: num(p.cpu),
        mem: num(p.mem) ?? num(p.memused),
        disk: num(p.disk) ?? num(p.rootused),
        netin: num(p.netin),
        netout: num(p.netout),
      }))
      .filter((p) => p.cpu !== null || p.mem !== null);
  }
}

interface RawStorage {
  storage: string;
  type: string;
  content?: string;
  used?: number | null;
  total?: number | null;
  shared?: number | boolean;
  vgname?: string;
  thinpool?: string;
  /** Nœuds exposant le datastore (chaîne espace-séparée, ex. « pve1 pve2 »). */
  nodes?: string | null;
}

/** Entrée brute de GET /nodes/{n}/network (seuls les champs utilisés). */
interface RawNetIf {
  iface?: string;
  type?: string;
  cidr?: string | null;
  address?: string | null;
  netmask?: string | null;
  gateway?: string | null;
  bridge_ports?: string | null;
  comment?: string | null;
}

/** Commentaires PVE : chaîne parfois multi-lignes avec \n final → on nettoie. */
function cleanComment(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+$/g, '').trim();
  return s.length > 0 ? s : null;
}

function offlineNode(node: string, ip: string | undefined): PveNodeStatus {
  return {
    node,
    online: false,
    ip,
    cpu: null,
    cpus: null,
    memTotal: null,
    memUsed: null,
    swapTotal: null,
    swapUsed: null,
    loadavg: null,
    uptime: null,
    rootfsTotal: null,
    rootfsUsed: null,
    netin: null,
    netout: null,
  };
}

function key(node: string, vmid: number): string {
  return `${node}/${vmid}`;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // l'API PVE renvoie certains champs en chaînes (ex. loadavg)
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function loadavg(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const l = v.map((x) => num(x));
  return l.every((x) => x !== null) ? (l as [number, number, number]) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Datastore du disque principal, parsé de la config VM.
 * PVE 9 ne renvoie plus le champ `storage` dans /cluster/resources.
 * Formats de volume : « storage:volume[,params] » (dir, lvm, lvmthin, nfs…)
 * ou « pool/volume » (zfs, rbd). Les ISO (iso/…) ne sont pas des disques.
 */
export function diskStorageOf(c: Record<string, unknown>, type: 'qemu' | 'lxc'): string | undefined {
  const vol = type === 'lxc' ? str(c.rootfs) : firstDiskVolume(c);
  if (!vol) return undefined;
  const head = vol.split(',')[0];
  const m = head.match(/^([A-Za-z0-9._-]+):?\/?/);
  if (!m) return undefined;
  if (head.includes('/iso/') || /\.iso$/i.test(head)) return undefined;
  return m[1];
}

/** Premier disque qemu non-ISO, dans l'ordre de priorité du disque de boot. */
function firstDiskVolume(c: Record<string, unknown>): string | undefined {
  for (const k of ['scsi0', 'virtio0', 'sata0', 'ide0', 'scsi1', 'virtio1', 'sata1', 'ide1']) {
    const v = str(c[k]);
    if (v) return v;
  }
  return undefined;
}

function friendlyOs(os?: string): string {
  if (!os) return 'Autre';
  const o = os.toLowerCase();
  if (o.startsWith('win')) return 'Windows';
  if (o.startsWith('l') || o === 'linux' || o === 'bsd' || o === 'solaris') return 'Linux/Unix';
  return 'Autre';
}

/** map avec concurrence limitée */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}
