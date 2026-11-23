// ---------------------------------------------------------------------------
// Types de domaine partagés (server <-> web)
// ---------------------------------------------------------------------------

import type { ParsedVmNet, VmAgentNetIf } from './network.js';
import type { AuditScore } from './audit.js';

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
  /** famille OS (Linux/Unix, Windows, LXC, Autre) — jointe depuis la config (dernier recours) */
  os?: string;
  /** code `ostype` PVE brut (ex. `l26`, `w2k22`) — joint depuis la config, repli pour les VMs sans agent */
  ostype?: string;
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
  /** Tous les disques de la VM (datastore + taille allouée) — joints depuis la config. Une VM peut en avoir plusieurs, sur des datastores différents. */
  disks?: VmDisk[];
  /** Adresses IP détectées par PVE (`ipaddresses` — guest agent / ARP) — absentes si non rapportées. */
  ipAddresses?: string[];
  /** Tags de la VM (config `tags`, séparés par des virgules) — joints depuis la config. */
  tags?: string[];
  /** Description / notes (config `description`) — jointe depuis la config. */
  notes?: string;
  /** Nom d'hôte (config `hostname`) — joint depuis la config, sans agent invité. */
  hostname?: string;
  /** Architecture (config `arch`, ex. `amd64`) — jointe depuis la config, sans agent invité. */
  arch?: string;
  /** LXC : non privilégié ? `false` = privilégié — joint depuis la config. */
  unprivileged?: boolean;
  /** QEMU : `cpu=host` ? — joint depuis la config. */
  cpuHost?: boolean;
  /** autostart activé ? (config `autostart`, défaut PVE = 0/désactivé) — joint depuis la config. */
  autostart?: boolean;
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

/** État du quorum cluster (entrée cluster de /cluster/status). */
export type QuorumState = 'ok' | 'lost';

/**
 * État du Qdevice (vote externe de quorum, ex. `pvecm status` → membership
 * « Qdevice »). Source : corosync (table Telegraf `quorum_detail`) en priorité,
 * sinon déduit de l'API PVE (l'API n'expose pas le Qdevice).
 * 'up' = en ligne, 'down' = configuré mais hors ligne, 'absent' = pas de
 * Qdevice configuré, 'unknown' = indéterminé (pas de données / les nœuds
 * suffisent et l'API ne permet pas de trancher).
 */
export type QdeviceState = 'up' | 'down' | 'absent' | 'unknown';

/** Détail du quorum corosync (table Telegraf `quorum_detail`, `pvecm status`). */
export interface QuorumDetail {
  expectedVotes: number;
  totalVotes: number;
  quorumThreshold: number;
  quorate: boolean;
  hasQdevice: boolean;
  qdeviceOnline: boolean;
}

/** Statut cluster + nœuds (GET /cluster/status) — quorum inclus. */
export interface PveClusterStatus {
  nodes: PveNodeStatus[];
  /** quorum requis (majorité) — null si inconnu. */
  quorum: number | null;
  /** état du quorum (rapporté PVE 8+ ou dérivé) — null si inconnu. */
  quorumState: QuorumState | null;
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
  /**
   * VG LVM qui reposent sur ce datastore — même volume physique vu deux fois (une cible iSCSI
   * sur laquelle repose un VG LVM est remontée en datastore `iscsi` ET en datastore `lvm`).
   * Posé sur le datastore iSCSI (le LUN = le volume physique de référence) : la liste des VG
   * enfants, qui en sont les vues redondantes. Le LUN est compté, ses VG enfants sont exclus
   * des agrégations de capacité (comptés via le LUN, pas deux fois). Plusieurs VG possibles sur
   * un même LUN (vrai matériel).
   */
  duplicateOf?: string[];
}

/**
 * Allocation de disques VM par datastore — agrégée par le poller depuis `VmSummary.disks[]`
 * (Σ taille allouée `size=` des disques de chaque VM sur ce datastore, templates exclus).
 * C'est la donnée qui permet de savoir **sur quel datastore** chaque disque est posé.
 */
export interface StorageDiskAlloc {
  /** nom du datastore. */
  storage: string;
  /** Σ taille allouée des disques VM sur ce datastore (octets). */
  allocatedBytes: number;
}

