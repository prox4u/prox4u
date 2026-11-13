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
