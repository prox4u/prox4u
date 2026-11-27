/**
 * Calculateur de dimensionnement InfluxDB 3 Core (P3, GitHub #19).
 *
 * À partir du parc (VMs / nœuds / datastores / endpoints) + le tick du poller,
 * recommande la configuration InfluxDB 3 Core adaptée (file d'écriture, flush,
 * rétention, query-file-limit) + la justification. Fonction pure (aucune I/O) —
 * testable, réutilisable par la CLI et le panneau /influxdb.
 *
 * Modèle d'écriture (par tick, d'après poller.ts) :
 *  - 1 ligne globale (influxdb_self)
 *  - 1 ligne/endpoint (storage_metrics)
 *  - 2 lignes/nœud (node_metrics + node_net)
 *  - ~3 lignes/VM (vm_metrics + ~2 vm_fs, un point de montage par fs)
 *  - 1 ligne/datastore (datastore_metrics)
 *
 * La croissance des fichiers (1 fichier/table/bloc de 10 min, `gen1-duration`)
 * est INDÉPENDANTE du nb de séries → la config requête (query-file-limit,
 * chunk) ne dépend pas de la taille du parc, seulement de la fenêtre de requête.
 */

/** Lignes écrites par tick, par unité de parc (modèle poller.ts). */
export const SIZING_CONSTANTS = {
  /** 1 ligne globale par tick (influxdb_self). */
  baseGlobal: 1,
  /** 1 ligne/endpoint par tick (storage_metrics). */
  perEndpoint: 1,
  /** 2 lignes/nœud par tick (node_metrics + node_net). */
  perNode: 2,
  /** ~3 lignes/VM par tick (vm_metrics + ~2 vm_fs). */
  perVm: 3,
  /** 1 ligne/datastore par tick (datastore_metrics). */
  perDatastore: 1,
  /** Fichiers Parquet / table / jour (1 fichier / bloc de 10 min = 144). */
  filesPerDayPerTable: 144,
  /** query-file-limit recommandé (couvre ~69 j sans chunking). */
  queryFileLimit: 10_000,
  /** Taille de chunk recommandée (j) — reste sous la file limit. */
  chunkDays: 30,
  /** Rétention recommandée. */
  rawRetention: '31d',
  consolidatedRetention: 'infinie',
  /** flushDelayMs (coalescence) — inchangé. */
  flushDelayMs: 25,
} as const;

export interface InfluxSizingInput {
  /** Nombre de VMs (QEMU + LXC) sur l'ensemble des endpoints. */
  vms: number;
  /** Nombre de nœuds Proxmox (ensemble des endpoints). */
  nodes: number;
  /** Tick du poller (secondes). Défaut 60. */
  tickSeconds?: number;
  /** Nombre de datastores (optionnel, défaut 0). */
  datastores?: number;
  /** Nombre d'endpoints/clusters (optionnel, défaut 1). */
  endpoints?: number;
  /**
   * Config actuelle (optionnelle) — pour détecter les valeurs sous-dimensionnées
   * par rapport à la recommandation (warnings).
   */
  current?: {
    queueMax?: number;
    flushMaxLines?: number;
    queryFileLimit?: number;
  };
}

export interface InfluxSizingResult {
  /** Taux d'écriture estimé. */
  linesPerTick: number;
  linesPerMinute: number;
  linesPerDay: number;
  /** Config d'écriture recommandée. */
  queueMax: number;
  flushMaxLines: number;
  flushDelayMs: number;
  /** Config requête recommandée (indépendante du parc). */
  queryFileLimit: number;
  /** Fenêtre de requête max (jours) qui tient dans queryFileLimit sans chunking. */
  maxQueryWindowDays: number;
  /** Taille de chunk recommandée (jours) pour les fenêtres plus longues. */
  chunkDays: number;
  /** Rétention recommandée. */
  rawRetention: string;
  consolidatedRetention: string;
  /** Headroom fichiers estimé (chunk de 30 j vs limit). */
  chunkFiles: number;
  fileHeadroom: 'ok' | 'warn' | 'crit';
  /** Justification (1 ligne par recommandation). */
  justification: string[];
  /** Avertissements si la config actuelle est sous-dimensionnée. */
  warnings: string[];
}

const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

/**
 * Calcule la config InfluxDB 3 Core recommandée à partir du parc + le tick.
 * Fonction pure — aucune I/O.
 */
