import { Agent, fetch } from 'undici';
import {
  parseVmNets,
  subnetOf,
  type AgentFsUsage,
  type NodeBridge,
  type NodeNic,
  type PveNodeStatus,
  type PvePool,
  type PveStorage,
  type PveVmResource,
  type PveVmSnapshot,
  type RrddataPoint,
  type VmAgentNetIf,
  type VmDisk,
  type VmOsInfo,
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
/** Borne d'attente de l'agent invité pour l'usage disque (get-fsinfo) — appel posé sur le chemin du poller. */
const AGENT_DISK_USAGE_TIMEOUT_MS = 8000;
/** TTL du cache OS réel (get-osinfo) : l'OS d'une VM ne change pas — 5 min, aligné sur le cache de la route. */
const AGENT_OSINFO_TTL_MS = 5 * 60 * 1000;
/** Borne d'attente de l'agent invité pour le OS (get-osinfo). */
const AGENT_OSINFO_TIMEOUT_MS = 8000;
/** TTL du cache usage disque (get-fsinfo) : l'usage change lentement — 5 min, comme l'osinfo. */
const AGENT_FSINFO_TTL_MS = 5 * 60 * 1000;
/**
 * Concurrence bornée des appels agent (get-fsinfo / get-osinfo / interfaces) : le pool undici
 * fait 100 connexions/origine — 20 en vol évite l'épuisement, et un guest lent (timeout 8 s)
 * retient au plus 20 appels, pas N. Partagée poller (réchauffage) + route (inventaire).
 */
export const AGENT_CONCURRENCY = 20;

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

/** Filesystem brut du guest agent (GET .../agent/get-fsinfo). `disk` vide = fs non rattaché à un disque VM. */
interface RawAgentFs {
  mountpoint?: string;
  name?: string;
  type?: string;
  'used-bytes'?: number;
  'total-bytes'?: number;
  'total-bytes-privileged'?: number;
  disk?: unknown[];
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
  private osInfoCache = new Map<string, { at: number; value: VmOsInfo | null }>();
  /** Usage disque par filesystem (get-fsinfo) — cache 5 min, source unique poller + route. */
  private fsUsageCache = new Map<string, { at: number; value: AgentFsUsage[] }>();

  constructor(private ep: EndpointConfig, tlsRejectUnauthorized: boolean) {
    this.agent = new Agent({ connect: { rejectUnauthorized: tlsRejectUnauthorized } });
  }

  /**
   * GET PVE. `timeoutMs` borne l'appel (AbortSignal) — indispensable pour les appels
   * agent (get-fsinfo) posés sur le chemin critique du poller : un agent lent ne doit
   * jamais bloquer le tick (garde `ticking` → tous les ticks suivants seraient sautés).
   */
  private async get<T>(path: string, timeoutMs?: number): Promise<T> {
    const res = await fetch(`${this.ep.url}/api2/json${path}`, {
      headers: { Authorization: `PVEAPIToken=${this.ep.tokenHeader}` },
      dispatcher: this.agent,
      ...(timeoutMs != null ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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
        // Disques (datastore + taille allouée) — joints depuis la config.
        if (cached.value.disks) v.disks = cached.value.disks;
        // Tags + description — joints depuis la config (même cache 1 h).
        if (cached.value.tags) v.tags = cached.value.tags;
        if (cached.value.description) v.notes = cached.value.description;
        // Code ostype — joint depuis la config (repli famille OS si pas d'agent).
        if (cached.value.ostype) v.ostype = cached.value.ostype;
        // Nom d'hôte — joint depuis la config (sans agent invité).
        if (cached.value.hostname) v.hostname = cached.value.hostname;
        // Architecture — jointe depuis la config (sans agent invité).
        if (cached.value.arch) v.arch = cached.value.arch;
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

    // Capacités par nœud : lvmthin (vg/lv), lvm (arbo /disks/lvm), rootfs (dir).
    // L'iscsi se déduit du VG lvm qui repose sur le LUN (champ `base` du datastore lvm).
    const thinCaps = new Map<string, { used: number; total: number }>();
    const vgCaps = new Map<string, { used: number; total: number }>();
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
          // Arbo VG : chaque enfant de niveau 1 est un VG {name, size, free}
          const lvmTree = await this.get<{ children?: Array<{ name?: string; size?: number; free?: number }> }>(
            `/nodes/${nodeName}/disks/lvm`,
          );
          for (const vg of lvmTree.children ?? []) {
            if (vg.name && num(vg.size)) vgCaps.set(vg.name, { used: num(vg.size)! - (num(vg.free) ?? 0), total: num(vg.size)! });
          }
        } catch {
          // ignoré
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
      // Hiérarchie iSCSI → LVM : une cible iSCSI (le LUN, volume physique de référence) sur
      // laquelle reposent des VG LVM est remontée deux fois (datastore `iscsi` + datastore `lvm`).
      // On pose `duplicateOf` sur le LUN = la liste de ses VG enfants (vues redondantes). Le LUN
      // est le volume compté ; ses VG enfants sont exclus des agrégations (comptés via le LUN).
      let duplicateOf: string[] | undefined;
      if (s.type === 'lvmthin' && s.vgname && s.thinpool) {
        const cap = thinCaps.get(`${s.vgname}/${s.thinpool}`);
        if (cap) {
          used = cap.used;
          total = cap.total;
        }
      } else if (s.type === 'lvm' && s.vgname) {
        const cap = vgCaps.get(s.vgname);
        if (cap) {
          used = cap.used;
          total = cap.total;
        }
      } else if (s.type === 'iscsi') {
        // Pas d'endpoint de capacité iSCSI (/disks/iscsi = 501 sur PVE 9.2) : la capacité du LUN
        // est déduite des VG lvm qui reposent dessus (leur `base` = « {iscsi}:… »). Un LUN peut
        // porter plusieurs VG (vrai matériel) → on les liste tous.
        const hostVgs = iscsiHostVgs(storages, s.storage);
        if (hostVgs.length > 0) duplicateOf = hostVgs.map((vg) => vg.storage); // VG enfants du LUN
        // Le LUN n'a pas de « données » de son point de vue : son espace occupé = la somme des
        // TAILLES des VG enfants (espace engagé/réservé), PAS les données de ces VG. La taille du
        // LUN elle-même reste inconnue de PVE → `total` = somme des VG = borne basse (la config
        // storage-volumes.json / lunSizes donnera la vraie taille, appliquée par le poller).
        const caps = hostVgs
          .map((vg) => (vg.vgname ? vgCaps.get(vg.vgname) : undefined))
          .filter((c): c is { used: number; total: number } => c !== undefined);
        if (caps.length > 0) {
          used = caps.reduce((sum, c) => sum + c.total, 0); // engagé = Σ tailles VG
          total = caps.reduce((sum, c) => sum + c.total, 0); // borne basse (LUN peut être plus grand)
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
        duplicateOf,
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
        ostype: str(c.ostype),
        hostname: str(c.hostname),
        arch: str(c.arch),
        pool: str(c.pool) ?? null,
        nets: parseVmNets(type, c),
        diskStorage: diskStorageOf(c, type),
        disks: disksOf(c, type),
        tags: parseTags(c.tags),
        description: str(c.description) ?? undefined,
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

  /**
   * Usage disque RÉEL PAR FILESYSTEM d'une VM QEMU via l'agent invité —
   * GET /nodes/{n}/qemu/{vmid}/agent/get-fsinfo. Ne nécessite que `VM.GuestAgent.Audit`
   * (pas Unrestricted). Ne renvoie que les filesystems rattachés à un disque VM (champ
   * `disk` non vide) — exclut /snap (squashfs), tmpfs, et les vrais montages réseau
   * (NFS/CIFS n'ont pas de champ `disk`). `null` si VM arrêtée, agent absent, ou PVE sans
   * l'endpoint ; `[]` si agent vivant mais aucun fs sur disque VM. C'est la seule source
   * d'usage disque fiable par VM QEMU (le RRD `disk` vaut 0, `maxdisk` n'est que l'allocation).
   * Mise en cache 5 min — source unique partagée entre le poller et la route (le fetch est
   * déporté en background, jamais sur le chemin critique).
   */
  async getAgentFsUsage(node: string, vmid: number): Promise<AgentFsUsage[] | null> {
    const k = key(node, vmid);
    const cached = this.fsUsageCache.get(k);
    if (cached && Date.now() - cached.at < AGENT_FSINFO_TTL_MS) return cached.value;
    const value = await this.fetchAgentFsUsage(node, vmid);
    // On ne met en cache que les résultats non vides : une VM juste démarrée (agent pas
    // encore prêt) est réinterrogée à la fenêtre suivante, comme avant l'introduction du cache.
    if (value && value.length > 0) this.fsUsageCache.set(k, { at: Date.now(), value });
    return value;
  }

  private async fetchAgentFsUsage(node: string, vmid: number): Promise<AgentFsUsage[] | null> {
    try {
      // timeout : un guest lent doit faire renoncer l'appel (null), pas le bloquer.
      const raw = await this.get<{ result?: RawAgentFs[] } | RawAgentFs[]>(
        `/nodes/${node}/qemu/${vmid}/agent/get-fsinfo`,
        AGENT_DISK_USAGE_TIMEOUT_MS,
      );
      const rows = Array.isArray(raw) ? raw : (raw?.result ?? []);
      const out: AgentFsUsage[] = [];
      for (const r of rows) {
        if (!r.disk || r.disk.length === 0) continue; // ne garder que les fs sur un disque VM
        const total = r['total-bytes'] ?? r['total-bytes-privileged'] ?? 0;
        if (total <= 0) continue;
        out.push({
          mountpoint: r.mountpoint ?? '/',
          dev: r.name ?? '',
          usedBytes: r['used-bytes'] ?? 0,
          totalBytes: total,
        });
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * Lecture SEULE du cache usage disque (aucun fetch) — le poller l'utilise pour écrire
   * Influx sans relancer l'agent. `undefined` si jamais interrogé ou cache périmé.
   */
  cachedFsUsage(node: string, vmid: number): AgentFsUsage[] | undefined {
    const c = this.fsUsageCache.get(key(node, vmid));
    return c && Date.now() - c.at < AGENT_FSINFO_TTL_MS ? c.value : undefined;
  }

  /**
   * Bundle des données agent d'une VM, toutes mises en cache dans le client (fsinfo 5 min,
   * osinfo 5 min, interfaces 60 s) — source unique partagée entre le poller et la route
   * proxmox-inventory. `fs`/`osinfo` seulement pour QEMU tournant ; `nets` pour QEMU ou LXC.
   * `null` / `[]` si VM arrêtée, agent absent, ou PVE sans l'endpoint.
   */
  async getAgentBundle(
    node: string,
    vmid: number,
    type: 'qemu' | 'lxc',
    status: string,
  ): Promise<{ fs: AgentFsUsage[] | null; osinfo: VmOsInfo | null; nets: VmAgentNetIf[] }> {
    const running = status === 'running';
    const [fs, osinfo, nets] = await Promise.all([
      type === 'qemu' && running ? this.getAgentFsUsage(node, vmid) : Promise.resolve(null),
      type === 'qemu' && running ? this.getOsInfo(node, vmid) : Promise.resolve(null),
      type === 'qemu' ? this.getVmAgentNets(node, vmid) : this.getLxcInterfaces(node, vmid),
    ]);
    return { fs, osinfo, nets };
  }

  /**
   * OS RÉEL d'une VM QEMU via l'agent invité — GET /nodes/{n}/qemu/{vmid}/agent/get-osinfo
   * (QGA guest-get-osinfo). Renvoie la distro, la version et le noyau tels que vus par le
   * système hôte invité. `null` si VM arrêtée, agent absent, ou PVE sans l'endpoint —
   * le repli « famille OS » se fait alors sur la config `ostype` (côté route).
   * Mise en cache 5 min (l'OS ne change pas) ; borne de 8 s pour ne jamais bloquer.
   */
  async getOsInfo(node: string, vmid: number): Promise<VmOsInfo | null> {
    const k = key(node, vmid);
    const cached = this.osInfoCache.get(k);
    if (cached && Date.now() - cached.at < AGENT_OSINFO_TTL_MS) return cached.value;
    const value = await this.fetchOsInfo(node, vmid);
    this.osInfoCache.set(k, { at: Date.now(), value });
    return value;
  }

  private async fetchOsInfo(node: string, vmid: number): Promise<VmOsInfo | null> {
    try {
      const raw = await this.get<RawOsInfo | { result?: RawOsInfo }>(
        `/nodes/${node}/qemu/${vmid}/agent/get-osinfo`,
        AGENT_OSINFO_TIMEOUT_MS,
      );
      const r = raw && !Array.isArray(raw) && 'result' in raw ? raw.result : (raw as RawOsInfo);
      if (!r) return null;
      return {
        id: str(r.id) ?? null,
        name: str(r.name) ?? null,
        prettyName: str(r['pretty-name']) ?? null,
        version: str(r.version) ?? null,
        versionId: str(r['version-id']) ?? null,
        kernelRelease: str(r['kernel-release']) ?? null,
        arch: str(r.machine) ?? null,
      };
    } catch {
      return null;
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
      // Un point est conservé s'il porte AU MOINS une métrique. Pour une VM
      // arrêtée, cpu/mem sont null mais disk garde des valeurs historiques —
      // il ne faut pas les jeter (sinon l'historique disque des VMs arrêtées
      // est vide, d'où « historique insuffisant » sur les datastores iSCSI).
      .filter(
        (p) =>
          p.cpu !== null ||
          p.mem !== null ||
          p.disk !== null ||
          p.netin !== null ||
          p.netout !== null,
      );
  }
}

/** Réponse brute QGA guest-get-osinfo (GET .../agent/get-osinfo). */
interface RawOsInfo {
  id?: string;
  name?: string;
  'pretty-name'?: string;
  version?: string;
  'version-id'?: string;
  'kernel-release'?: string;
  machine?: string;
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
  /** Datastore parent (ex. un lvm sur un LUN iSCSI : « baie-iscsi:0.0.0.scsi-… »). */
  base?: string | null;
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

/** Tags de la config PVE : chaîne « a,b,c » (ou tableau) → tableau non vide. */
function parseTags(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' && v.length > 0 ? v.split(',') : [];
  const out = raw.map((t) => String(t).trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
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

/**
 * VG LVM qui reposent sur une cible iSCSI. PVE remonte un LUN iSCSI deux fois : en datastore
 * `iscsi` (la cible brute) et en datastore(s) `lvm` dont le champ `base` référence la cible
 * (« {iscsi}:… »). Un LUN peut porter **plusieurs** VG (vrai matériel) → on renvoie tous les VG
 * hôtes (vides si la cible iSCSI n'a aucun VG dessus). Le signal robuste est le champ `base`,
 * pas une heuristique de taille (deux baies identiques ≠ même volume).
 */
export function iscsiHostVgs(
  storages: Array<{ storage: string; type: string; base?: string | null; vgname?: string | null }>,
  iscsiName: string,
): Array<{ storage: string; vgname?: string }> {
  return storages
    .filter((o) => o.type === 'lvm' && o.base?.startsWith(`${iscsiName}:`))
    .map((o) => ({ storage: o.storage, vgname: o.vgname ?? undefined }));
}

/** Premier VG LVM reposant sur une cible iSCSI (rétro-compat — `iscsiHostVgs[0]`). */
export function iscsiHostVg(
  storages: Array<{ storage: string; type: string; base?: string | null; vgname?: string | null }>,
  iscsiName: string,
): { storage: string; vgname?: string } | undefined {
  return iscsiHostVgs(storages, iscsiName)[0];
}

/** Premier disque qemu non-ISO, dans l'ordre de priorité du disque de boot. */
function firstDiskVolume(c: Record<string, unknown>): string | undefined {
  for (const k of ['scsi0', 'virtio0', 'sata0', 'ide0', 'scsi1', 'virtio1', 'sata1', 'ide1']) {
    const v = str(c[k]);
    if (v) return v;
  }
  return undefined;
}

/**
 * Tous les disques d'une VM (un par volume non-ISO de la config). Une VM peut en
 * avoir plusieurs, sur des datastores différents (ex. scsi0 sur « rapide », scsi1
 * sur « local »). LXC : le rootfs seul. Renvoie le datastore + la taille allouée
 * (`size=`) de chaque disque.
 */
export function disksOf(c: Record<string, unknown>, type: 'qemu' | 'lxc'): VmDisk[] {
  const disks: VmDisk[] = [];
  const add = (vol: string | undefined) => {
    if (!vol) return;
    const head = vol.split(',')[0];
    const m = head.match(/^([A-Za-z0-9._-]+):?\/?/);
    if (!m) return;
    if (head.includes('/iso/') || /\.iso$/i.test(head)) return; // ISO / cdrom exclus
    const sizeM = vol.match(/size=([\d.]+)([KMGTP]?)/i);
    disks.push({ storage: m[1], sizeBytes: sizeM ? parseSize(sizeM[1], sizeM[2]) : 0 });
  };
  if (type === 'lxc') {
    add(str(c.rootfs));
  } else {
    for (const k of Object.keys(c)) {
      if (/^(scsi|virtio|sata|ide|efidisk)\d+$/.test(k)) add(str(c[k]));
    }
  }
  return disks;
}

/** Taille « 1500G » / « 3325654K » / « 4M » → octets. */
function parseSize(v: string, unit: string): number {
  const n = parseFloat(v);
  const mult: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };
  return Math.round(n * (mult[(unit ?? '').toLowerCase()] ?? 1));
}

function friendlyOs(os?: string): string {
  if (!os) return 'Autre';
  const o = os.toLowerCase();
  if (o.startsWith('win')) return 'Windows';
  if (o.startsWith('l') || o === 'linux' || o === 'bsd' || o === 'solaris') return 'Linux/Unix';
  return 'Autre';
}

/**
 * map avec concurrence limitée — exportée pour borner les appels agent (poller + route).
 * Le callback peut renvoyer n'importe quelle valeur (ex. un bundle agent) ; seul le
 * parallélisme est borné, le résultat n'est pas retenu.
 */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}
