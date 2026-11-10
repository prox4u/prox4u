/**
 * Cartographie stockage — hiérarchie iSCSI → LVM (« analyse intelligente »).
 *
 * Un LUN iSCSI est le volume physique de référence ; les VG LVM qui reposent dessus en sont les
 * **enfants** (un LUN peut porter plusieurs VG — vrai matériel). La capacité du LUN est comptée
 * UNE seule fois (jamais la somme LUN + VG). Chaque volume est classé en thin (sur-allocation
 * possible) ou thick (usage). Produit, par volume : capacité, utilisé, disques VM alloués, ratio
 * + tonalité ; et un ratio global de surallocation disk (thin-only, n/a si aucun disque sur un
 * thin).
 *
 * Sémantique d'« utilisé » d'un LUN : la somme des tailles des VG enfants (espace **engagé**),
 * pas les données des VG. Ex. LUN 600 Go / VG 100 Go → 100 Go engagés, 500 Go libres.
 *
 * Fonctions pures testées — aucun I/O. Les données viennent du poller (storages +
 * allocation par datastore agrégée depuis `VmSummary.disks[]`) ; `lunSizes` (config
 * storage-volumes.json) donne la taille d'autorité d'un LUN quand elle est connue.
 */

import { isThinStorage, overcommitTone, usageSeverity } from './overcommit.js';
import type { OvercommitConfig, PveStorage, SeverityOrNa, StorageDiskAlloc, StorageVolume } from './types.js';

/** Taille d'autorité d'un LUN iSCSI par nom de datastore (config storage-volumes.json). */
export type LunSizes = Record<string, number>;

export interface StorageVolumesResult {
  /** Volumes physiques (LUN iSCSI en parent avec ses VG enfants, volumes autonomes sans enfant). */
  volumes: StorageVolume[];
  /**
   * Ratio global de surallocation disk : Σ alloué sur volumes thin / Σ capacité des volumes thin
   * (uniquement si un volume thin héberge des disques), sinon null (n/a). Sur un parc où les
   * disques sont sur du thick (lvm/dir/iscsi), c'est null — pas un 916 %.
   */
  diskOvercommit: number | null;
}

/**
 * Construit la cartographie des volumes physiques (arbre iSCSI → LVM) depuis les datastores,
 * l'allocation de disques VM par datastore, et les tailles de LUN connues.
 *
 * - **Hiérarchie** : un datastore iSCSI qui liste des VG dans `duplicateOf` est un **parent**
 *   (le LUN) ; ces VG sont ses **enfants** (plusieurs possibles). Un datastore qui est enfant
 *   d'un LUN n'apparaît pas en top-level. Un datastore sans parent ni enfant est autonome.
 * - **Capacité du LUN** : `lunSizes[nom]` si connue (valeur d'autorité, `totalSource='lun'`),
 *   sinon la somme des tailles des VG enfants (`totalSource='vg-sum'`, **borne basse** — le LUN
 *   peut être plus grand). Jamais la somme LUN + VG.
 * - **Utilisé du LUN** : somme des tailles des VG enfants (espace engagé), pas les données.
 * - **Classification** : thin (lvmthin/zfs/rbd) → sur-allocation (peut >1) ; thick (dir/lvm/
 *   nfs/iscsi/cifs) → usage (≤1, tonalité politique d'usage).
 * - **Ratio** : LUN = engagé/capacité · VG = alloué/taille VG. Volume sans disque → `kind=na`.
 */
