/**
 * Topologie réseau auto-découverte (phase 1B).
 *
 * La couche Proxmox est 100 % remontée depuis l'API PVE :
 *  - NICs/ponts par nœud : GET /nodes/{n}/network (NICs physiques = type "eth",
 *    appartenance NIC→pont dans `bridge_ports`, IP dans `cidr`/`address`)
 *  - VM→pont : `bridge=` des interfaces netN / mpN de la config VM (LXC : type=veth)
 * La couche switches physiques n'est pas visible par l'API → **inférée** :
 * même nom de pont + même sous-réseau = même switch.
 */

/** NIC physique d'un nœud (type "eth" dans l'API PVE). */
export interface NodeNic {
  name: string;
  ip: string | null;
  subnet: string | null;
  comment: string | null;
}

/** Pont Linux d'un nœud (vmbr*, ou pont sans IP ex. « nfs »). */
export interface NodeBridge {
  name: string;
  ip: string | null;
  subnet: string | null;
  gateway: string | null;
  /** NICs physiques attachées (champ `bridge_ports` de l'API PVE). */
  ports: string[];
  comment: string | null;
}

/** Interface réseau d'une VM/CT → pont (parsing de la config). */
export interface ParsedVmNet {
  /** net0 / mp0… */
  iface: string;
  /** valeur de bridge= */
  bridge: string;
  /** IP si déclarée dans la config (LXC) — null sinon ou si « manual »/« dhcp » */
  ip: string | null;
  mac: string | null;
  /** ID VLAN (paramètre `tag=` de la config) — null = VLAN natif (non tagué). */
  tag: number | null;
  /** LXC : mode d'attribution IP sans valeur connue (ip=manual / ip=dhcp) — PVE ne voit pas l'IP réelle. */
  ipMode?: 'manual' | 'dhcp';
}

/**
 * Interface réseau vue côté invité/hôte — IP+MAC par interface :
 * - QEMU : guest agent (GET /nodes/{n}/qemu/{vmid}/agent/network-get-interfaces) ;
 * - LXC : PVE ≥ 9 lit le netns côté hôte (GET /nodes/{n}/lxc/{vmid}/interfaces — fonctionne avec ip=manual).
 */
export interface VmAgentNetIf {
  /** nom côté invité (enp6s18, eth0, vmbr0…) */
  name: string;
  /** adresse MAC — clé de jointure avec la config PVE (netN) */
  mac: string | null;
  /** adresses « ip/prefix » (v4 + v6) ; loopback et link-local exclus */
  ips: string[];
}

/**
 * Jointure interfaces guest agent ↔ config PVE par MAC (insensible à la casse).
 * Renvoie iface (net0…) → liste d'IPs. Les interfaces agent absentes de la config
 * (docker0, veth…) sont ignorées — elles sont internes au guest.
 */
export function matchAgentNetsByMac(
  nets: ParsedVmNet[],
  agentNets: VmAgentNetIf[],
): Map<string, string[]> {
  const byMac = new Map<string, string[]>();
  for (const a of agentNets) {
    if (!a.mac) continue;
    const k = a.mac.toLowerCase();
    const arr = byMac.get(k) ?? [];
    arr.push(...a.ips);
    byMac.set(k, arr);
  }
  const out = new Map<string, string[]>();
  for (const n of nets) {
    if (!n.mac) continue;
    const ips = byMac.get(n.mac.toLowerCase());
    if (ips && ips.length > 0) out.set(n.iface, [...new Set(ips)]);
  }
  return out;
}

/**
 * Segment réseau = (pont, VLAN) : la jonction logique entre une VM et le réseau.
 * Deux VMs sur le même pont ET le même VLAN sont dans le même segment L2.
 */
export interface NetworkSegment {
  /** nom du pont (ex. vmbr0) */
  bridge: string;
  /** ID VLAN — null = VLAN natif (non tagué) */
  vlan: number | null;
}

/** Clé stable d'un segment : « vmbr0\u000010 » ou « vmbr0\u0000 » pour le natif. */
export function segmentKey(bridge: string, vlan: number | null): string {
  return `${bridge}\u0000${vlan ?? ''}`;
}

/** Nature d'un réseau vu par l'hyperviseur. */
export type NetworkKind = 'management' | 'external';

function ipToNum(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    num = (num << 8) | Number(p);
  }
  return num >>> 0;
}

