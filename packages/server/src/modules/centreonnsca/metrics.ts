import type { MetricId, NodeHealth, VmSummary } from '@prox4u/shared';

/**
 * Extraction de la valeur NUMÉRIQUE d'une métrique depuis le snapshot poller
 * (VmSummary / NodeHealth). C'est cette valeur que l'engine compare au seuil.
 *
 * Convention : les métriques de statut sont 1 = bon état, 0 = mauvais état :
 * - vm_status     : running = 1, sinon 0
 * - ip_reachable  : au moins une IP détectée = 1, sinon 0
 * - node_online   : online = 1, sinon 0
 *
 * Retourne null si la valeur est indisponible (VM arrêtée pour cpu/ram/net,
 * null pour disk…) — l'engine gère le null (pas d'échantillon).
 */

/** % RAM d'une VM (memBytes / maxmemBytes × 100). */
function vmRamPct(v: VmSummary): number | null {
  if (v.memBytes == null || !v.maxmemBytes || v.maxmemBytes === 0) return null;
  return Math.round((v.memBytes / v.maxmemBytes) * 1000) / 10;
}

/** % disque d'une VM (diskBytes / maxdiskBytes × 100). */
function vmDiskPct(v: VmSummary): number | null {
  if (v.diskBytes == null || !v.maxdiskBytes || v.maxdiskBytes === 0) return null;
  return Math.round((v.diskBytes / v.maxdiskBytes) * 1000) / 10;
}

/** Valeur d'une métrique VM. */
export function vmMetricValue(metric: MetricId, v: VmSummary): number | null {
  switch (metric) {
    case 'cpu_pct':
      return v.status === 'running' ? v.cpuPct : null;
    case 'ram_pct':
      return v.status === 'running' ? vmRamPct(v) : null;
    case 'disk_pct':
      return vmDiskPct(v);
    case 'vm_status':
      return v.status === 'running' ? 1 : 0;
    case 'ip_reachable':
      return v.ipAddresses.length > 0 ? 1 : 0;
    case 'uptime_sec':
      return v.uptimeSec;
    case 'net_in_bps':
      return v.netInBps;
    case 'net_out_bps':
      return v.netOutBps;
    // métriques nœud demandées sur une VM → non disponibles
    default:
      return null;
  }
}

/** Valeur d'une métrique nœud. */
export function nodeMetricValue(metric: MetricId, n: NodeHealth): number | null {
  switch (metric) {
    case 'node_cpu_pct':
      return n.cpuPct;
    case 'node_ram_pct':
      return n.ramPct;
    case 'node_disk_pct':
      return n.diskPct;
    case 'node_online':
      return n.online ? 1 : 0;
    case 'uptime_sec':
      return n.uptimeSec;
    default:
      return null;
  }
}

/** Métriques applicables à un type de cible (pour le formulaire). */
export const VM_METRICS: MetricId[] = [
  'cpu_pct',
  'ram_pct',
  'disk_pct',
  'vm_status',
  'ip_reachable',
  'uptime_sec',
  'net_in_bps',
  'net_out_bps',
];

export const NODE_METRICS: MetricId[] = ['node_cpu_pct', 'node_ram_pct', 'node_disk_pct', 'node_online'];
