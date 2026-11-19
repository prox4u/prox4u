import type { MetricsTimeframe } from './types.js';

/**
 * Métriques système hôte (Telegraf) + I/O disque par device — consommées par :
 *  - Vue d'ensemble : carte « Système » par nœud (load / iowait / swap),
 *    I/O disques du nœud (devices physiques), CPU par cœur ;
 *  - Monitor VM : I/O disque PAR DISQUE de la VM (device-mapper → LV PVE).
 *
 * Source : tables Telegraf `system`, `mem`, `cpu`, `diskio` (+ `dm_names` pour
 * le mapping dm-N → LV) dans la base InfluxDB `raw` — rien de tout cela n'est
 * fourni par l'API PVE (ni historique de load/swap, ni I/O par device).
 */

/** Usage courant d'UN cœur (point le plus récent). */
export interface NodeCpuCore {
  /** 'cpu0', 'cpu1', … */
  core: string;
  /** % (100 − idle − iowait : le iowait n'est pas du travail CPU). */
  usagePct: number;
  iowaitPct: number;
  userPct: number;
  systemPct: number;
}

/** Ligne de la carte « Système » (par nœud, point courant — données 10 s). */
export interface NodeSystemRow {
  node: string;
  nCpus: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSec: number;
  /** Usage CPU du nœud (cpu-total) — null si pas de mesure. */
  iowaitPct: number | null;
  userPct: number | null;
  systemPct: number | null;
  /** Swap — null / 0 si pas de swap configuré. */
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapPct: number | null;
  /** Coeurs (cpu ≠ 'cpu-total'), dernier point par cœur. */
  cores: NodeCpuCore[];
}

export interface NodeSystemResponse {
  nodes: NodeSystemRow[];
  source: 'influx' | 'empty';
}

/**
 * Empreinte matérielle d'un nœud (quasi-statique — script `exec` Telegraf,
 * table `node_hardware`) : modèle CPU (`/proc/cpuinfo` `model name`) + DMI
 * (`/sys/class/dmi/id/{product_name,sys_vendor,board_name}`). Le script tourne
 * à chaque cycle (10 s) mais les valeurs ne changent qu'au changement de
 * machine → prox4u lit le dernier point par nœud sur une fenêtre de 1 h.
 * `null` = illisible (VM sans DMI, /proc/cpuinfo sans `model name`…).
 */
export interface NodeHardwareRow {
  node: string;
  /** Modèle CPU (ex. `Intel(R) Xeon(R) Gold 6150 CPU @ 2.70GHz`). */
  cpuModel: string | null;
  /** Modèle matériel (DMI product_name, ex. `ProLiant DL380 Gen10`). */
  product: string | null;
  /** Constructeur (DMI sys_vendor, ex. `HPE`). */
  vendor: string | null;
  /** Carte mère (DMI board_name). */
  board: string | null;
}

export interface NodeHardwareResponse {
  nodes: NodeHardwareRow[];
  source: 'influx' | 'empty';
}

/** Point d'I/O d'UN device physique du nœud (bucket). */
export interface NodeDiskioRow {
  /** unix seconds (début de bucket). */
  t: number;
  device: string;
  readBps: number | null;
  writeBps: number | null;
  iops: number | null;
  /** Saturation « busy % » (delta io_time / durée, 0–100) — convention iostat. */
  busyPct: number | null;
  /** Attente moyenne de file (ms) — jauge Telegraf. */
  awaitMs: number | null;
}

export interface NodeDiskioResponse {
  timeframe: MetricsTimeframe;
  node: string;
  devices: NodeDiskioRow[];
  source: 'influx' | 'insufficientData';
}

/** Point d'I/O d'UN disque de VM. */
export interface VmDiskioPoint {
  t: number;
  readBps: number | null;
  writeBps: number | null;
  iops: number | null;
  busyPct: number | null;
  awaitMs: number | null;
}

/** Série d'UN disque de VM (LV LVM-thin visible côté hôte comme dm-N). */
export interface VmDiskioSeries {
  node: string;
  /** nom dm-N (clé diskio). */
  device: string;
  /** nom du LV device-mapper (ex. `local--vm--100--disk--0`). */
  mapperName: string;
  /** libellé lisible (ex. `vm-100-disk-0 (vg local)`). */
  label: string;
  points: VmDiskioPoint[];
}

