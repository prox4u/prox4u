// ---------------------------------------------------------------------------
// Types de domaine partagés (server <-> web)
// ---------------------------------------------------------------------------

import type { ParsedVmNet, VmAgentNetIf } from './network.js';

export type Severity = 'ok' | 'warn' | 'crit';
export type SeverityOrNa = Severity | 'na';

// --- Données brutes Proxmox VE 9 ------------------------------------------

export interface PveVmResource {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  status: 'running' | 'stopped' | 'paused' | 'unknown';
  node: string;
  /** utilisation CPU : fraction des cœurs alloués (0..cpuAlloc) */
  cpu: number | null;
  /** cœurs alloués (joint par le server depuis la config VM, absent de /cluster/resources) */
  cpuAlloc?: number;
  /** famille OS (Linux/Unix, Windows, LXC, Autre) — jointe depuis la config */
  os?: string;
  /** octets utilisés */
  mem: number | null;
  /** octets alloués */
  maxmem: number | null;
  /** octets utilisés (peut être 0/absent selon stockage) */
  disk: number | null;
  /** octets alloués */
  maxdisk: number | null;
  netin: number | null;
  netout: number | null;
  diskread: number | null;
  diskwrite: number | null;
  uptime: number | null;
  template?: number;
  pool?: string | null;
  /** Datastore sur lequel repose le disque de la VM (champ `storage` de /cluster/resources). */
  storage?: string;
  /** Adresses IP détectées par PVE (`ipaddresses` — guest agent / ARP) — absentes si non rapportées. */
  ipAddresses?: string[];
}

export interface PveNodeStatus {
  node: string;
  online: boolean;
  ip?: string;
  /** fraction de la capacité CPU totale (0..cpus) */
  cpu: number | null;
  cpus: number | null;
  memTotal: number | null;
  memUsed: number | null;
  swapTotal: number | null;
  swapUsed: number | null;
  loadavg: [number, number, number] | null;
  uptime: number | null;
  rootfsTotal: number | null;
  rootfsUsed: number | null;
  /** octets/seconde (réseau nœud) */
  netin: number | null;
  netout: number | null;
  version?: string;
}

export type PveStorageType =
  | 'dir'
  | 'lvm'
  | 'lvmthin'
  | 'zfs'
  | 'nfs'
  | 'rbd'
  | 'cephfs'
  | 'pbs'
  | 'iscsi'
  | 'cifs';

export interface PveStorage {
  storage: string;
  type: PveStorageType;
  content: string[];
  used: number | null;
  total: number | null;
  shared?: boolean;
  /** Nœuds qui exposent ce datastore (champ `nodes` de /storage). Vide = inconnu. */
  nodes?: string[];
}

export interface PvePool {
  poolid: string;
  comment?: string;
  users?: string[];
}

export interface RrddataPoint {
  /** unix seconds */
  time: number;
  /** fraction (0..1) */
  cpu: number | null;
  /** octets */
  mem: number | null;
  /** octets */
  disk: number | null;
  netin: number | null;
  netout: number | null;
}

// --- Topologie (sites.json) -------------------------------------------------

export interface Site {
  id: string;
  name: string;
  /** endpoint (cluster) concerné ; absent = endpoint par défaut (rétro-compat) */
  endpoint?: string;
  nodes: string[];
}

// --- Multi-endpoints (clusters.json) ------------------------------------------

/** Vue compacte d'un endpoint pour la sidebar / la vue d'ensemble. */
export interface EndpointSummary {
  id: string;
  name: string;
  /** dernier poll réussi ? */
  ok: boolean;
  /** message d'erreur du dernier échec (si !ok) */
  error?: string;
  nodesOnline: number;
  nodesTotal: number;
  vmsRunning: number;
  vmsTotal: number;
  healthScore: number | null;
  healthLabel: 'nominal' | 'degraded' | 'critical' | null;
}

/** Snapshot d'un endpoint : dernier DashboardSnapshot connu + état du poll. */
export interface EndpointSnapshot {
  id: string;
  name: string;
  /** URL API PVE (https://host:8006) — liens console VM dans l'UI PVE */
  url?: string;
  ok: boolean;
  error?: string;
  /** dernier snapshot réussi (null si jamais réussi) */
  snapshot: DashboardSnapshot | null;
}

/** Snapshot multi-endpoints poussé en WS + GET /api/dashboard. */
export interface MultiDashboardSnapshot {
  generatedAt: number;
  mock: boolean;
  defaultEndpointId: string;
  /** politique de surallocation (overcommit.json, hot-reload) — source unique du code couleur */
  overcommit: OvercommitConfig;
  endpoints: EndpointSnapshot[];
}