export function computeInfluxSizing(input: InfluxSizingInput): InfluxSizingResult {
  const C = SIZING_CONSTANTS;
  const vms = Math.max(0, Math.floor(input.vms));
  const nodes = Math.max(0, Math.floor(input.nodes));
  const datastores = Math.max(0, Math.floor(input.datastores ?? 0));
  const endpoints = Math.max(1, Math.floor(input.endpoints ?? 1));
  const tickSeconds = Math.max(1, Math.floor(input.tickSeconds ?? 60));

  // Taux d'écriture (lignes/tick) — modèle poller.ts.
  const linesPerTick =
    C.baseGlobal +
    endpoints * C.perEndpoint +
    nodes * C.perNode +
    vms * C.perVm +
    datastores * C.perDatastore;
  const linesPerMinute = Math.round(linesPerTick * (60 / tickSeconds));
  const linesPerDay = Math.round(linesPerTick * (86_400 / tickSeconds));

  // Config d'écriture :
  //  - flushMaxLines : batcher l'intégralité d'un tick en UN flush (+50 % de
  //    marge), arrondi à 100 — évite les multi-flush par tick.
  //  - queueMax : absorber les pics (flush lent / réseau) — 10 ticks de headroom,
  //    arrondi à 1 000, plancher 20 000 (défaut actuel).
  const flushMaxLines = Math.max(1_000, roundUp(linesPerTick * 1.5, 100));
  const queueMax = Math.max(20_000, roundUp(linesPerTick * 10, 1_000));

  // Config requête (indépendante du parc — croissance fichiers = 144/j/table) :
  //  - queryFileLimit : 10 000 (couvre ~69 j sans chunking).
  //  - chunkDays : 30 (4 320 fichiers < 10 000).
  const queryFileLimit = C.queryFileLimit;
  const maxQueryWindowDays = Math.floor(queryFileLimit / C.filesPerDayPerTable);
  const chunkDays = C.chunkDays;
  const chunkFiles = chunkDays * C.filesPerDayPerTable;
  const ratio = chunkFiles / queryFileLimit;
  const fileHeadroom: 'ok' | 'warn' | 'crit' = ratio > 1 ? 'crit' : ratio > 0.8 ? 'warn' : 'ok';

  // Justification.
  const justification: string[] = [
    `Écriture estimée : ${linesPerTick} lignes/tick (${linesPerMinute}/min, ${linesPerDay}/j) — ` +
      `modèle : 1 globale + ${endpoints} endpoint + ${nodes} nœud×2 + ${vms} VM×3 + ${datastores} datastore.`,
    `flushMaxLines ${flushMaxLines} : batche l'intégralité d'un tick en un seul flush (+50 % de marge) — ` +
      `évite les lots multiples par tick.`,
    `queueMax ${queueMax} : absorbe les pics d'écriture (flush lent, réseau) — 10 ticks de headroom, ` +
      `plancher 20 000 (défaut).`,
    `query-file-limit ${queryFileLimit} : indépendant du parc (1 fichier/table/10 min) — couvre ` +
      `~${maxQueryWindowDays} j sans chunking ; au-delà, chunker par ${chunkDays} j (${chunkFiles} fichiers/chunk).`,
    `Rétention : raw ${C.rawRetention} (auto-purge), consolidated ${C.consolidatedRetention} ` +
      `(surveiller fileEstimate — P4).`,
  ];

  // Avertissements si la config actuelle est sous-dimensionnée.
  const warnings: string[] = [];
  const cur = input.current;
  if (cur) {
    if (cur.flushMaxLines != null && cur.flushMaxLines < flushMaxLines) {
      warnings.push(
        `flushMaxLines actuel (${cur.flushMaxLines}) < recommandé (${flushMaxLines}) — ` +
          `un tick déborde sur plusieurs flush (latence d'écriture).`,
      );
    }
    if (cur.queueMax != null && cur.queueMax < queueMax) {
      warnings.push(
        `queueMax actuel (${cur.queueMax}) < recommandé (${queueMax}) — risque d'abandon de lignes ` +
          `en pic d'écriture (backpressure).`,
      );
    }
    if (cur.queryFileLimit != null && cur.queryFileLimit < queryFileLimit) {
      warnings.push(
        `query-file-limit actuel (${cur.queryFileLimit}) < recommandé (${queryFileLimit}) — ` +
          `les fenêtres > ${Math.floor(cur.queryFileLimit / C.filesPerDayPerTable)} j échouent sans chunking.`,
      );
    }
  }

  return {
    linesPerTick,
    linesPerMinute,
    linesPerDay,
    queueMax,
    flushMaxLines,
    flushDelayMs: C.flushDelayMs,
    queryFileLimit,
    maxQueryWindowDays,
    chunkDays,
    rawRetention: C.rawRetention,
    consolidatedRetention: C.consolidatedRetention,
    chunkFiles,
    fileHeadroom,
    justification,
    warnings,
  };
}