/**
 * Volume physique de stockage — hiérarchie iSCSI → LVM. Un LUN iSCSI est le volume physique de
 * référence ; les VG LVM qui reposent dessus en sont les **enfants** (un LUN peut porter
 * plusieurs VG — vrai matériel). Capacité du LUN comptée UNE seule fois (pas la somme des vues).
 * « Analyse intelligente » : on distingue thin (sur-allocation possible) de thick (usage).
 *
 * Sémantique d'« utilisé » d'un LUN : la somme des tailles des VG enfants (espace **engagé /
 * réservé** par les VG), PAS les données des VG. Ex. LUN 600 Go / VG 100 Go → 100 Go engagés,
 * 500 Go libres. Chaque VG enfant affiche, lui, ses propres données/taille.
 */
export interface StorageVolume {
  /** Datastore de référence du volume (le LUN s'il a des VG enfants, sinon le datastore lui-même). */
  storage: string;
  type: PveStorageType;
  /** VG LVM enfants du volume (un LUN iSCSI peut porter plusieurs VG). Vide si aucun enfant. */
  children: StorageVolume[];
  /** Capacité du volume, comptée UNE seule fois (LUN : taille du LUN ou somme des VG — pas les deux). */
  totalBytes: number | null;
  /** octets utilisés (LUN : Σ tailles des VG enfants = espace engagé · VG/volume : données). */
  usedBytes: number | null;
  /** Σ disques VM alloués sur le volume (tous les VG enfants confondus). */
  allocatedBytes: number;
  /** Le volume est thin-capable (lvmthin/zfs/rbd) ? */
  thinCapable: boolean;
  /** Des disques VM reposent sur ce volume ? */
  hasDisks: boolean;
  /** Ratio (LUN : engagé/capacité · VG : alloué/taille VG), null si pas de capacité connue. */
  ratio: number | null;
  /** Sémantique du ratio : overcommit (thin, peut >1) / usage (thick, ≤1) / na (pas de disques). */
  kind: 'overcommit' | 'usage' | 'na';
  /** Tonalité du ratio (politique overcommit si thin, politique d'usage si thick, na sinon). */
  tone: SeverityOrNa;
  /**
   * Origine de la capacité d'un LUN iSCSI : 'lun' = taille du LUN connue (config
   * storage-volumes.json, valeur d'autorité) · 'vg-sum' = somme des tailles des VG enfants
   * (**borne basse** — le LUN peut être plus grand). Absent pour les volumes non-LUN (leur
   * capacité est leur propre taille PVE, sans ambiguïté).
   */
  totalSource?: 'lun' | 'vg-sum';
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
  /**
   * URL qui a réellement servi les données du dernier poll (failover) — définie
   * seulement si elle diffère de `url` (nœud endpoint down, bascule sur un autre
   * nœud du cluster). Absente sinon.
   */
  apiVia?: string;
  /** dernier snapshot réussi (null si jamais réussi) */
  snapshot: DashboardSnapshot | null;
}

/**
 * Santé InfluxDB 3 Core (globale — ressource unique, non par endpoint).
 * Posée par le poller dans le snapshot multi (WS, zéro API pour le front) :
 * compteurs d'écriture en mémoire (getStats) + headroom fichiers (fileEstimate)
 * + ping mis en cache 60 s (null = 1ʳᵉ mesure en cours).
 */
export interface InfluxStatus {
  enabled: boolean;
  /** dernier ping (cache 60 s) — null si la 1ʳᵉ mesure est encore en cours */
  ping: boolean | null;
  /** lignes en file d'attente (instantané) */
  queueDepth: number;
  /** total des lignes enfileées (monotone) */
  enqueued: number;
  /** total des lignes écrites (monotone) */
  flushed: number;
  /** total des lignes abandonnées (monotone) */
  dropped: number;
  /** lots d'écriture en échec (monotone) */
  failedBatches: number;
  /** headroom fichiers (estimation vs --query-file-limit) */
  headroom: 'ok' | 'warn' | 'crit';
  /** fichiers estimés pour la plus longue requête simple (chunk) */
  chunkFiles: number;
  /** --query-file-limit du service */
  fileLimit: number;
}