// --- Surallocation (overcommit.json) ------------------------------------------

/** Échelle d'une ressource : ratio ≤ okMax → ok · ≤ warnMax → warn · au-delà crit. */
export interface OvercommitScale {
  okMax: number;
  warnMax: number;
}

/** Politique de surallocation + code couleur d'usage (fichier overcommit.json). */
export interface OvercommitConfig {
  /** seuils d'usage en % pour le code couleur (badges, barres, bandes de graphiques) */
  usage: { warnPct: number; critPct: number };
  /** provision hôte ajoutée au numérateur du ratio RAM (% de la RAM physique) */
  hostRamProvisionPct: number;
  cpu: OvercommitScale;
  ram: OvercommitScale;
  disk: OvercommitScale;
  /** seuils du risque dynamique (pire cas = Σ p95 7 j par VM vs capacité physique) */
  risk: RiskThresholds;
}

/**
 * Seuils du risque de surallocation dynamique :
 * - usagePct = demande pire cas (Σ p95 7 j par VM) en % de la capacité physique ;
 * - ratio    = surallocation statique alloué/physique (×).
 */
export interface RiskThresholds {
  /** usage pire cas ≥ warnPct → warn, > critPct → crit */
  warnPct: number;
  critPct: number;
  /** ratio statique ≥ warnRatio → warn, ≥ critRatio → crit */
  warnRatio: number;
  critRatio: number;
}

// --- Risque de surallocation dynamique (/api/overcommit-risk) -------------------

/** Risque d'une ressource : usage pire cas + ratio statique → sévérité. */
export interface RiskMetric {
  /** demande pire cas (Σ p95 7 j par VM) en % de la capacité physique ; null = non calculable */
  usagePct: number | null;
  /** surallocation statique alloué/physique (×) ; null = non applicable */
  ratio: number | null;
  severity: SeverityOrNa;
}

/** Réponse de GET /api/overcommit-risk. */
export interface OvercommitRiskResponse {
  /** true si aucune VM en marche n'a d'historique p95 → risque non calculable (na) */
  insufficientData: boolean;
  cpu: RiskMetric & { demandCores: number; capacityCores: number };
  ram: RiskMetric & { demandRamBytes: number; capacityRamBytes: number };
  storage: { usagePct: number; daysTo90: number | null; severity: SeverityOrNa };
  /** p95 par VM en marche (null = pas d'historique → usage courant utilisé) */
  vms: { vmid: number; name: string; cpuP95Pct: number | null; memP95Bytes: number | null }[];
}

// --- Health Score ------------------------------------------------------------

export interface HealthPenalty {
  /** clé i18n du motif */
  reasonKey: string;
  params?: Record<string, string | number>;
  points: number;
}

export interface HealthScore {
  /** 0..100 */
  score: number;
  label: 'nominal' | 'degraded' | 'critical';
  penalties: HealthPenalty[];
}

// --- KPIs --------------------------------------------------------------------

export interface KpiSummary {
  nodes: { online: number; total: number };
  /** cœurs alloués (nœuds en ligne) — pour l'agrégation pondérée multi-endpoints */
  cpuTotalCores: number;
  /** cœurs utilisés (nœuds en ligne) */
  cpuUsedCores: number;
  /** % de la capacité CPU totale du cluster */
  cpuPct: number;
  /** vCPU alloués aux VMs (templates exclus) — pour le ratio de surallocation */
  cpuAllocatedCores: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  ramPct: number;
  /** RAM allouée aux VMs (maxmem, templates exclus) — pour le ratio de surallocation */
  ramAllocatedBytes: number;
  /** taille des disques virtuels alloués aux VMs (maxdisk, templates exclus) — ratio de surallocation disk */
  diskAllocatedBytes: number;
  /** capacité des pools thin (LVM-thin/ZFS/Ceph RBD) — dénominateur du ratio de surallocation disk */
  diskThinTotalBytes: number;
  storageUsedBytes: number;
  storageTotalBytes: number;
  storagePct: number;
  /** jours avant saturation (null si stable/décroissant) */
  storageDaysToFull: number | null;
  vmsRunning: number;
  vmsStopped: number;
  vmsTotal: number;
}

// --- PRA N-1 -------------------------------------------------------------------

export interface SitePra {
  siteId: string;
  siteName: string;
  /** cœurs alloués (toutes VMs running+stopped du site) */
  demandCpu: number;
  demandRamBytes: number;
  /** capacité libre des AUTRES sites (après consommation existante) */
  capacityElsewhereCpu: number;
  capacityElsewhereRamBytes: number;
  /** % d'absorption ; null si un seul site */
  absorptionPct: number | null;
  severity: SeverityOrNa;
}