export interface VmDiskioResponse {
  timeframe: MetricsTimeframe;
  vmid: number;
  series: VmDiskioSeries[];
  /**
   * `insufficientData` : mapping présent mais aucun disque dm pour cette VM
   * (stockage non LVM-thin — ZFS/dir — ou VM sans LV) ;
   * `noMapping` : table `dm_names` absente (agent Telegraf pas encore (re)déployé).
   */
  source: 'influx' | 'insufficientData' | 'noMapping';
}

/** Parsing d'un nom de LV device-mapper PVE : `vg--vm--101--disk--0`. */
export interface PveMapperParse {
  /** nom du VG (peut contenir `--` — storage avec tirets). */
  storage: string;
  /** nom du LV avec tirets simples (`vm-101-disk-0`). */
  lv: string;
  kind: 'vm' | 'ct' | 'other';
  /** vmid (QEMU) ou ctid (LXC). */
  id: number | null;
}

/**
 * Décode un nom de LV device-mapper (convention PVE : le VG et le LV sont
 * séparés par `--`, et chaque `-` du nom est encodé `--`).
 * QEMU : `vm-<vmid>-disk-<n>` · LXC (LVM-thin) : `base-<ctid>-disk-<n>`.
 * Le VG peut contenir des tirets (`my--storage--vm--101--disk--0`) — la
 * correspondance part du suffixe LV, jamais d'une découpe au premier `--`.
 */
export function parsePveMapperName(name: string): PveMapperParse {
  const vm = name.match(/^(.*)--vm--(\d+)--disk--(\d+)$/);
  if (vm) return { storage: vm[1], lv: `vm-${vm[2]}-disk-${vm[3]}`, kind: 'vm', id: Number(vm[2]) };
  const ct = name.match(/^(.*)--base--(\d+)--disk--(\d+)$/);
  if (ct) return { storage: ct[1], lv: `base-${ct[2]}-disk-${ct[3]}`, kind: 'ct', id: Number(ct[2]) };
  return { storage: '', lv: name.replace(/--/g, '-'), kind: 'other', id: null };
}

/** Libellé UI d'un LV : `vm-101-disk-0 (vg local)`. */
export function mapperLabel(name: string): string {
  const p = parsePveMapperName(name);
  return p.kind === 'other' ? p.lv : `${p.lv} (vg ${p.storage})`;
}

/** Point de débit réseau d'UNE interface (t = seconds depuis epoch, in/out en octets/s). */
export interface NodeNetRow {
  t: number;
  /** interface hôte (vmbr0, enp1s0f0…) — vnet* / tap* / veth* / lo exclus côté requête. */
  iface: string;
  inBps: number | null;
  outBps: number | null;
}

/**
 * Interface d'un nœud vue par l'UI PVE (`GET /nodes/{n}/network`) — la
 * liste servie par `/api/node-net` (1 carte graphique par interface).
 */
/** Décomposition du nom d'une interface interne au pare-feu PVE (ex. `fwbr102i0` = pont du pare-feu de la machine 102, interface 0). */
export interface NodeNetFwInfo {
  /** ID de la machine (VM/LXC) concernée. */
  vmid: number;
  /** index de l'interface réseau de la machine (net{ifIndex}). */
  ifIndex: number;
  /** maillon de la chaîne pare-feu : pont (fwbr) / extrémité interne veth (fwln) / extrémité externe veth (fwpr). */
  role: 'bridge' | 'line' | 'port';
}

export interface NodeNetIface {
  /** nom PVE (fichier /etc/network/interfaces — ex. `nic0`, `nfs`, `vmbr0`) — titre de la carte graphique. */
  name: string;
  /** noms candidats du device noyau rapporté par Telegraf : le nom PVE (sur un nœud PVE, le device noyau est renommé selon /etc/network/interfaces — c'est le cas courant) + `altnames` (noms alternatifs du noyau, ex. le nom dérivé du MAC `enx9c6b00dd220c`) — les mesures se joignent sur n'importe lequel. Vide = aucun nom connu. */
  kernels: string[];
  /** `firewall` = interface interne au pare-feu PVE (fwbr, fwln, fwpr — pas dans la config, vue seulement dans les mesures), détail dans `firewall`. */
  kind: 'bridge' | 'nic' | 'other' | 'firewall';
  /** renseignée si `kind === 'firewall'` (nom `fw(br|ln|pr)<vmid>(i|p)<n>`). */
  firewall?: NodeNetFwInfo;
  /** UP/DOWN côté PVE — null si inconnu (PVE ne renvoie `active` que pour les interfaces UP, ou interface trouvée seulement dans les mesures). */
  active: boolean | null;
}

