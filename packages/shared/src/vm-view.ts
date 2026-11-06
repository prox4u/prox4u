import type { VmSummary } from './types';

/**
 * Vue des VMs (plugin vm-view) — groupement/filtrage/tri purs,
 * même pattern que storage-inventory / network-inventory.
 */

export interface VmViewFilter {
  node: string | 'all';
  status: 'all' | 'running' | 'stopped' | 'paused' | 'unknown';
  type: 'all' | 'qemu' | 'lxc';
}

export const DEFAULT_VM_FILTER: VmViewFilter = { node: 'all', status: 'all', type: 'all' };

export type VmSortKey = 'name' | 'vmid' | 'node' | 'type' | 'status' | 'cpuPct' | 'memBytes' | 'diskBytes' | 'agentActive';
export type VmSortDir = 'asc' | 'desc';

/** Recherche textuelle (nom ou vmid, insensible à la casse) + filtres nœud/statut/type. */
export function filterVmRows(vms: VmSummary[], query: string, filter: VmViewFilter): VmSummary[] {
  const q = query.trim().toLowerCase();
  return vms.filter((v) => {
    if (filter.node !== 'all' && v.node !== filter.node) return false;
    if (filter.status !== 'all' && v.status !== filter.status) return false;
    if (filter.type !== 'all' && v.type !== filter.type) return false;
    if (q && !v.name.toLowerCase().includes(q) && String(v.vmid) !== q) return false;
    return true;
  });
}

/** Ordre d'affichage des statuts (le plus « vivant » d'abord). */
const STATUS_ORDER: Record<VmSummary['status'], number> = { running: 0, paused: 1, stopped: 2, unknown: 3 };

/** Tri stable ; les valeurs null (diskBytes) restent en fin de liste quel que soit le sens. */
export function sortVmRows(vms: VmSummary[], key: VmSortKey, dir: VmSortDir): VmSummary[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...vms].sort((a, b) => {
    // Cas particulier diskBytes : le « nulls last » s'applique APRÈS le sens du tri.
    if (key === 'diskBytes') {
      const an = a.diskBytes == null;
      const bn = b.diskBytes == null;
      if (an !== bn) return an ? 1 : -1;
      if (an && bn) return a.vmid - b.vmid;
      const cmp = (a.diskBytes! - b.diskBytes!) * sign;
      return cmp !== 0 ? cmp : a.vmid - b.vmid;
    }
    // agentActive : inactif (false, critique) d'abord en asc · nulls last quel que soit le sens.
    if (key === 'agentActive') {
      const an = a.agentActive === null;
      const bn = b.agentActive === null;
      if (an !== bn) return an ? 1 : -1;
      if (an && bn) return a.vmid - b.vmid;
      const rank = (x: boolean) => (x ? 1 : 0); // false (inactif) < true (actif)
      const cmp = (rank(a.agentActive!) - rank(b.agentActive!)) * sign;
      return cmp !== 0 ? cmp : a.vmid - b.vmid;
    }
    let cmp: number;
    switch (key) {
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'vmid':
        cmp = a.vmid - b.vmid;
        break;
      case 'node':
        cmp = a.node.localeCompare(b.node);
        break;
      case 'type':
        cmp = a.type.localeCompare(b.type);
        break;
      case 'status':
        cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        break;
      case 'cpuPct':
        cmp = a.cpuPct - b.cpuPct;
        break;
      case 'memBytes':
        cmp = a.memBytes - b.memBytes;
        break;
    }
    if (cmp === 0) cmp = a.vmid - b.vmid; // dédoublonnage déterministe
    return cmp * sign;
  });
}

// --- Arborescence Datacenter → endpoint → nœud -------------------------------------------

export interface VmTreeNode {
  /** 'dc' | <endpointId> | `<endpointId>/<node>` | `<endpointId>/<node>/<vmid>` (feuille VM) */
  id: string;
  label: string;
  kind: 'datacenter' | 'endpoint' | 'node' | 'vm';
  /** VMs sous ce nœud (récursif) ; pour une feuille VM : 1 si en marche, sinon 0 */
  vmCount: number;
  runningCount: number;
  /** Feuille VM uniquement : vmid, type (icône qemu/lxc) et statut (pastille d'état). */
  vmid?: number;
  type?: 'qemu' | 'lxc';
  status?: VmSummary['status'];
  children?: VmTreeNode[];
}

export interface BuildVmTreeOptions {
  /**
   * Inclut les VMs en feuilles sous chaque nœud (approche vCenter : la VM est
   * cliquable dans l'arbre). Par défaut false — les VMs ne sont alors que des
   * lignes du tableau selon la sélection (comportement historique de la v1).
   */
  includeVms?: boolean;
}

/**
 * Construit l'arborescence vCenter : Datacenter → endpoints (clusters) → nœuds
 * → (optionnellement) VMs en feuilles. Sans `includeVms`, les VMs ne sont pas
 * des nœuds de l'arbre : elles alimentent le tableau selon la sélection
 * (racine = tout, endpoint = son parc, nœud = ses VMs).
 */
export function buildVmTree(
  rootLabel: string,
  endpoints: { id: string; name: string }[],
  vmsByEndpoint: Record<string, VmSummary[]>,
  opts: BuildVmTreeOptions = {},
): VmTreeNode {
  const includeVms = opts.includeVms === true;
  const endpointNodes: VmTreeNode[] = endpoints.map((ep) => {
    const vms = vmsByEndpoint[ep.id] ?? [];
    const byNode = new Map<string, VmSummary[]>();
    for (const v of vms) {
      const list = byNode.get(v.node) ?? [];
      list.push(v);
      byNode.set(v.node, list);
    }
    const children: VmTreeNode[] = [...byNode.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, nodeVms]) => {
        const nodeChildren: VmTreeNode[] | undefined = includeVms
          ? [...nodeVms]
              .sort((a, b) => a.name.localeCompare(b.name) || a.vmid - b.vmid)
              .map((v) => ({
                id: `${ep.id}/${node}/${v.vmid}`,
                label: v.name,
                kind: 'vm' as const,
                vmCount: 1,
                runningCount: v.status === 'running' ? 1 : 0,
                vmid: v.vmid,
                type: v.type,
                status: v.status,
              }))
          : undefined;
        return {
          id: `${ep.id}/${node}`,
          label: node,
          kind: 'node' as const,
          vmCount: nodeVms.length,
          runningCount: nodeVms.filter((v) => v.status === 'running').length,
          ...(nodeChildren ? { children: nodeChildren } : {}),
        };
      });
    return {
      id: ep.id,
      label: ep.name,
      kind: 'endpoint' as const,
      vmCount: vms.length,
      runningCount: vms.filter((v) => v.status === 'running').length,
      children,
    };
  });
  return {
    id: 'dc',
    label: rootLabel,
    kind: 'datacenter',
    vmCount: endpointNodes.reduce((s, e) => s + e.vmCount, 0),
    runningCount: endpointNodes.reduce((s, e) => s + e.runningCount, 0),
    children: endpointNodes,
  };
}
