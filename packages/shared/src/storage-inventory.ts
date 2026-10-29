/**
 * Inventaire stockage → VMs (hypervision, page /storage — vue type vCenter).
 *
 * Un « datastore » = un stockage Proxmox (local, local-lvm, zfs, rbd/Ceph, nfs,
 * dir, pbs…). Ce module décline les datastores d'un endpoint en lignes
 * d'inventaire : capacité (utilisé/total/%) et code couleur, type, nœuds,
 * contenus, et les VMs dont le disque repose sur ce datastore. Fonctions pures
 * testées — aucun I/O, aucune dépendance backend (les données viennent déjà de
 * GET /api/storage-inventory : storages + VMs avec leur champ `storage`).
 */

import { buildForecast } from './capacity.js';
import { usageSeverity } from './overcommit.js';
import type { CapacityForecast, OvercommitConfig, PveStorage, PveStorageType, SeverityOrNa } from './types.js';

/**
 * Un disque de VM sur un datastore — vue plate pour l'inventaire. Une VM à
 * plusieurs disques (sur des datastores différents) produit une référence par
 * datastore : `diskBytes` est la taille allouée (config `size=`) du/des disques
 * de la VM sur CE datastore.
 */
export interface StorageVmRef {
  vmid: number;
  name: string;
  node: string;
  status: 'running' | 'stopped' | 'paused' | 'unknown';
  /** taille allouée du disque de la VM sur ce datastore (config `size=`), en octets. */
  diskBytes: number;
  /** nom du datastore qui héberge le disque de la VM. */
  storage: string;
}

/** shared = accessible depuis plusieurs nœuds (Ceph/NFS) · local = un seul nœud. */
export type StorageKind = 'shared' | 'local';

/** Une ligne d'inventaire : un datastore et les VMs qui y sont stockées. */
export interface StorageRow {
  /** Clé stable = nom du datastore. */
  key: string;
  storage: string;
  type: PveStorageType;
  kind: StorageKind;
  /** Nœuds qui exposent ce datastore (vide = inconnu). */
  nodes: string[];
  /** Contenus autorisés (images, iso, backup, container…). */
  content: string[];
  /** octets utilisés / totaux (0 si inconnu). */
  used: number;
  total: number;
  /** % d'usage (0 si pas de capacité). */
  pct: number;
  /** true si une capacité fiable (total > 0) est disponible. */
  hasCapacity: boolean;
  /** VMs dont le disque est sur ce datastore. */
  vms: StorageVmRef[];
  /** VMs distinctes en marche / arrêtées sur ce datastore. */
  running: number;
  stopped: number;
  /** Σ des disques alloués des VMs du datastore. */
  diskAllocated: number;
}

/** Ligne enrichie d'un endpoint — vue agrégée multi-endpoints. */
export interface StorageRowAll extends StorageRow {
  endpointId: string;
  endpointName: string;
}

/** Données brutes d'un endpoint renvoyées par /api/storage-inventory. */
export interface StorageInventoryEndpoint {
  endpointId: string;
  storages: PveStorage[];
  vms: StorageVmRef[];
}

/** Réponse de GET /api/storage-inventory. */
export interface StorageInventoryResponse {
  endpoints: StorageInventoryEndpoint[];
}

/**
 * Sévérité de la barre de capacité d'un datastore selon la politique
 * `usage` (warn/crit) d'overcommit.json — « na » si pas de capacité connue.
 * Réutilise `usageSeverity` (source unique du code couleur d'usage).
 */
export function storageSeverity(row: { pct: number; hasCapacity: boolean }, config: OvercommitConfig): SeverityOrNa {
  if (!row.hasCapacity) return 'na';
  return usageSeverity(row.pct, config);
}

/**
 * Décline les datastores + VMs d'un endpoint en lignes d'inventaire.
 * Une VM apparaît sur le datastore nommé par son champ `storage` ; une VM sans
 * datastore connu n'apparaît nulle part. Trié par nom de datastore, puis les
 * VMs de chaque ligne sont triées par nom.
 */
export function buildStorageInventory(storages: PveStorage[], vms: StorageVmRef[]): StorageRow[] {
  const rows: StorageRow[] = storages.map((s) => {
    const used = s.used ?? 0;
    const total = s.total ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 1000) / 10) : 0;
    return {
      key: s.storage,
      storage: s.storage,
      type: s.type,
      kind: s.shared ? 'shared' : 'local',
      nodes: s.nodes ?? [],
      content: s.content ?? [],
      used,
      total,
      pct,
      hasCapacity: total > 0,
      vms: [],
      running: 0,
      stopped: 0,
      diskAllocated: 0,
    };
  });

  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const v of vms) {
    const row = byKey.get(v.storage);
    if (!row) continue; // VM sur un datastore non listé
    row.vms.push(v);
    if (v.status === 'running') row.running += 1;
    else row.stopped += 1;
    row.diskAllocated += v.diskBytes;
  }
  for (const r of rows) r.vms.sort((a, b) => a.name.localeCompare(b.name) || a.vmid - b.vmid);
  rows.sort((a, b) => a.storage.localeCompare(b.storage));
  return rows;
}

/** Inventaire agrégé de tous les endpoints (vue multi-endpoints) + nom du serveur. */
export function buildStorageInventoryAll(
  endpoints: StorageInventoryEndpoint[],
  endpointNames: Record<string, string>,
): StorageRowAll[] {
  const rows: StorageRowAll[] = [];
  for (const ep of endpoints) {
    const name = endpointNames[ep.endpointId] ?? ep.endpointId;
    for (const row of buildStorageInventory(ep.storages, ep.vms)) {
      // clé composite : un datastore homonyme peut exister sur plusieurs endpoints
      // (ex. « local » sur proxmox ET clusterproxmox) — une clé React simple par
      // nom de datastore créerait des collisions et casserait le rendu/filtrage.
      rows.push({ ...row, key: `${ep.endpointId}/${row.key}`, endpointId: ep.endpointId, endpointName: name });
    }
  }
  return rows;
}

