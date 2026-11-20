import {
  PveNodeStatus,
  PveVmResource,
  PraAffectedVm,
  PraReport,
  Site,
  SitePra,
  THRESHOLDS,
} from './types.js';

/**
 * PRA / bascule N-1 multi-bâtiment.
 *
 * Pour chaque site S :
 *   demande(S)      = Σ CPU/RAM ALLOUÉS de TOUTES les VMs (running + stopped)
 *                     hébergées sur les nœuds de S  (vision prudente)
 *   capacité(¬S)    = capacité des autres sites − ressources déjà consommées
 *                     (i.e. la capacité LIBRE des nœuds des autres sites)
 *   absorption(S)   = demande(S) / capacité(¬S)
 *
 * Le DISK est exclu du calcul (stockage partagé Ceph/NFS : la bascule ne
 * dépend que du CPU/RAM).
 *
 * Jauges : 🟢 < 70 % · 🟠 70–100 % · 🔴 > 100 % (« absorption impossible »)
 * Le PRA ne s'applique que si les nœuds sont RÉPARTIS sur ≥ 2 sites (mono-nœud,
 * ou tous les nœuds sur le même site → absorption = null, sévérité « na »).
 * Prérequis : le stockage doit être identique (iso) d'un site à l'autre pour que
 * la bascule soit valide (d'où l'exclusion du disque du calcul).
 * `unmappedNodes` = nœuds du cluster non mappés dans un site (filet de sécurité :
 * ces nœuds ne sont pas couverts par le PRA).
 */
export function computePra(
  sites: Site[],
  nodes: PveNodeStatus[],
  vms: PveVmResource[],
): PraReport {
  const nodeBySite = new Map<string, string>(); // nodeId -> siteId
  for (const s of sites) for (const n of s.nodes) nodeBySite.set(n, s.id);

  const nodesById = new Map(nodes.map((n) => [n.node, n]));

  // Allocation par nœud (toutes VMs, running + stopped)
  const allocCpu = new Map<string, number>();
  const allocRam = new Map<string, number>();
  for (const vm of vms) {
    allocCpu.set(vm.node, (allocCpu.get(vm.node) ?? 0) + cpuAllocOf(vm));
    allocRam.set(vm.node, (allocRam.get(vm.node) ?? 0) + (vm.maxmem ?? 0));
  }

  // Le PRA ne s'applique que si les nœuds sont RÉPARTIS sur ≥ 2 sites ayant au
  // moins un nœud présent (mono-nœud, ou tous les nœuds sur le même site → na).
  const multiSite = sites.filter((s) => s.nodes.some((n) => nodesById.has(n))).length > 1;

  // Filet de sécurité : nœuds du cluster non mappés dans AUCUN site → non
  // couverts par le PRA (à mapper dans sites.json).
  const mappedNodes = new Set<string>();
  for (const s of sites) for (const n of s.nodes) mappedNodes.add(n);
  const unmappedNodes = nodes.map((n) => n.node).filter((n) => !mappedNodes.has(n));

  const siteResult: SitePra[] = sites.map((site) => {
    const siteNodes = site.nodes.filter((n) => nodesById.has(n));

    let demandCpu = 0;
    let demandRamBytes = 0;
    for (const nodeId of siteNodes) {
      demandCpu += allocCpu.get(nodeId) ?? 0;
      demandRamBytes += allocRam.get(nodeId) ?? 0;
    }

    let capCpu = 0;
    let capRam = 0;
    for (const n of nodes) {
      if (nodeBySite.get(n.node) === site.id) continue;
      const cpus = n.cpus ?? 0;
      const memTotal = n.memTotal ?? 0;
      capCpu += Math.max(0, cpus - (allocCpu.get(n.node) ?? 0));
      capRam += Math.max(0, memTotal - (allocRam.get(n.node) ?? 0));
    }

    let absorptionPct: number | null = null;
    if (multiSite) {
      const cpuRatio = capCpu > 0 ? demandCpu / capCpu : demandCpu > 0 ? Infinity : 0;
      const ramRatio = capRam > 0 ? demandRamBytes / capRam : demandRamBytes > 0 ? Infinity : 0;
      absorptionPct = Math.max(cpuRatio, ramRatio) * 100;
    }

    const severity =
      absorptionPct === null
        ? 'na'
        : absorptionPct > THRESHOLDS.praCrit
          ? 'crit'
          : absorptionPct >= THRESHOLDS.praWarn
            ? 'warn'
            : 'ok';

    return {
      siteId: site.id,
      siteName: site.name,
      nodes: site.nodes,
      demandCpu: round1(demandCpu),
      demandRamBytes,
      capacityElsewhereCpu: round1(capCpu),
      capacityElsewhereRamBytes: capRam,
      // 999 = sentinel « absorption impossible » (Infinity n'est pas sérialisable en JSON)
      absorptionPct:
        absorptionPct === null ? null : Number.isFinite(absorptionPct) ? Math.round(absorptionPct * 10) / 10 : 999,
      severity,
    };
  });

  const ranked = [...siteResult].sort((a, b) => (b.absorptionPct ?? -1) - (a.absorptionPct ?? -1));
  const globalSeverity =
    !multiSite
      ? 'na'
      : ranked.some((s) => s.severity === 'crit')
        ? 'crit'
        : ranked.some((s) => s.severity === 'warn')
          ? 'warn'
          : 'ok';

  const worst = ranked[0];
  let affectedVms: PraAffectedVm[] = [];
  if (worst && worst.severity !== 'na' && worst.severity !== 'ok') {
    const worstNodes = new Set(sites.find((s) => s.id === worst.siteId)?.nodes ?? []);
    affectedVms = vms
      .filter((vm) => worstNodes.has(vm.node))
      .map((vm) => ({
        vmid: vm.vmid,
        name: vm.name,
        node: vm.node,
        cpu: round1(cpuAllocOf(vm)),
        memBytes: vm.maxmem ?? 0,
      }))
      .sort((a, b) => b.memBytes - a.memBytes);
  }

  return { sites: siteResult, globalSeverity, affectedVms, unmappedNodes };
}

/** Cœurs alloués d'une VM (joint par le server depuis la config, absent de /cluster/resources). */
function cpuAllocOf(vm: PveVmResource): number {
  return vm.cpuAlloc ?? 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
