import type {
  KpiSummary,
  OvercommitConfig,
  OvercommitScale,
  PveStorageType,
  RiskThresholds,
  Severity,
  SeverityOrNa,
} from './types.js';

// ---------------------------------------------------------------------------
// Surallocation (overcommit) — politique externalisée dans overcommit.json
// (racine du repo, hot-reload). Une seule source de vérité pour les ratios
// alloué/physique et le code couleur d'usage.
// ---------------------------------------------------------------------------

/** Stockages thin-provisionnés : la taille virtuelle peut dépasser l'espace réel. */
export const THIN_STORAGE_TYPES: readonly PveStorageType[] = ['lvmthin', 'zfs', 'rbd'];

export function isThinStorage(type: PveStorageType): boolean {
  return THIN_STORAGE_TYPES.includes(type);
}

/** Valeurs par défaut (si overcommit.json absent) — seuils actés, voir skill §4. */
export const DEFAULT_OVERCOMMIT_CONFIG: OvercommitConfig = {
  usage: { warnPct: 70, critPct: 90 },
  hostRamProvisionPct: 10,
  cpu: { okMax: 2, warnMax: 4 },
  ram: { okMax: 1, warnMax: 1.2 },
  disk: { okMax: 1, warnMax: 1.5 },
  risk: { warnPct: 80, critPct: 100, warnRatio: 2, critRatio: 3 },
};

/**
 * Teinte d'un ratio de surallocation selon l'échelle de la ressource :
 * `ratio ≤ okMax` → ok · `okMax < ratio ≤ warnMax` → warn · `> warnMax` → crit.
 */
export function overcommitTone(ratio: number, scale: OvercommitScale): Severity {
  if (ratio > scale.warnMax) return 'crit';
  if (ratio > scale.okMax) return 'warn';
  return 'ok';
}

/** Code couleur d'un usage en % (badges, barres, bandes de graphiques). */
export function usageSeverity(pct: number, config: OvercommitConfig): Severity {
  if (pct > config.usage.critPct) return 'crit';
  if (pct >= config.usage.warnPct) return 'warn';
  return 'ok';
}

export interface OvercommitMetric {
  /** null = non applicable (pas de capacité physique / pas de stockage thin) */
  ratio: number | null;
  tone: SeverityOrNa;
}

export interface OvercommitReport {
  cpu: OvercommitMetric;
  ram: OvercommitMetric;
  disk: OvercommitMetric;
}

function metric(ratio: number | null, scale: OvercommitScale): OvercommitMetric {
  return ratio === null ? { ratio: null, tone: 'na' } : { ratio, tone: overcommitTone(ratio, scale) };
}

/**
 * Ratios de surallocation statiques (alloué / physique) — « si toutes les VMs
 * saturaient leur allocation en même temps, est-ce que ça tient ? » :
 * - CPU  = Σ vCPU alloués / cœurs physiques
 * - RAM  = (Σ maxmem + provision hôte) / RAM physique
 * - Disk = Σ taille disques virtuels (maxdisk) / capacité des pools thin
 *          (LVM-thin/ZFS/Ceph RBD uniquement — sans sens sur stockage thick)
 */
export function computeOvercommit(kpis: KpiSummary, config: OvercommitConfig): OvercommitReport {
  const cpu = kpis.cpuTotalCores > 0 ? kpis.cpuAllocatedCores / kpis.cpuTotalCores : null;
  const ram =
    kpis.ramTotalBytes > 0
      ? (kpis.ramAllocatedBytes + (config.hostRamProvisionPct / 100) * kpis.ramTotalBytes) / kpis.ramTotalBytes
      : null;
  const disk = kpis.diskThinTotalBytes > 0 ? kpis.diskAllocatedBytes / kpis.diskThinTotalBytes : null;
  return { cpu: metric(cpu, config.cpu), ram: metric(ram, config.ram), disk: metric(disk, config.disk) };
}

/**
 * Sévérité du risque de surallocation dynamique (pire cas = Σ p95 7 j par VM vs capacité) :
 * - 🔴 si usage pire cas > critPct % OU ratio statique ≥ critRatio× ;
 * - 🟠 si usage pire cas ≥ warnPct % OU ratio statique ≥ warnRatio× ;
 * - 🟢 sinon ; « na » si aucune des deux valeurs n'est disponible.
 */
export function riskSeverity(usagePct: number | null, ratio: number | null, th: RiskThresholds): SeverityOrNa {
  if (usagePct === null && ratio === null) return 'na';
  if ((usagePct !== null && usagePct > th.critPct) || (ratio !== null && ratio >= th.critRatio)) return 'crit';
  if ((usagePct !== null && usagePct >= th.warnPct) || (ratio !== null && ratio >= th.warnRatio)) return 'warn';
  return 'ok';
}