export interface PraAffectedVm {
  vmid: number;
  name: string;
  node: string;
  cpu: number;
  memBytes: number;
}

export interface PraReport {
  sites: SitePra[];
  globalSeverity: SeverityOrNa;
  /** VMs du site le plus contraint (vide si na/ok) */
  affectedVms: PraAffectedVm[];
}

// --- Capacity planning ---------------------------------------------------------

export type CapacityMetric = 'cpu' | 'ram' | 'disk';

export interface CapacityForecast {
  metric: CapacityMetric;
  /** true si moins de 7 jours d'historique valide (pas de projection fiable) */
  insufficientData: boolean;
  /** moyennes journalières, % de la capacité (30 j) */
  history: { time: number; value: number }[];
  /** % par jour (régression linéaire) */
  slopePerDay: number;
  daysTo80: number | null;
  daysTo90: number | null;
  /** projection 30 j, % (vide si insufficientData) */
  projection: { time: number; value: number }[];
}

// --- Consommateurs ---------------------------------------------------------------

export interface TopConsumer {
  vmid: number;
  name: string;
  node: string;
  pool: string | null;
  /** % du CPU alloué à la VM */
  cpuPct: number;
  memBytes: number;
  memPct: number;
}

export interface PoolAggregate {
  pool: string;
  vmCount: number;
  runningCount: number;
  cpuPct: number;
  memBytes: number;
}

// --- Tendances ---------------------------------------------------------------------

export interface TrendPoint {
  /** unix seconds (jour) */
  time: number;
  cpuPct: number;
  ramPct: number;
}

export interface OsSlice {
  os: string;
  count: number;
}

// --- Nœuds ---------------------------------------------------------------------------

export interface NodeHealth {
  node: string;
  online: boolean;
  siteId: string | null;
  cpuPct: number;
  ramPct: number;
  diskPct: number;
  uptimeSec: number | null;
  severity: Severity;
  /** Détails pour la page nœud */
  ip?: string;
  cpus: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  loadavg: [number, number, number] | null;
  version?: string;
  /** vCPU alloués aux VMs du nœud (templates exclus) — ratio de surallocation CPU */
  cpuAllocCores: number;
  /** RAM allouée aux VMs du nœud (maxmem, templates exclus) — ratio de surallocation RAM */
  ramAllocBytes: number;
}

/** VM compacte (snapshot) — listes par nœud, sans les flux réseau. */
export interface VmSummary {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  status: 'running' | 'stopped' | 'paused' | 'unknown';
  node: string;
  /** % du CPU alloué à la VM (0 si arrêtée) */
  cpuPct: number;
  memBytes: number;
  maxmemBytes: number | null;
  // --- Inventaire VM (plugin vm-inventory) ---
  /** octets disque utilisés (null si indisponible) */
  diskBytes: number | null;
  /** octets disque alloués (null si indisponible) */
  maxdiskBytes: number | null;
  /** cœurs alloués (0 si inconnu) */
  cpuAllocCores: number;
  /** famille OS (Linux/Unix, Windows, LXC, Autre) — null si config indisponible */
  os: string | null;
  /** uptime en secondes (null si arrêtée) */
  uptimeSec: number | null;
  // --- Métriques live par VM (onglet Monitor) — /cluster/resources PVE ---
  /** réseau entrant, bits/s (unité PVE) — null si arrêtée */
  netInBps: number | null;
  /** réseau sortant, bits/s (unité PVE) — null si arrêtée */
  netOutBps: number | null;
  /** lecture disque, octets/s — null si arrêtée */
  diskReadBps: number | null;
  /** écriture disque, octets/s — null si arrêtée */
  diskWriteBps: number | null;
  /** Adresses IP détectées live (`ipaddresses` de /cluster/resources) — vide si non rapportées. */
  ipAddresses: string[];
}

/** Snapshot d'une VM (GET /nodes/{n}/{type}/{vmid}/snapshot). */
export interface PveVmSnapshot {
  name: string;
  /** timestamp unix (secondes), null si absent */
  time: number | null;
  /** snapshot de la mémoire (état complet) */
  memory: boolean;
  note?: string;
}

/** Configuration d'une VM (GET /nodes/{n}/{type}/{vmid}/config, parsé) — cache 1 h côté serveur. */
export interface VmConfigInfo {
  /** cœurs alloués */
  cpuAlloc: number;
  /** OS (qemu) ou image (lxc) */
  os: string;
  pool: string | null;
  /** interfaces réseau branchées sur un pont (parsing bridge= des interfaces netN / mpN) */
  nets: ParsedVmNet[];
  /** datastore du disque principal (parse de la config) — absent de /cluster/resources sur PVE 9. */
  diskStorage?: string;
}