/** Snapshot multi-endpoints poussé en WS + GET /api/dashboard. */
export interface MultiDashboardSnapshot {
  generatedAt: number;
  mock: boolean;
  defaultEndpointId: string;
  /** politique de surallocation (overcommit.json, hot-reload) — source unique du code couleur */
  overcommit: OvercommitConfig;
  endpoints: EndpointSnapshot[];
  /**
   * PRA GLOBAL cross-endpoints (niveau 3) : si un bâtiment/site tombe, les
   * AUTRES sites de TOUS les endpoints peuvent absorber (prérequis : stockage
   * iso d'un site à l'autre). Calculé par le poller à chaque tick à partir des
   * données brutes de tous les endpoints (noms de nœuds préfixés par l'endpoint
   * pour éviter les collisions et clarifier l'origine). null si aucun site
   * défini. Complément du PRA par endpoint (snapshot.pra) qui ne considère que
   * les sites du même endpoint.
   */
  globalPra: PraReport | null;
  /**
   * Santé InfluxDB 3 Core (globale) : compteurs d'écriture + headroom fichiers
   * + ping 60 s. null si InfluxDB est désactivé (repli RRD).
   */
  influx: InfluxStatus | null;
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
  /** taille des disques virtuels alloués aux VMs (maxdisk, templates exclus) — toutes vues confondues */
  diskAllocatedBytes: number;
  /** disques alloués SUR les pools thin uniquement — numérateur du ratio de surallocation disk */
  diskThinAllocatedBytes: number;
  /** capacité des pools thin **qui hébergent des disques VM** — dénominateur du ratio (0 → ratio n/a) */
  diskThinTotalBytes: number;
  storageUsedBytes: number;
  storageTotalBytes: number;
  storagePct: number;
  /** jours avant saturation (null si stable/décroissant) */
  storageDaysToFull: number | null;
  vmsRunning: number;
  vmsStopped: number;
  vmsTotal: number;
  /** VMs QEMU en cours dont l'agent invité est inactif (agentActive === false) — alerte critique */
  vmsAgentDown: number;
}

// --- PRA N-1 -------------------------------------------------------------------

