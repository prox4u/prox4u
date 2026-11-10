import { describe, expect, it } from 'vitest';
import { buildStorageVolumes } from './storage-volumes.js';
import { DEFAULT_OVERCOMMIT_CONFIG } from './overcommit.js';
import type { PveStorage, StorageDiskAlloc } from './types.js';

const GB = 1024 ** 3;
const CFG = DEFAULT_OVERCOMMIT_CONFIG; // usage warn ≥70 / crit >90 · disk ok ≤1 / warn ≤1.5 / crit >1.5

/** Datastore de test (content vide, non shared). */
const stor = (storage: string, type: PveStorage['type'], total: number | null, used: number | null, extra: Partial<PveStorage> = {}): PveStorage => ({
  storage,
  type,
  content: [],
  total,
  used,
  ...extra,
});

const alloc = (entries: [string, number][]): StorageDiskAlloc[] => entries.map(([storage, allocatedBytes]) => ({ storage, allocatedBytes }));

describe('buildStorageVolumes — hiérarchie iSCSI → LVM', () => {
  it('LUN iSCSI + VG dessus = un parent + un enfant (capacité du LUN, pas LUN + VG)', () => {
    // clusterproxmox : baie-iscsi (iscsi, le LUN) porte Lun-iscsi (lvm, le VG).
    const storages = [
      stor('baie-iscsi', 'iscsi', 300 * GB, 40 * GB, { duplicateOf: ['Lun-iscsi'] }),
      stor('Lun-iscsi', 'lvm', 300 * GB, 40 * GB),
    ];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG);
    // Un seul volume top-level : le LUN. Le VG est son enfant.
    expect(volumes).toHaveLength(1);
    const lun = volumes[0];
    expect(lun.storage).toBe('baie-iscsi');
    expect(lun.children).toHaveLength(1);
    expect(lun.children[0].storage).toBe('Lun-iscsi');
    // Capacité du LUN (300 Go), pas 600 (LUN + VG).
    expect(lun.totalBytes).toBe(300 * GB);
    // LUN sans taille connue → somme des VG (borne basse).
    expect(lun.totalSource).toBe('vg-sum');
  });

  it('LUN 600 Go / VG 100 Go → 100 Go engagés, 500 Go libres (engagé ≠ données du VG)', () => {
    const storages = [
      stor('baie', 'iscsi', 600 * GB, 100 * GB, { duplicateOf: ['vg'] }),
      stor('vg', 'lvm', 100 * GB, 30 * GB), // 30 Go de données dans le VG
    ];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG);
    const lun = volumes[0];
    // Utilisé du LUN = taille du VG (engagé), PAS les 30 Go de données du VG.
    expect(lun.usedBytes).toBe(100 * GB);
    // Sans taille LUN connue : total = Σ VG = 100 Go (borne basse), ratio 100 %.
    expect(lun.totalBytes).toBe(100 * GB);
    expect(lun.ratio).toBeCloseTo(1, 5);
    // Le VG enfant affiche SES propres données/taille (30/100).
    expect(lun.children[0].usedBytes).toBe(30 * GB);
    expect(lun.children[0].totalBytes).toBe(100 * GB);
  });

  it('taille LUN connue (lunSizes) → capacité = taille du LUN, totalSource = lun', () => {
    const storages = [
      stor('baie', 'iscsi', 100 * GB, 100 * GB, { duplicateOf: ['vg'] }),
      stor('vg', 'lvm', 100 * GB, 30 * GB),
    ];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG, { baie: 600 * GB });
    const lun = volumes[0];
    expect(lun.totalBytes).toBe(600 * GB);
    expect(lun.totalSource).toBe('lun');
    // 100 Go engagés sur 600 Go → 16,7 % (500 Go libres).
    expect(lun.usedBytes).toBe(100 * GB);
    expect(lun.ratio).toBeCloseTo(100 / 600, 5);
  });

  it('plusieurs VG sur un même LUN (vrai matériel) → plusieurs enfants', () => {
    const storages = [
      stor('baie', 'iscsi', 500 * GB, 200 * GB, { duplicateOf: ['vg-a', 'vg-b'] }),
      stor('vg-a', 'lvm', 120 * GB, 40 * GB),
      stor('vg-b', 'lvm', 80 * GB, 20 * GB),
    ];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG);
    const lun = volumes[0];
    expect(lun.children).toHaveLength(2);
    expect(lun.children.map((c) => c.storage).sort()).toEqual(['vg-a', 'vg-b']);
    // Engagé = Σ tailles VG = 200 Go.
    expect(lun.usedBytes).toBe(200 * GB);
    expect(lun.totalBytes).toBe(200 * GB); // borne basse sans taille LUN
  });

  it('LUN iSCSI brut (aucun VG dessus) → volume autonome, pas de parent', () => {
    const storages = [stor('san-brut', 'iscsi', 300 * GB, 40 * GB)];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].storage).toBe('san-brut');
    expect(volumes[0].children).toEqual([]);
    expect(volumes[0].totalSource).toBeUndefined();
    expect(volumes[0].totalBytes).toBe(300 * GB);
  });

  it('deux baies iSCSI identiques (même total/used) ne sont PAS fusionnées (pas d’heuristique de taille)', () => {
    const storages = [stor('san-a', 'iscsi', 300 * GB, 40 * GB), stor('san-b', 'iscsi', 300 * GB, 40 * GB)];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG);
    expect(volumes.map((v) => v.storage).sort()).toEqual(['san-a', 'san-b']);
  });

  it('duplicateOf listant un VG absent → le LUN reste autonome (pas d’enfant fantôme)', () => {
    const storages = [stor('baie', 'iscsi', 300 * GB, 40 * GB, { duplicateOf: ['vg-inexistant'] })];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].storage).toBe('baie');
    expect(volumes[0].children).toEqual([]);
  });
});