/** Colonnes triables de l'inventaire (en-têtes cliquables). */
export type StorageSortKey = 'datastore' | 'server' | 'type' | 'capacity' | 'volumes' | 'vms' | 'state';

/** Sens de tri — asc = croissant, desc = décroissant. */
export type StorageSortDir = 'asc' | 'desc';

/** Tri actif de l'inventaire. */
export interface StorageSort {
  key: StorageSortKey;
  dir: StorageSortDir;
}

/** Rang de sévérité pour le tri par état (crit = le plus « lourd »). */
const SEVERITY_RANK: Record<SeverityOrNa, number> = { na: 0, ok: 1, warn: 2, crit: 3 };

/**
 * Trie les lignes d'inventaire (pur, testé). `config` sert au tri par état
 * (sévérité via `storageSeverity`). Renvoie un nouveau tableau ; les égalités
 * sont départagées par le nom de datastore (rendu prévisible à grande échelle).
 */
export function sortStorageRows<T extends StorageRow>(rows: T[], config: OvercommitConfig, sort: StorageSort): T[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const cmp = (a: T, b: T): number => {
    switch (sort.key) {
      case 'datastore':
        return a.storage.localeCompare(b.storage);
      case 'server': {
        const an = (a as StorageRow & { endpointName?: string }).endpointName ?? '';
        const bn = (b as StorageRow & { endpointName?: string }).endpointName ?? '';
        return an.localeCompare(bn);
      }
      case 'type':
        return a.type.localeCompare(b.type);
      case 'capacity':
        return a.pct - b.pct;
      case 'volumes':
        return a.diskAllocated - b.diskAllocated;
      case 'vms':
        return a.running + a.stopped - (b.running + b.stopped);
      case 'state':
        return SEVERITY_RANK[storageSeverity(a, config)] - SEVERITY_RANK[storageSeverity(b, config)];
    }
  };
  return [...rows].sort((a, b) => {
    const c = cmp(a, b);
    return c !== 0 ? c * dir : a.storage.localeCompare(b.storage);
  });
}

/** Filtre optionnel d'inventaire stockage. */
export interface StorageInventoryFilter {
  /** Sélection exacte d'un type — le déroulé de la page. */
  type?: PveStorageType;
}

/**
 * Recherche libre + filtrage des lignes d'inventaire stockage.
 * La recherche (insensible à la casse) porte sur : nom, type, nœud, contenus,
 * nom de VM, vmid, nœud de la VM. `filter.type` resserre ensuite sur un type exact.
 */
export function filterStorageRows<T extends StorageRow>(rows: T[], query: string, filter?: StorageInventoryFilter): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter?.type && row.type !== filter.type) return false;
    if (!q) return true;
    const haystack = [
      row.storage,
      row.type,
      ...row.nodes,
      ...row.content,
      ...row.vms.flatMap((v) => [v.name, String(v.vmid), v.node]),
    ]
      .join('\u0000')
      .toLowerCase();
    return haystack.includes(q);
  });
}

// --- Capacity planning par datastore -------------------------------------------------

/** Point brut d'occupation d'un datastore (un tick du poller). */
export interface DatastorePoint {
  /** unix seconds. */
  time: number;
  /** octets utilisés. */
  used: number;
  /** octets totaux (0 = capacité inconnue, point ignoré). */
  total: number;
}

const DAY_SEC = 86_400;

/**
 * Capacity planning d'un datastore : construit la série journalière
 * (moyenne des % utilisés/total, minuit UTC) puis applique la prévision disque
 * standard (`buildForecast`). Fonctions pures testées — aucun I/O.
 *
 * - moins de 7 jours d'historique valide → `insufficientData` (pas de projection).
 * - pente ≤ 0 → `daysTo80`/`daysTo90` = null (datastore stable ou en décrue).
 */
export function buildDatastoreForecast(points: DatastorePoint[]): CapacityForecast {
  const byDay = new Map<number, { sum: number; n: number }>();
  for (const p of points) {
    if (!p.total || p.total <= 0) continue; // capacité inconnue → pas de % fiable
    const day = p.time - (p.time % DAY_SEC);
    const pct = (p.used / p.total) * 100;
    const e = byDay.get(day) ?? { sum: 0, n: 0 };
    e.sum += pct;
    e.n += 1;
    byDay.set(day, e);
  }
  const daily = [...byDay.entries()]
    .map(([time, { sum, n }]) => ({ time, value: Math.round((sum / n) * 10) / 10 }))
    .sort((a, b) => a.time - b.time);
  return buildForecast('disk', daily);
}

/** Un datastore avec son historique d'occupation et sa prévision de saturation. */
export interface DatastoreHistoryEntry {
  storage: string;
  /** capacité totale actuelle du datastore (octets). */
  totalBytes: number;
  /** série temporelle d'occupation (utilisé/total), triée par temps. */
  points: DatastorePoint[];
  forecast: CapacityForecast;
}

/** Portée d'historique demandée : 1 an (RRD hebdo) ou 31 j (RRD journalier). */
export type DatastoreRange = 'year' | 'month';

/** Réponse de GET /api/storage-datastore-history. */
export interface DatastoreHistoryResponse {
  endpointId: string;
  range: DatastoreRange;
  datastores: DatastoreHistoryEntry[];
}