export interface SitePra {
  siteId: string;
  siteName: string;
  /**
   * Nœuds du site (mapping nœud→bâtiment, sites.json) — pour le mapping
   * visible en UI. Dans le PRA global, les noms sont préfixés par l'endpoint
   * (`clusterproxmox/ProxSite1`) ; dans le PRA par endpoint, non préfixés.
   */
  nodes: string[];
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
  /**
   * Nœuds du cluster non mappés dans AUCUN site (filet de sécurité) — non
   * couverts par le PRA, à mapper dans sites.json. Absent dans les anciens
   * snapshots (optionnel pour la rétro-compat).
   */
  unmappedNodes?: string[];
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
  /** Disque système (rootfs) utilisé (octets) — null si inconnu. */
  rootfsUsedBytes: number | null;
  /** Disque système (rootfs) total (octets) — null si inconnu. */
  rootfsTotalBytes: number | null;
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
  // --- Vue VM (plugin vm-view) ---
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
  // --- Agent invité QEMU (QGA) ---
  /**
   * État de l'agent invité : true = QGA répond (get-fsinfo ok, y compris sans fs sur
   * disque VM) · false = VM QEMU en cours mais agent non démarré / injoignable (CRITIQUE)
   * · null = n/a (LXC, VM arrêtée) ou inconnu (cache agent pas encore réchauffé au démarrage).
   */
  agentActive: boolean | null;
  // --- Audit / best-practices (config, cache 1 h) ---
  /** LXC : non privilégié ? `false` = privilégié (audit) · absent pour QEMU. */
  unprivileged?: boolean;
  /** QEMU : `cpu=host` ? (audit) · absent pour LXC. */
  cpuHost?: boolean;
  /** autostart activé ? (audit) · `false` = désactivé (défaut PVE) · absent si config inconnue. */
  autostart?: boolean;
  /** Âge du snapshot le plus vieux (jours) — null si pas de snapshot · absent si inconnu (réchauffage de fond). */
  oldestSnapshotAgeDays?: number | null;
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

/** Statut d'un job de réplication (GET /cluster/replication — statut inclus). */
export interface PveReplicationStatus {
  vmid: number;
  /** dernier résultat (« ok » / autre) — null si jamais exécuté. */
  lastResult: string | null;
  /** fin de la dernière exécution (unix secondes) — null si jamais exécuté. */
  lastEndTime: number | null;
}

/** Configuration d'une VM (GET /nodes/{n}/{type}/{vmid}/config, parsé) — cache 1 h côté serveur. */
/** Disque d'une VM (un volume de la config) : datastore + taille allouée. */
export interface VmDisk {
  /** nom du datastore qui héberge le disque (parse du préfixe « storage:volume »). */
  storage: string;
  /** taille allouée du disque (config `size=`), en octets. */
  sizeBytes: number;
}

export interface VmConfigInfo {
  /** cœurs alloués */
  cpuAlloc: number;
  /** OS (qemu) ou image (lxc) — famille, dernier recours si ni agent ni ostype */
  os: string;
  /** code `ostype` PVE brut (ex. `l26`, `w2k22`) — repli famille OS sans agent */
  ostype?: string;
  /** nom d'hôte (config `hostname`) — sans agent invité */
  hostname?: string;
  /** architecture (config `arch`, ex. `amd64`) — sans agent invité */
  arch?: string;
  pool: string | null;
  /** interfaces réseau branchées sur un pont (parsing bridge= des interfaces netN / mpN) */
  nets: ParsedVmNet[];
  /** datastore du disque principal (parse de la config) — absent de /cluster/resources sur PVE 9. */
  diskStorage?: string;
  /** tous les disques de la VM (un par volume non-ISO de la config) — une VM peut en avoir plusieurs, sur des datastores différents. */
  disks?: VmDisk[];
  /** tags (config `tags`, chaîne séparée par des virgules → tableau) */
  tags?: string[];
  /** description / notes (config `description`) */
  description?: string;
  /**
   * LXC : conteneur NON privilégié (`unprivileged=1`, défaut) ? `false` =
   * privilégié (`unprivileged=0`, accès direct aux devices hôte). Absent pour QEMU.
   */
  unprivileged?: boolean;
  /** QEMU : type CPU `host` (`cpu=host`) ? Recommandé pour la migration live. Absent pour LXC. */
  cpuHost?: boolean;
  /** autostart activé ? (config `autostart`, défaut PVE = 0/désactivé). `false` = désactivé (absent ou 0). */
  autostart?: boolean;
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
  /** espace disque utilisé par la VM, en octets. QEMU : via l'agent guest (get-fsinfo, fs sur disques VM). LXC : champ `disk` de /cluster/resources (rootfs). null si agent indisponible / VM trop récente. */
  diskBytes: number | null;
  /** espace disque alloué à la VM, en octets (champ `maxdisk`). */
  diskAllocBytes: number | null;
}

/** Métriques historiques d'une VM (GET /api/vm-metrics?endpoint=&vmid=&timeframe=). */
export interface VmMetricsResponse {
  timeframe: MetricsTimeframe;
  vmid: number;
  points: VmMetricsPoint[];
  /** 'influx' = données réelles · 'insufficientData' = pas de série (InfluxDB indisponible, VM arrêtée ou trop récente) */
  source: 'influx' | 'insufficientData';
}

/** Usage disque d'un filesystem de VM (agent invité get-fsinfo, fs rattaché à un disque VM). */
export interface AgentFsUsage {
  /** point de montage (ex. `/`, `/NFS`) */
  mountpoint: string;
  /** nom du périphérique / partition (ex. `sda1`, `sda6`) */
  dev: string;
  usedBytes: number;
  totalBytes: number;
}

/**
 * OS réel remonté par l'agent invité (QGA guest-get-osinfo) — GET /nodes/{n}/qemu/{vmid}/agent/get-osinfo.
 * `null` si VM arrêtée, agent absent, ou PVE sans l'endpoint. C'est la source fiable du nom de OS
 * (la config `ostype`/`os` ne donne que la famille, souvent vide).
 */
export interface VmOsInfo {
  /** id de la distribution (« ubuntu », « debian », « centos », « windows », …) */
  id: string | null;
  /** nom court (« Ubuntu », « Debian GNU/Linux ») */
  name: string | null;
  /** nom versionné (« Ubuntu 24.04.5 LTS », « Debian GNU/Linux 13 (trixie) ») */
  prettyName: string | null;
  /** version (« 24.04.5 LTS (Noble Numbat) », « 13 (trixie) ») */
  version: string | null;
  /** version-id (« 24.04 », « 13 ») */
  versionId: string | null;
  /** libellé du noyau (« 6.17.0-35-generic ») */
  kernelRelease: string | null;
  /** architecture (« x86_64 ») */
  arch: string | null;
}

/** Point d'occupation d'un filesystem de VM (GET /api/vm-fs) — InfluxDB vm_fs. */
export interface VmFsPoint {
  /** unix seconds */
  time: number;
  /** espace utilisé, octets */
  usedBytes: number | null;
  /** espace alloué (taille du fs), octets */
  totalBytes: number | null;
}

/** Série d'occupation d'UN filesystem de la VM (un par point de montage / partition). */
export interface VmFsSeries {
  /** point de montage (ex. `/`, `/NFS`) */
  mountpoint: string;
  /** nom du périphérique / partition (ex. `sda1`, `sda6`) */
  dev: string;
  points: VmFsPoint[];
}

/** Occupation disque PAR PARTITION d'une VM (GET /api/vm-fs?endpoint=&vmid=&timeframe=). */
export interface VmFsResponse {
  timeframe: MetricsTimeframe;
  vmid: number;
  /** une série par filesystem (point de montage) de la VM */
  series: VmFsSeries[];
  /** 'influx' = données réelles · 'insufficientData' = pas de série (InfluxDB indisponible, VM arrêtée, agent absent) */
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
  cluster: {
    name: string;
    nodesOnline: number;
    nodesTotal: number;
    /** quorum requis (majorité) — null si inconnu. */
    quorum: number | null;
    /** état du quorum — null si inconnu (PVE 7 sans dérive possible). */
    quorumState: QuorumState | null;
    /**
     * État du Qdevice (vote externe de quorum). Source : corosync (table
     * Telegraf `quorum_detail`) en priorité — 'up'/'down'/'absent' — sinon
     * déduit de l'API PVE (l'API ne l'expose pas) → 'up'/'down'/'unknown'.
     */
    qdevice: QdeviceState;
    /**
     * Détail du quorum corosync (votes, seuil, Qdevice) — null si la table
     * Telegraf `quorum_detail` est absente (agent non déployé / pas de données).
     */
    quorumDetail: QuorumDetail | null;
  };
  sites: Site[];
  health: HealthScore;
  /**
   * Audit / best-practices (P3) — 2ᵉ score de CONFIGURATION (en complément du
   * health score qui mesure les ressources). Calculé par le poller (checks purs
   * shared/audit.ts) ; constats cliquables vers la VM/nœud/stockage concernée.
   */
  audit: AuditScore;
  kpis: KpiSummary;
  pra: PraReport;
  nodes: NodeHealth[];
  /** toutes les VMs (compactes) — pour la page nœud */
  vms: VmSummary[];
  storages: StorageInfo[];
  /** Cartographie des volumes physiques (regroupement des vues redondantes, thin/thick, ratio) */
  storageVolumes: StorageVolume[];
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

/**
 * Configuration du Health Score + des seuils PRA — externalisée dans
 * `health.json` (racine, hot-reload, pattern `overcommit.json`). `THRESHOLDS`
 * reste la source des **défauts** ; le fichier est optionnel (absent → défauts).
 */
export interface HealthThresholds {
  /** usage CPU/RAM cluster ≥ warn → pénalité warn, > crit → pénalité crit (%) */
  warn: number;
  crit: number;
  /** absorption PRA ≥ praWarn → warn, > praCrit → crit (%) */
  praWarn: number;
  praCrit: number;
  /** libellé du health score : ≥ nominal → Nominal, ≥ degraded → Dégradé, sinon Critique */
  healthNominal: number;
  healthDegraded: number;
}

/** Pénalités du Health Score (points retirés à 100). */
export interface HealthPenalties {
  nodeDown: number;
  quorumLost: number;
  qdeviceDown: number;
  cpuCrit: number;
  cpuWarn: number;
  ramCrit: number;
  ramWarn: number;
  diskCrit: number;
  diskWarn: number;
  praCrit: number;
  praWarn: number;
}

export interface HealthConfig {
  thresholds: HealthThresholds;
  penalties: HealthPenalties;
}

/** Défauts du Health Score (valeurs documentées — identiques au durci historique). */
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  thresholds: {
    warn: THRESHOLDS.warn,
    crit: THRESHOLDS.crit,
    praWarn: THRESHOLDS.praWarn,
    praCrit: THRESHOLDS.praCrit,
    healthNominal: THRESHOLDS.healthNominal,
    healthDegraded: THRESHOLDS.healthDegraded,
  },
  penalties: {
    nodeDown: 25,
    quorumLost: 25,
    qdeviceDown: 10,
    cpuCrit: 20,
    cpuWarn: 10,
    ramCrit: 20,
    ramWarn: 10,
    diskCrit: 15,
    diskWarn: 8,
    praCrit: 20,
    praWarn: 10,
  },
};