/**
 * Trafic réseau PAR INTERFACE d'un nœud hôte (Telegraf `net`, counters
 * bytes_recv/bytes_sent → débits par delta). `interfaces` = liste des
 * interfaces du nœud (source API PVE, ordre d'affichage ; les devices noyau
 * vus seulement dans les mesures sont ajoutés — `kind:'other'`, ou
 * `kind:'firewall'` + `firewall` si le nom matche la nomenclature du
 * pare-feu PVE (fwbr, fwln, fwpr) — rien n'est perdu) ; `rows` = mesures,
 * jointes à `interfaces[].kernels` côté UI.
 * `insufficientData` : aucune mesure sur la fenêtre (agent pas encore
 * (re)déployé ou interfaces inactives) — `interfaces` reste renseigné.
 */
export interface NodeNetResponse {
  timeframe: MetricsTimeframe;
  node: string;
  interfaces: NodeNetIface[];
  rows: NodeNetRow[];
  source: 'influx' | 'insufficientData';
}

/** Point de débit d'UNE carte réseau de VM (in/out en octets/s). */
export interface VmNetPoint {
  t: number;
  inBps: number | null;
  outBps: number | null;
}

/**
 * Série réseau d'UNE interface de VM (net0/net1…) — le trafic est mesuré
 * côté hôte sur le device tap correspondant (Telegraf `net`), joint à la
 * config PVE par MAC (l'API PVE n'expose pas le trafic par interface).
 * `hostIface` = nom du tap hôte trouvé par MAC ; `null` si non trouvé
 * (VM arrêtée → pas de tap ; SDN/OVS → MAC hôte différente) : les points
 * restent vides, jamais de valeur inventée.
 */
export interface VmNetSeries {
  /** net0 / net1… (config PVE) */
  iface: string;
  bridge: string;
  mac: string | null;
  /** tap hôte associé par MAC (vnet* / tap* / veth*) — null si introuvable. */
  hostIface: string | null;
  /** libellé UI : `net0 (vmbr0)`. */
  label: string;
  points: VmNetPoint[];
}

/**
 * Trafic réseau PAR INTERFACE d'une VM (agent hôte + mapping MAC).
 * `noMapping` : tables `net` / `net_if_mac` absentes (agent pas encore
 * (re)déployé) ; `insufficientData` : mapping présent mais aucune interface
 * de la VM résolue (VM sans config réseau lue, ou VM arrêtée).
 */
export interface VmNetResponse {
  timeframe: MetricsTimeframe;
  vmid: number;
  series: VmNetSeries[];
  source: 'influx' | 'insufficientData' | 'noMapping';
}

/**
 * Disques physiques pour la vue « I/O du nœud » : disques ENTIER seulement
 * (nvme0n1, sda, …). Exclut :
 *  - device-mapper (dm-N) : ce sont les LV — l'I/O y serait double-comptée
 *    (même I/O que sur le disque physique sous-jacent) ;
 *  - partitions (sda1, nvme0n1p1…) : sous-ensemble du disque entier ;
 *  - loop / md (RAID) / sr (CD) / ram (disques mémoire).
 */
export function isPhysicalDevice(name: string): boolean {
  if (/^dm-\d+$/.test(name)) return false;
  if (/^(loop|md|sr|ram|zram|fd)\d+/.test(name)) return false;
  if (/^(sd|vd|hd|xvd)[a-z]+[0-9]+$/.test(name)) return false; // partition sda1
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false; // partition nvme0n1p1
  return /^nvme\d+n\d+$/.test(name) || /^(sd|vd|hd|xvd)[a-z]+$/.test(name) || /^(cciss\d+|dasd[a-z]+|osm\d+|memstick[a-z]+\d*)$/.test(name);
}

// ---------------------------------------------------------------------------
// Historiques de jauges hôte (Monitor nœud v4 — bibliothèque complétée,
// référence ProxMenux) : températures capteurs, températures disques SMART,
// ZFS ARC, charge moyenne + swap. Source : tables Telegraf `sensors`,
// `smart_device`, `zfs`, `system`, `mem` dans la base `raw` (rétention 31 j).
// ---------------------------------------------------------------------------

/** Point de température d'UN chip (bucket — max de la fenêtre, jauge). */
export interface NodeTempPoint {
  /** unix seconds (début de bucket). */
  t: number;
  temp: number;
}