/** Détail d'une VM (GET /api/vm-config?endpoint=&vmid=) : live + config + snapshots. */
export interface VmDetailResponse {
  /** état live (snapshot courant, push 5 s) */
  vm: VmSummary;
  /** configuration parsée (cache 1 h), null si indisponible */
  config: VmConfigInfo | null;
  /** snapshots (appel à la demande, cache 5 min) */
  snapshots: PveVmSnapshot[];
  /** interfaces live (guest agent QEMU / netns LXC PVE ≥ 9) — IP+MAC par interface ; [] si VM arrêtée */
  agentNets: VmAgentNetIf[];
}

/** Point de métriques par VM (GET /api/vm-metrics) — InfluxDB vm_metrics. */
export interface VmMetricsPoint {
  /** unix seconds */
  time: number;
  /** % du CPU alloué à la VM (null si absent sur le bucket) */
  cpuPct: number | null;
  /** RAM utilisée en octets (null si absente sur le bucket) */
  memBytes: number | null;
  /** lecture disque, octets/s (null si champ absent — données antérieures à l'extension du poller) */
  diskReadBps: number | null;
  /** écriture disque, octets/s */
  diskWriteBps: number | null;
  /** réseau entrant, bits/s (unité PVE) */
  netInBps: number | null;
  /** réseau sortant, bits/s (unité PVE) */
  netOutBps: number | null;
}

/** Métriques historiques d'une VM (GET /api/vm-metrics?endpoint=&vmid=&timeframe=). */
export interface VmMetricsResponse {
  timeframe: MetricsTimeframe;
  vmid: number;
  points: VmMetricsPoint[];
  /** 'influx' = données réelles · 'insufficientData' = pas de série (InfluxDB indisponible, VM arrêtée ou trop récente) */
  source: 'influx' | 'insufficientData';
}

// --- Alertes ---------------------------------------------------------------------------

export interface Alert {
  id: string;
  severity: Severity;
  messageKey: string;
  params?: Record<string, string | number>;
}

// --- Stockage / réseau (snapshot) ---------------------------------------------------------

export interface StorageInfo {
  storage: string;
  type: PveStorageType;
  usedBytes: number;
  totalBytes: number;
  pct: number;
}

export interface ClusterNetwork {
  /** octets/seconde, somme des VMs en marche */
  rxBps: number;
  txBps: number;
}

// --- Métriques historiques (GET /api/metrics) ------------------------------------------------

export type MetricsTimeframe = 'hour' | 'day' | 'week' | 'month';

export interface MetricsPoint {
  /** unix seconds */
  time: number;
  /** % de la capacité CPU du cluster (moyenne des nœuds en ligne) */
  cpuPct: number;
  /** % de la RAM du cluster */
  ramPct: number;
  /**
   * % du stockage VM (Σ used / Σ total, pondéré par capacité).
   * null = pas d'historique pour ce bucket (série storage_metrics en cours
   * de remplissage). En repli RRD (InfluxDB indisponible) : usage rootfs
   * des nœuds — aucune histoire de stockage VM n'est disponible côté PVE.
   */
  storagePct: number | null;
  /** octets/seconde (somme des nœuds) */
  netInBps: number;
  netOutBps: number;
}

/** origine des points : InfluxDB (natif) ou repli RRD Proxmox */
export type MetricSource = 'influx' | 'rrd';

export interface MetricsResponse {
  timeframe: MetricsTimeframe;
  points: MetricsPoint[];
  source: MetricSource;
}

// --- Snapshot complet (push WS + GET /api/dashboard) ------------------------------------

export interface DashboardSnapshot {
  generatedAt: number;
  mock: boolean;
  cluster: { name: string; nodesOnline: number; nodesTotal: number };
  sites: Site[];
  health: HealthScore;
  kpis: KpiSummary;
  pra: PraReport;
  nodes: NodeHealth[];
  /** toutes les VMs (compactes) — pour la page nœud */
  vms: VmSummary[];
  storages: StorageInfo[];
  network: ClusterNetwork;
  topVms: TopConsumer[];
  topPools: PoolAggregate[];
  alerts: Alert[];
}

// --- Seuils partagés ----------------------------------------------------------------------

/**
 * Seuils des formules déterministes documentées (health score, PRA) — volontairement
 * fixes : le code couleur d'usage et les ratios de surallocation, eux, sont pilotés
 * par overcommit.json (voir OvercommitConfig / usageSeverity).
 */
export const THRESHOLDS = {
  warn: 70,
  crit: 90,
  praWarn: 70,
  praCrit: 100,
  healthNominal: 80,
  healthDegraded: 50,
} as const;
