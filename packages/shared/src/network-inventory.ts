/**
 * Inventaire réseaux → VMs (hypervision, page /topology).
 *
 * Un « réseau » = un segment (pont, VLAN). Ce module décline une topologie en
 * lignes d'inventaire : pour chaque réseau, les sous-réseaux, les nœuds, les VMs
 * (et leurs interfaces) qui l'utilisent, le trafic agrégé, l'état dérivé du statut
 * des nœuds, et l'impact si ce réseau tombe. Fonctions pures testées — aucun I/O,
 * aucune dépendance backend (les données viennent déjà de GET /api/network-topology).
 */

import {
  internalNetworkSegments,
  segmentKey,
  type ImpactResult,
  type NetworkKind,
  type NetworkTopology,
  type TopologyVm,
} from './network.js';

/** Interface d'une VM sur un réseau (segment) — vue plate de ParsedVmNet. */
export interface NetworkVmRef {
  vmid: number;
  name: string;
  iface: string;
  ip: string | null;
  /** LXC sans IP statique connue (ip=manual / ip=dhcp) — PVE ne voit pas l'IP réelle. */
  ipMode?: 'manual' | 'dhcp';
  mac: string | null;
  status: TopologyVm['status'];
  node: string;
}

/** État d'un réseau dérivé du statut des nœuds qui l'hébergent. */
export type NetworkSeverity = 'ok' | 'warn' | 'crit' | 'na';

/** Une ligne d'inventaire : un réseau (segment pont+VLAN) et les VMs qui l'utilisent. */
export interface NetworkRow {
  /** Clé stable du segment (segmentKey). */
  key: string;
  bridge: string;
  /** ID VLAN — null = VLAN natif (non tagué). */
  vlan: number | null;
  /** management = réseau interne Proxmox (pont sans NIC physique) · external = pont branché sur une NIC physique (gestion, production, VLAN…). */
  kind: NetworkKind;
  /** Union des sous-réseaux des ponts de ce segment (peut être vide). */
  subnets: string[];
  /** Nœuds hébergeant le pont de ce segment. */
  nodes: string[];
  /** Interfaces des VMs branchées sur ce segment (une VM multi-ifaces apparaît plusieurs fois). */
  vms: NetworkVmRef[];
  /** Trafic agrégé des VMs du segment (PVE 9 : pas de détail par interface → agrégat par VM, compté une seule fois). */
  trafficIn: number;
  trafficOut: number;
  /** Nombre de VMs distinctes en marche / arrêtées sur ce segment. */
  running: number;
  stopped: number;
  /** ok = tous les nœuds du segment sont en ligne · warn = au moins un down mais un en ligne · crit = tous down · na = inconnu. */
  severity: NetworkSeverity;
  /** VMs perdues (toutes leurs interfaces sur ce segment) si le réseau tombe. */
  impactedCount: number;
  /** VMs dégradées (perdent une interface mais en conservent) si le réseau tombe. */
  degradedCount: number;
}

/** Ligne enrichie d'un endpoint — vue agrégée multi-endpoints. */
export interface NetworkRowAll extends NetworkRow {
  endpointId: string;
  endpointName: string;
}

/**
 * Impact si un segment (pont+VLAN) tombe — sémantique identique à impactAnalysis,
 * restreinte au segment. Une VM perd toutes ses interfaces sur (bridge, vlan) :
 * elle est **impactée** si c'était la totalité de ses interfaces, **dégradée** sinon.
 * Les ponts bond/LACP n'ont pas de sens ici (le segment entier part, pas un port).
 */
export function segmentImpact(topo: NetworkTopology, bridge: string, vlan: number | null): ImpactResult {
  const impactedVms: TopologyVm[] = [];
  const degradedVms: TopologyVm[] = [];
  for (const v of topo.vms) {
    const onSegment = v.nets.filter((n) => n.bridge === bridge && n.tag === vlan);
    if (onSegment.length === 0) continue;
    if (onSegment.length >= v.nets.length) impactedVms.push(v);
    else degradedVms.push(v);
  }
  const severity: ImpactResult['severity'] =
    impactedVms.some((v) => v.status === 'running') ? 'crit' : impactedVms.length > 0 || degradedVms.length > 0 ? 'warn' : 'ok';
  return { impactedVms, degradedVms, affectedBridges: [], affectedSwitchIds: [], severity };
}

/**
 * Décline une topologie en lignes d'inventaire (une par segment pont+VLAN).
 * Trié par pont puis VLAN (natif en premier). Les VMs sans interface branchée
 * n'apparaissent nulle part (pas de réseau).
 */