export function buildStorageVolumes(
  storages: PveStorage[],
  alloc: StorageDiskAlloc[],
  config: OvercommitConfig,
  lunSizes?: LunSizes,
): StorageVolumesResult {
  // Allocation par datastore (absente = 0).
  const allocByStorage = new Map<string, number>();
  for (const a of alloc) allocByStorage.set(a.storage, (allocByStorage.get(a.storage) ?? 0) + a.allocatedBytes);

  const byName = new Map<string, PveStorage>();
  for (const s of storages) byName.set(s.storage, s);

  // Parent → enfants : le LUN iSCSI liste ses VG dans `duplicateOf`. Inversion VG → LUN.
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const s of storages) {
    const vgs = (s.duplicateOf ?? []).filter((vg) => byName.has(vg));
    if (vgs.length === 0) continue;
    childrenOf.set(s.storage, vgs);
    for (const vg of vgs) parentOf.set(vg, s.storage);
  }

  // Métriques de base d'un nœud datastore (volume autonome ou VG enfant) : ses propres
  // capacité/usage/alloués, classés thin/thick.
  const nodeOf = (s: PveStorage): StorageVolume => {
    const allocated = allocByStorage.get(s.storage) ?? 0;
    const thinCapable = isThinStorage(s.type);
    const hasDisks = allocated > 0;
    const ratio = s.total && s.total > 0 ? allocated / s.total : null;
    const kind: StorageVolume['kind'] = !hasDisks ? 'na' : thinCapable ? 'overcommit' : 'usage';
    const tone: SeverityOrNa =
      kind === 'na' || ratio === null ? 'na' : thinCapable ? overcommitTone(ratio, config.disk) : usageSeverity(ratio * 100, config);
    return {
      storage: s.storage,
      type: s.type,
      children: [],
      totalBytes: s.total,
      usedBytes: s.used,
      allocatedBytes: allocated,
      thinCapable,
      hasDisks,
      ratio,
      kind,
      tone,
    };
  };

  const volumes: StorageVolume[] = [];
  for (const s of storages) {
    if (parentOf.has(s.storage)) continue; // VG enfant → rattaché à son LUN ci-dessous
    const children = (childrenOf.get(s.storage) ?? []).map((vgName) => nodeOf(byName.get(vgName)!));
    if (children.length === 0) {
      volumes.push(nodeOf(s)); // volume autonome (pas de VG enfant)
      continue;
    }
    // LUN iSCSI parent : capacité = taille du LUN si connue, sinon Σ tailles VG (borne basse).
    const committed = children.reduce((sum, c) => sum + (c.totalBytes ?? 0), 0); // espace engagé
    const lunSize = lunSizes?.[s.storage];
    const total = lunSize ?? (committed > 0 ? committed : s.total);
    const allocated = children.reduce((sum, c) => sum + c.allocatedBytes, 0);
    const hasDisks = allocated > 0;
    const ratio = total && total > 0 ? committed / total : null;
    const kind: StorageVolume['kind'] = hasDisks ? 'usage' : 'na';
    const tone: SeverityOrNa = kind === 'na' || ratio === null ? 'na' : usageSeverity(ratio * 100, config);
    volumes.push({
      storage: s.storage,
      type: s.type,
      children,
      totalBytes: total,
      usedBytes: committed, // engagé = Σ tailles VG (pas les données des VG)
      allocatedBytes: allocated,
      thinCapable: isThinStorage(s.type),
      hasDisks,
      ratio,
      kind,
      tone,
      totalSource: lunSize !== undefined ? 'lun' : 'vg-sum',
    });
  }

  // Stabilité d'affichage : les plus alloués d'abord, départage par nom (enfants inclus).
  const sortVols = (vs: StorageVolume[]): StorageVolume[] =>
    vs.sort((a, b) => b.allocatedBytes - a.allocatedBytes || a.storage.localeCompare(b.storage));
  for (const v of volumes) sortVols(v.children);
  sortVols(volumes);

  // Ratio global : volumes thin qui hébergent des disques uniquement (on aplatit l'arbre).
  const allNodes: StorageVolume[] = [];
  const collect = (vs: StorageVolume[]): void => {
    for (const v of vs) {
      allNodes.push(v);
      collect(v.children);
    }
  };
  collect(volumes);
  const thinWithDisks = allNodes.filter((v) => v.thinCapable && v.hasDisks);
  const thinAlloc = thinWithDisks.reduce((s, v) => s + v.allocatedBytes, 0);
  const thinTotal = thinWithDisks.reduce((s, v) => s + (v.totalBytes ?? 0), 0);
  const diskOvercommit = thinTotal > 0 ? thinAlloc / thinTotal : null;

  return { volumes, diskOvercommit };
}