/**
 * L'IP appartient-elle au sous-réseau (CIDR) ? Fonction pure testée.
 * Retourne false sur toute entrée malformée (IP ou CIDR invalide).
 */
export function ipInSubnet(ip: string, subnet: string): boolean {
  const m = subnet.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) return false;
  const prefix = Number(m[2]);
  const ipNum = ipToNum(ip);
  const netNum = ipToNum(m[1]);
  if (ipNum === null || netNum === null || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

/**
 * Segments « réseau interne Proxmox » : les (pont, VLAN natif) SANS port physique —
 * un pont non branché sur aucune NIC (ex. le bridge « nfs ») est un réseau interne,
 * invisible depuis le monde extérieur. Un pont branché sur une NIC physique est le
 * réseau externe/production (y compris le pont de gestion, qui est sur le câble).
 * L'API PVE n'a pas de flag interne/externe : on l'infère ici depuis l'absence de ports.
 */
export function internalNetworkSegments(topo: NetworkTopology): Set<string> {
  const keys = new Set<string>();
  for (const node of topo.nodes) {
    for (const b of node.bridges) {
      if (b.ports.length === 0) keys.add(segmentKey(b.name, null));
    }
  }
  return keys;
}

/** Switch physique inféré (ou déclaré dans network.json). */
export interface TopologySwitch {
  id: string;
  name: string;
  /** true = déduit de l'API, false = déclaré manuellement */
  inferred: boolean;
  subnet: string | null;
  bridgeName: string | null;
}

/** Nœud Proxmox dans la topologie. */
export interface TopologyNode {
  node: string;
  online: boolean;
  ip: string | null;
  nics: NodeNic[];
  bridges: NodeBridge[];
}

/** VM/CT dans la topologie. */
export interface TopologyVm {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  /** même union que PveVmResource.status (pas de mapping) */
  status: 'running' | 'stopped' | 'paused' | 'unknown';
  node: string;
  nets: ParsedVmNet[];
  /** trafic agrégé (cluster/resources — pas de détail par interface en PVE 9) */
  netInBps: number | null;
  netOutBps: number | null;
  /**
   * IPs live par interface (guest agent QEMU / netns LXC, jointure par MAC) — iface → « ip/prefix »[].
   * Absente si la VM n'est pas un QEMU en marche ; `nets[].ip` est complété avec l'IP primaire.
   */
  agentIps?: Record<string, string[]>;
}

/** IP primaire d'une interface guest agent : IPv4 si présente, sinon la première (v6). */
export function primaryAgentIp(ips: string[]): string | undefined {
  return ips.find((s) => !s.includes(':')) ?? ips[0];
}

/** Topologie complète d'un endpoint. */
export interface NetworkTopology {
  endpointId: string;
  switches: TopologySwitch[];
  nodes: TopologyNode[];
  vms: TopologyVm[];
  /** VLANs utilisés (tags distincts des interfaces VM), triés croissant. Vide = pas de VLAN. */
  vlans: number[];
}

/**
 * Sous-réseau d'une adresse CIDR IPv4 : « 192.168.1.80/24 » → « 192.168.1.0/24 ».
 * Renvoie null si le format n'est pas reconnu (pas de crash sur les valeurs exotiques).
 */
export function subnetOf(cidr: string | null | undefined): string | null {
  if (!cidr) return null;
  const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const ipNum = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const net = (ipNum & mask) >>> 0;
  return `${(net >>> 24) & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

/**
 * Parsing des interfaces réseau d'une config VM (fonction pure, testée).
 *  - qemu : clés `netN` — « virtio=BC:24:…,bridge=vmbr0,tag=100,firewall=1 » (MAC = 1er token)
 *  - lxc  : clés `netN` (PVE ≥ 8.1) ou `mpN` (ancien) — « name=eth0,bridge=vmbr0,hwaddr=…,ip=…/24,type=veth »
 * Le VLAN est lu dans `tag=` (qemu et lxc) ; absent/non numérique → tag null (VLAN natif).
 * Seules les interfaces branchées sur un pont sont retenues (bridge absent ou « none » → ignorée).
 */
export function parseVmNets(type: 'qemu' | 'lxc', config: Record<string, unknown>): ParsedVmNet[] {
  const nets: ParsedVmNet[] = [];
  const ifaceRe = type === 'qemu' ? /^net\d+$/ : /^(?:mp|net)\d+$/;
  for (const [key, value] of Object.entries(config)) {
    if (!ifaceRe.test(key) || typeof value !== 'string') continue;
    const params = new Map<string, string>();
    for (const part of value.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) params.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const bridge = params.get('bridge');
    if (!bridge || bridge === 'none') continue;
    let mac: string | null = null;
    let ip: string | null = null;
    let ipMode: 'manual' | 'dhcp' | undefined;
    if (type === 'qemu') {
      // 1er token sans clé : « virtio=BC:24:11:42:F0:77 »
      const first = value.split(',')[0];
      const eq = first.indexOf('=');
      if (eq > 0) mac = first.slice(eq + 1).trim() || null;
    } else {
      mac = params.get('hwaddr') ?? null;
      const rawIp = params.get('ip');
      // « manual » / « dhcp » → pas d'IP statique connue (PVE ne voit pas l'IP réelle) ; absent → null
      if (rawIp === 'manual' || rawIp === 'dhcp') {
        ip = null;
        ipMode = rawIp;
      } else {
        ip = rawIp ?? null;
      }
    }
    // tag=NNN (VLAN) — qemu et lxc ; valeur non numérique ignorée (tag null)
    const rawTag = params.get('tag');
    const tag = rawTag && /^\d+$/.test(rawTag) ? Number(rawTag) : null;
    nets.push({ iface: key, bridge, ip, mac, tag, ...(ipMode ? { ipMode } : {}) });
  }
  return nets.sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }));
}

/**
 * Construction de la topologie (fonction pure, testée).
 * Inférence des switches : les ponts de tous les nœuds sont groupés par
 * (nom de pont, sous-réseau) — un groupe = un switch physique.
 * Les ponts sans IP (ex. « nfs ») sont groupés par nom seul.
 */
export function buildTopology(input: {
  endpointId: string;
  nodes: TopologyNode[];
  vms: TopologyVm[];
}): NetworkTopology {
  const groups = new Map<string, { bridgeName: string; subnet: string | null }>();
  for (const node of input.nodes) {
    for (const b of node.bridges) {
      const key = `${b.name}\u0000${b.subnet ?? ''}`;
      if (!groups.has(key)) groups.set(key, { bridgeName: b.name, subnet: b.subnet });
    }
  }
  const switches: TopologySwitch[] = [...groups.values()].map((g) => ({
    id: `sw-${g.bridgeName}${g.subnet ? `-${g.subnet.replace(/[/.]/g, '-')}` : ''}`,
    name: g.subnet ? `${g.bridgeName} · ${g.subnet}` : g.bridgeName,
    inferred: true,
    subnet: g.subnet,
    bridgeName: g.bridgeName,
  }));

  // VLANs découverts depuis l'usage (l'API PVE ne liste pas les VLANs d'un pont).
  const vlanSet = new Set<number>();
  for (const v of input.vms) for (const n of v.nets) if (n.tag !== null) vlanSet.add(n.tag);
  const vlans = [...vlanSet].sort((a, b) => a - b);

  return { endpointId: input.endpointId, switches, nodes: input.nodes, vms: input.vms, vlans };
}

// --- Analyse d'impact incident (fonction pure, testée) ----------------------------

/** Point de défaillance réseau simulé (analyse « que se passe-t-il si… »). */
export type NetworkFailure =
  | { kind: 'switch'; id: string }
  | { kind: 'nic'; node: string; nic: string }
  | { kind: 'bridge'; node: string; bridge: string }
  | { kind: 'vlan'; vlan: number }
  | { kind: 'node'; node: string };

/** Résultat de l'analyse d'impact d'une défaillance réseau. */
export interface ImpactResult {
  /** VMs dont TOUTES les interfaces tombent (hors service). */
  impactedVms: TopologyVm[];
  /** VMs qui perdent une interface mais en conservent au moins une (dégradées). */
  degradedVms: TopologyVm[];
  /** Ponts effectivement touchés (au moins une de leurs VMs impactée/dégradée). */
  affectedBridges: { node: string; bridge: string }[];
  /** Switches inférés touchés. */
  affectedSwitchIds: string[];
  /** ok = rien, warn = dégradé seulement (ou VMs arrêtées), crit = au moins une VM en marche impactée. */
  severity: 'ok' | 'warn' | 'crit';
}

/**
 * Analyse d'impact d'une défaillance réseau (fonction pure, testée).
 *
 * Sémantique par interface VM :
 *  - « down »     : l'interface est coupée (pont/switch/nœud tombé, VLAN perdu, NIC unique perdue)
 *  - « dégradé »  : le pont a perdu un port mais en garde d'autres (bond/LACP) → redondance maintenue
 * Une VM est **impactée** si toutes ses interfaces sont « down », **dégradée** sinon
 * (elle perd au moins une interface mais en conserve une opérationnelle).
 */
export function impactAnalysis(topo: NetworkTopology, failure: NetworkFailure): ImpactResult {
  // 1. Résoudre la défaillance en ponts affectés (par nœud) : « down » ou « dégradé ».
  const affected = new Map<string, 'down' | 'degraded'>();
  if (failure.kind === 'bridge') {
    affected.set(bk(failure.node, failure.bridge), 'down');
  } else if (failure.kind === 'nic') {
    const node = topo.nodes.find((n) => n.node === failure.node);
    for (const b of node?.bridges ?? []) {
      if (!b.ports.includes(failure.nic)) continue;
      // bond : plusieurs ports → la perte d'un port dégrade, ne coupe pas
      affected.set(bk(failure.node, b.name), b.ports.length > 1 ? 'degraded' : 'down');
    }
  } else if (failure.kind === 'switch') {
    const sw = topo.switches.find((s) => s.id === failure.id);
    if (!sw) return emptyImpact();
    for (const n of topo.nodes) {
      for (const b of n.bridges) {
        if (b.name === sw.bridgeName && b.subnet === sw.subnet) affected.set(bk(n.node, b.name), 'down');
      }
    }
  }
  // « node » et « vlan » agissent directement sur les VMs (pas via les ponts).

  // 2. Évaluer l'impact sur chaque interface de chaque VM.
  const impactedVms: TopologyVm[] = [];
  const degradedVms: TopologyVm[] = [];
  const touchedBridges = new Set<string>();
  for (const v of topo.vms) {
    if (v.nets.length === 0) continue; // pas d'iface branchée → pas d'impact réseau
    let downNets = 0;
    let degradedNets = 0;
    for (const net of v.nets) {
      let status: 'down' | 'degraded' | null = null;
      if (failure.kind === 'node') {
        if (v.node === failure.node) status = 'down';
      } else if (failure.kind === 'vlan') {
        if (net.tag === failure.vlan) status = 'down';
      } else {
        const s = affected.get(bk(v.node, net.bridge));
        if (s) {
          status = s;
          touchedBridges.add(bk(v.node, net.bridge));
        }
      }
      if (status === 'down') {
        downNets++;
        touchedBridges.add(bk(v.node, net.bridge));
      } else if (status === 'degraded') {
        degradedNets++;
        touchedBridges.add(bk(v.node, net.bridge));
      }
    }
    if (downNets > 0 && downNets >= v.nets.length) impactedVms.push(v);
    else if (downNets > 0 || degradedNets > 0) degradedVms.push(v);
  }

  // 3. Ponts et switches touchés (dérivés des ponts réellement porteurs de VMs impactées).
  const bridgeSubnet = new Map<string, string | null>();
  for (const n of topo.nodes) for (const b of n.bridges) bridgeSubnet.set(bk(n.node, b.name), b.subnet);
  const swIdByGroup = new Map<string, string>();
  for (const s of topo.switches) swIdByGroup.set(`${s.bridgeName}\u0000${s.subnet ?? ''}`, s.id);

  const affectedBridges: { node: string; bridge: string }[] = [];
  const switchIds = new Set<string>();
  for (const key of touchedBridges) {
    const [node, bridge] = key.split('\u0000');
    affectedBridges.push({ node, bridge });
    const subnet = bridgeSubnet.get(key);
    const swId = swIdByGroup.get(`${bridge}\u0000${subnet ?? ''}`);
    if (swId) switchIds.add(swId);
  }

  const severity: ImpactResult['severity'] =
    impactedVms.some((v) => v.status === 'running') ? 'crit' : impactedVms.length > 0 || degradedVms.length > 0 ? 'warn' : 'ok';

  return { impactedVms, degradedVms, affectedBridges, affectedSwitchIds: [...switchIds], severity };
}

function bk(node: string, bridge: string): string {
  return `${node}\u0000${bridge}`;
}

function emptyImpact(): ImpactResult {
  return { impactedVms: [], degradedVms: [], affectedBridges: [], affectedSwitchIds: [], severity: 'ok' };
}