export function buildNetworkInventory(topo: NetworkTopology): NetworkRow[] {
  // Index des ponts par nom : sous-réseaux + nœuds + état (pour subnets, nodes, severity).
  const bridges = new Map<string, { subnets: Set<string>; nodes: Set<string>; anyOnline: boolean; anyDown: boolean }>();
  for (const node of topo.nodes) {
    for (const b of node.bridges) {
      let info = bridges.get(b.name);
      if (!info) {
        info = { subnets: new Set(), nodes: new Set(), anyOnline: false, anyDown: false };
        bridges.set(b.name, info);
      }
      if (b.subnet) info.subnets.add(b.subnet);
      info.nodes.add(node.node);
      if (node.online) info.anyOnline = true;
      else info.anyDown = true;
    }
  }

  // Groupement des interfaces VM par segment. Le trafic et les compteurs VMs
  // comptent chaque VM une seule fois par segment (pas de détail par interface en PVE 9).
  const internal = internalNetworkSegments(topo);
  const rows = new Map<string, NetworkRow>();
  const counted = new Map<string, Set<number>>();
  for (const v of topo.vms) {
    for (const net of v.nets) {
      const key = segmentKey(net.bridge, net.tag);
      let row = rows.get(key);
      if (!row) {
        const info = bridges.get(net.bridge);
        row = {
          key,
          bridge: net.bridge,
          vlan: net.tag,
          kind: internal.has(key) ? 'management' : 'external',
          subnets: info ? [...info.subnets] : [],
          nodes: info ? [...info.nodes] : [],
          vms: [],
          trafficIn: 0,
          trafficOut: 0,
          running: 0,
          stopped: 0,
          severity: 'na',
          impactedCount: 0,
          degradedCount: 0,
        };
        rows.set(key, row);
        counted.set(key, new Set());
      }
      row.vms.push({ vmid: v.vmid, name: v.name, iface: net.iface, ip: net.ip, ...(net.ipMode ? { ipMode: net.ipMode } : {}), mac: net.mac, status: v.status, node: v.node });
      const seen = counted.get(key)!;
      if (!seen.has(v.vmid)) {
        seen.add(v.vmid);
        row.trafficIn += v.netInBps ?? 0;
        row.trafficOut += v.netOutBps ?? 0;
        if (v.status === 'running') row.running += 1;
        else row.stopped += 1;
      }
    }
  }

  const list = [...rows.values()];
  for (const row of list) {
    const info = bridges.get(row.bridge);
    if (info) row.severity = !info.anyOnline && info.anyDown ? 'crit' : info.anyDown ? 'warn' : 'ok';
    const impact = segmentImpact(topo, row.bridge, row.vlan);
    row.impactedCount = impact.impactedVms.length;
    row.degradedCount = impact.degradedVms.length;
  }
  list.sort((a, b) => a.bridge.localeCompare(b.bridge) || (a.vlan ?? -1) - (b.vlan ?? -1));
  return list;
}

/** Inventaire agrégé de tous les endpoints (vue multi-endpoints) + nom du serveur. */
export function buildNetworkInventoryAll(
  topologies: NetworkTopology[],
  endpointNames: Record<string, string>,
): NetworkRowAll[] {
  const rows: NetworkRowAll[] = [];
  for (const topo of topologies) {
    const name = endpointNames[topo.endpointId] ?? topo.endpointId;
    for (const row of buildNetworkInventory(topo)) rows.push({ ...row, endpointId: topo.endpointId, endpointName: name });
  }
  return rows;
}

/** Filtre optionnel d'inventaire (ensembles vides = pas de filtre sur cette dimension). */
export interface InventoryFilter {
  vlans?: Set<number>;
  bridges?: Set<string>;
  /** Sélection exacte d'un réseau (segment pont+VLAN) — le déroulé de la page. */
  network?: { bridge: string; vlan: number | null };
}

/**
 * Encodage URL-safe d'une sélection de réseau (deep-link `?net=`).
 * « vmbr0:n » = VLAN natif, « vmbr0:10 » = VLAN 10.
 */
export function encodeNetSel(bridge: string, vlan: number | null): string {
  return `${bridge}:${vlan === null ? 'n' : vlan}`;
}

/** Décodage d'une sélection de réseau encodée — null si malformée (pas de crash). */
export function decodeNetSel(s: string): { bridge: string; vlan: number | null } | null {
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  const vlan = s.slice(i + 1);
  if (vlan === 'n') return { bridge: s.slice(0, i), vlan: null };
  const n = Number(vlan);
  if (!Number.isInteger(n) || n < 0) return null;
  return { bridge: s.slice(0, i), vlan: n };
}

/**
 * Recherche libre + filtrage des lignes d'inventaire.
 * La recherche (insensible à la casse) porte sur : pont, VLAN, sous-réseau, nœud,
 * nom de VM, vmid, IP. `multiFilter` resserre ensuite (ET entre dimensions).
 */
export function filterNetworkRows<T extends NetworkRow>(rows: T[], query: string, multiFilter?: InventoryFilter): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (multiFilter) {
      if (multiFilter.network && (row.bridge !== multiFilter.network.bridge || row.vlan !== multiFilter.network.vlan)) return false;
      if (multiFilter.bridges && multiFilter.bridges.size > 0 && !multiFilter.bridges.has(row.bridge)) return false;
      if (multiFilter.vlans && multiFilter.vlans.size > 0 && !(row.vlan !== null && multiFilter.vlans.has(row.vlan))) return false;
    }
    if (!q) return true;
    const haystack = [
      row.bridge,
      row.vlan !== null ? String(row.vlan) : '',
      ...row.subnets,
      ...row.nodes,
      ...row.vms.flatMap((v) => [v.name, String(v.vmid), v.ip ?? '']),
    ]
      .join('\u0000')
      .toLowerCase();
    return haystack.includes(q);
  });
}