describe('buildStorageVolumes — classification thin / thick + ratio', () => {
  it('thin (lvmthin) autonome avec disques → kind overcommit, tonalité politique overcommit', () => {
    const storages = [stor('thinpool', 'lvmthin', 100 * GB, 10 * GB)];
    const { volumes } = buildStorageVolumes(storages, alloc([['thinpool', 120 * GB]]), CFG); // 120 %
    expect(volumes[0].thinCapable).toBe(true);
    expect(volumes[0].kind).toBe('overcommit');
    expect(volumes[0].ratio).toBeCloseTo(1.2, 5);
    expect(volumes[0].tone).toBe('warn');
  });

  it('VG lvm enfant avec disques → kind usage, son propre ratio alloué/taille VG', () => {
    const storages = [
      stor('baie', 'iscsi', 300 * GB, 40 * GB, { duplicateOf: ['Lun-iscsi'] }),
      stor('Lun-iscsi', 'lvm', 300 * GB, 40 * GB),
    ];
    const { volumes } = buildStorageVolumes(storages, alloc([['Lun-iscsi', 43 * GB]]), CFG); // 14 %
    const vg = volumes[0].children[0];
    expect(vg.thinCapable).toBe(false);
    expect(vg.kind).toBe('usage');
    expect(vg.ratio).toBeCloseTo(43 / 300, 5);
    expect(vg.tone).toBe('ok');
  });

  it('volume sans disque → kind na, tone na (même si thin)', () => {
    const storages = [stor('thinpool-vide', 'lvmthin', 5 * GB, 0)];
    const { volumes } = buildStorageVolumes(storages, alloc([]), CFG);
    expect(volumes[0].kind).toBe('na');
    expect(volumes[0].tone).toBe('na');
    expect(volumes[0].hasDisks).toBe(false);
  });

  it('volume sans capacité connue → ratio null, tone na', () => {
    const storages = [stor('nfs-x', 'nfs', null, null)];
    const { volumes } = buildStorageVolumes(storages, alloc([['nfs-x', 10 * GB]]), CFG);
    expect(volumes[0].ratio).toBeNull();
    expect(volumes[0].tone).toBe('na');
    expect(volumes[0].kind).toBe('usage');
  });
});

describe('buildStorageVolumes — ratio global disk (bug 916 %)', () => {
  it('disques uniquement sur du thick (VG sur LUN) → diskOvercommit null (n/a)', () => {
    // clusterproxmox : disques sur Lun-iscsi (lvm/thick, enfant du LUN), local-lvm vide.
    const storages = [
      stor('baie', 'iscsi', 322 * GB, 43 * GB, { duplicateOf: ['Lun-iscsi'] }),
      stor('Lun-iscsi', 'lvm', 322 * GB, 43 * GB),
      stor('local-lvm', 'lvmthin', 4.69 * GB, 0),
    ];
    const { diskOvercommit } = buildStorageVolumes(storages, alloc([['Lun-iscsi', 43 * GB]]), CFG);
    expect(diskOvercommit).toBeNull(); // aucun disque sur un thin → n/a
  });

  it('disques sur un thin autonome → diskOvercommit = alloué thin / capacité thin', () => {
    const storages = [stor('ceph', 'rbd', 20 * 1024 * GB, 8 * 1024 * GB), stor('local', 'dir', 200 * GB, 60 * GB)];
    const { diskOvercommit } = buildStorageVolumes(storages, alloc([['ceph', 10 * 1024 * GB], ['local', 100 * GB]]), CFG);
    expect(diskOvercommit).toBeCloseTo(0.5, 5); // 10 To / 20 To
  });

  it('plusieurs thin : seuls les thin qui hébergent des disques comptent', () => {
    const storages = [stor('thinA', 'lvmthin', 100 * GB, 10 * GB), stor('thinB', 'lvmthin', 1000 * GB, 0)];
    const { diskOvercommit } = buildStorageVolumes(storages, alloc([['thinA', 150 * GB]]), CFG);
    expect(diskOvercommit).toBeCloseTo(150 / 100, 5); // ×1,5, pas 150/1100
  });
});

describe('buildStorageVolumes — allocation agrégée sur le LUN', () => {
  it('les disques posés sur le VG enfant sont comptés sur le LUN parent (une fois)', () => {
    const storages = [
      stor('baie', 'iscsi', 300 * GB, 40 * GB, { duplicateOf: ['Lun-iscsi'] }),
      stor('Lun-iscsi', 'lvm', 300 * GB, 40 * GB),
    ];
    const { volumes } = buildStorageVolumes(storages, alloc([['Lun-iscsi', 43 * GB]]), CFG);
    const lun = volumes[0];
    expect(lun.allocatedBytes).toBe(43 * GB); // agrégé depuis le VG enfant
    expect(lun.hasDisks).toBe(true);
  });
});