/**
 * Série de températures d'UN chip (lm-sensors : coretemp, k10temp, amdgpu,
 * nvme…) — la plus haute température du chip par bucket (le chip regroupe
 * plusieurs features — capteurs par cœur, Tdie/Tctl…).
 */
export interface NodeTempSeries {
  chip: string;
  points: NodeTempPoint[];
}

export interface NodeTempsResponse {
  timeframe: MetricsTimeframe;
  node: string;
  /** une série par chip avec au moins une lecture — triée par nom. */
  series: NodeTempSeries[];
  source: 'influx' | 'insufficientData';
}

/** Point de température d'UN disque SMART (bucket — max de la fenêtre). */
export interface SmartTempPoint {
  t: number;
  temp: number;
}

/**
 * Série de température d'UN disque (table `smart_device.temp_c`) — les disques
 * à `temp_c = 0` (pas de capteur, cf. smartTempDisplay) sont exclus côté requête
 * — sinon un disque sans sonde tracerait une ligne plate à 0 °C.
 */
export interface SmartTempSeries {
  device: string;
  /** modèle (dernier point connu, 1 h) — null si illisible. */
  model: string | null;
  points: SmartTempPoint[];
}

export interface SmartTempsResponse {
  timeframe: MetricsTimeframe;
  node: string;
  series: SmartTempSeries[];
  source: 'influx' | 'insufficientData';
}

/**
 * Point ZFS ARC (bucket) — équivalent prox4u de la ligne « memoryZfsArc » du
 * graphique mémoire ProxMenux.
 */
export interface ZfsArcPoint {
  t: number;
  /** Taille ARC courante (octets) — `arcstats_c` (max du bucket). */
  sizeBytes: number | null;
  /** Taille max ARC (octets) — `arcstats_c_max` (constant) : ligne de référence. */
  maxBytes: number | null;
  /** Hit rate % du bucket (Δhits / (Δhits+Δmisses)) — null si compteurs à 0 / reset / illisibles (la série est alors masquée, pattern ProxMenux). */
  hitRatePct: number | null;
}

export interface ZfsArcResponse {
  timeframe: MetricsTimeframe;
  node: string;
  points: ZfsArcPoint[];
  source: 'influx' | 'insufficientData';
}

/**
 * Point d'historique charge + swap d'UN nœud (bucket) — les deux champs sont
 * indépendants (table `system` absente → load null, table `mem` absente →
 * swap null) : une table manquante ne fait pas perdre l'autre.
 */
export interface NodeHostHistoryPoint {
  t: number;
  /** max du bucket (pic de la fenêtre) — jamais la moyenne : la charge est un signal d'alerte. */
  load1: number | null;
  load5: number | null;
  load15: number | null;
  /** nombre de cœurs (pour la lecture load/cœur) — null si pas de mesure. */
  nCpus: number | null;
  /** Swap utilisé (octets) : pic du bucket = max(total) − min(free) — null si pas de swap ou pas de mesure. */
  swapUsedBytes: number | null;
  /** Swap total (octets) — 0 = pas de swap configuré. */
  swapTotalBytes: number | null;
}

export interface NodeHostHistoryResponse {
  timeframe: MetricsTimeframe;
  node: string;
  points: NodeHostHistoryPoint[];
  source: 'influx' | 'insufficientData';
}

/**
 * Hit rate ZFS ARC % depuis les deltas de compteurs DANS un bucket
 * (`arcstats_hits` / `arcstats_misses` sont des counters monotones — le delta
 * sur la fenêtre = max − min). Delta négatif (reset au reboot) ou total nul
 * (compteurs à 0 — ex. node sans pool ZFS actif) → **null, jamais de valeur
 * inventée** (le front masque alors la série hit rate).
 */
export function zfsHitRatePct(dHits: number | null, dMisses: number | null): number | null {
  if (dHits == null || dMisses == null) return null;
  if (dHits < 0 || dMisses < 0) return null;
  const total = dHits + dMisses;
  if (total <= 0) return null;
  return (dHits / total) * 100;
}

/** % de swap utilisé — null si pas de mesure ou pas de swap (total = 0). */
export function swapPct(usedBytes: number | null, totalBytes: number | null): number | null {
  if (usedBytes == null || totalBytes == null || totalBytes <= 0) return null;
  return (usedBytes / totalBytes) * 100;
}
