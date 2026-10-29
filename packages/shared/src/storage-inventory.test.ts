import { describe, expect, it } from 'vitest';
import type { PveStorage, PveStorageType } from './types.js';
import { DEFAULT_OVERCOMMIT_CONFIG } from './overcommit.js';
import {
  buildDatastoreForecast,
  buildStorageInventory,
  buildStorageInventoryAll,
  filterStorageRows,
  storageSeverity,
  sortStorageRows,
  type StorageVmRef,
} from './storage-inventory.js';

// --- Fixtures -------------------------------------------------------------------

function stor(type: PveStorageType, used: number | null, total: number | null, extra?: Partial<PveStorage>): PveStorage {
  return {
    storage: `st-${type}`,
    type,
    content: ['images', 'iso'],
    used,
    total,
    shared: false,
    ...extra,
  };
}

function vm(vmid: number, name: string, status: StorageVmRef['status'], node: string, storage: string, diskBytes = 0): StorageVmRef {
  return { vmid, name, node, status, diskBytes, storage };
}

function data() {
  const storages: PveStorage[] = [
    stor('rbd', 40 * 1024 ** 3, 200 * 1024 ** 3, { storage: 'ceph', shared: true, nodes: ['pve1', 'pve2', 'pve3'] }),
    stor('dir', 60 * 1024 ** 3, 200 * 1024 ** 3, { storage: 'local-pve1', nodes: ['pve1'] }),
    stor('zfs', null, null, { storage: 'zfspool' }), // pas de capacité connue
    stor('lvmthin', 95 * 1024 ** 3, 100 * 1024 ** 3, { storage: 'local-lvm' }),
  ];
  const vms: StorageVmRef[] = [
    vm(100, 'web-1', 'running', 'pve1', 'ceph', 50 * 1024 ** 3),
    vm(101, 'db-1', 'running', 'pve2', 'ceph', 200 * 1024 ** 3),
    vm(102, 'iso-cache', 'stopped', 'pve1', 'local-pve1', 5 * 1024 ** 3),
    vm(103, 'orphan', 'running', 'pve3', 'inconnu'), // datastore non listé
  ];
  return { storages, vms };
}

// --- buildStorageInventory --------------------------------------------------------

describe('buildStorageInventory', () => {
  it('une ligne par datastore, triée par nom', () => {
    const rows = buildStorageInventory(data().storages, data().vms);
    expect(rows.map((r) => r.key)).toEqual(['ceph', 'local-lvm', 'local-pve1', 'zfspool']);
  });

  it('capacité : pct arrondi à 0,1 et borné à 100', () => {
    const rows = buildStorageInventory(data().storages, data().vms);
    expect(rows.find((r) => r.key === 'ceph')!.pct).toBe(20); // 40/200
    expect(rows.find((r) => r.key === 'local-lvm')!.pct).toBe(95);
    const over = buildStorageInventory([stor('dir', 250, 200, { storage: 'x' })], []);
    expect(over[0].pct).toBe(100);
  });

  it('pas de capacité → hasCapacity=false, pct=0', () => {
    const rows = buildStorageInventory(data().storages, data().vms);
    const zfs = rows.find((r) => r.key === 'zfspool')!;
    expect(zfs.hasCapacity).toBe(false);
    expect(zfs.pct).toBe(0);
  });

  it('kind : shared si flag partagé, sinon local', () => {
    const rows = buildStorageInventory(data().storages, data().vms);
    expect(rows.find((r) => r.key === 'ceph')!.kind).toBe('shared');
    expect(rows.find((r) => r.key === 'local-pve1')!.kind).toBe('local');
  });

  it('nœuds remontés depuis le datastore', () => {
    const rows = buildStorageInventory(data().storages, data().vms);
    expect(rows.find((r) => r.key === 'ceph')!.nodes).toEqual(['pve1', 'pve2', 'pve3']);
    expect(rows.find((r) => r.key === 'local-pve1')!.nodes).toEqual(['pve1']);
  });

  it('VMs rattachées à leur datastore + compteurs running/stopped + Σ disques', () => {
    const rows = buildStorageInventory(data().storages, data().vms);
    const ceph = rows.find((r) => r.key === 'ceph')!;
    expect(ceph.vms.map((v) => v.vmid).sort()).toEqual([100, 101]);
    expect(ceph.running).toBe(2);
    expect(ceph.stopped).toBe(0);
    expect(ceph.diskAllocated).toBe(250 * 1024 ** 3);
    const local = rows.find((r) => r.key === 'local-pve1')!;
    expect(local.vms).toHaveLength(1);
    expect(local.running).toBe(0);
    expect(local.stopped).toBe(1);
  });

  it('VM sur un datastore non listé → ignorée (pas de crash)', () => {
    const rows = buildStorageInventory(data().storages, data().vms);
    expect(rows.some((r) => r.vms.some((v) => v.vmid === 103))).toBe(false);
  });
});

// --- buildStorageInventoryAll -----------------------------------------------------

describe('buildStorageInventoryAll', () => {
  it('agrège les endpoints + nom du serveur', () => {
    const d = data();
    const rows = buildStorageInventoryAll(
      [
        { endpointId: 'a', storages: d.storages, vms: d.vms },
        { endpointId: 'b', storages: [stor('nfs', 10, 100, { storage: 'nfs-share', shared: true, nodes: ['pve9'] })], vms: [] },
      ],
      { a: 'Alpha', b: 'Beta' },
    );
    expect(rows).toHaveLength(5);
    const nfs = rows.find((r) => r.key === 'b/nfs-share')!;
    expect(nfs.endpointId).toBe('b');
    expect(nfs.endpointName).toBe('Beta');
  });

  it('id d’endpoint inconnu → nom = id', () => {
    const d = data();
    const rows = buildStorageInventoryAll([{ endpointId: 'zzz', storages: d.storages, vms: d.vms }], {});
    expect(rows[0].endpointName).toBe('zzz');
  });

  it('clés uniques même pour des datastores homonymes sur plusieurs endpoints', () => {
    // Deux endpoints qui exposent tous deux un datastore « local » → les clés doivent diverger
    const rows = buildStorageInventoryAll(
      [
        { endpointId: 'a', storages: [stor('dir', 10, 100, { storage: 'local', nodes: ['n1'] })], vms: [] },
        { endpointId: 'b', storages: [stor('dir', 20, 100, { storage: 'local', nodes: ['n2'] })], vms: [] },
      ],
      { a: 'A', b: 'B' },
    );
    expect(rows.map((r) => r.key)).toEqual(['a/local', 'b/local']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

// --- storageSeverity --------------------------------------------------------------

describe('storageSeverity', () => {
  const cfg = DEFAULT_OVERCOMMIT_CONFIG; // usage warn ≥ 70, crit > 90
  it('na si pas de capacité', () => {
    expect(storageSeverity({ pct: 99, hasCapacity: false }, cfg)).toBe('na');
  });
  it('bornes d’usage : <70 ok, 70–90 warn, >90 crit', () => {
    expect(storageSeverity({ pct: 50, hasCapacity: true }, cfg)).toBe('ok');
    expect(storageSeverity({ pct: 70, hasCapacity: true }, cfg)).toBe('warn');
    expect(storageSeverity({ pct: 90, hasCapacity: true }, cfg)).toBe('warn');
    expect(storageSeverity({ pct: 91, hasCapacity: true }, cfg)).toBe('crit');
  });
});

// --- filterStorageRows ------------------------------------------------------------

describe('filterStorageRows', () => {
  const rows = buildStorageInventory(data().storages, data().vms);

  it('recherche par nom de datastore', () => {
    expect(filterStorageRows(rows, 'ceph').map((r) => r.key)).toEqual(['ceph']);
  });

  it('recherche par nom de VM hébergée', () => {
    expect(filterStorageRows(rows, 'db-1').map((r) => r.key)).toEqual(['ceph']);
  });

  it('recherche par nœud', () => {
    expect(filterStorageRows(rows, 'pve2').map((r) => r.key)).toEqual(['ceph']);
  });

  it('filtre type exact (déroulé)', () => {
    expect(filterStorageRows(rows, '', { type: 'rbd' }).map((r) => r.key)).toEqual(['ceph']);
    expect(filterStorageRows(rows, '', { type: 'nfs' })).toHaveLength(0);
  });

  it('recherche + type : ET entre les deux dimensions', () => {
    expect(filterStorageRows(rows, 'ceph', { type: 'rbd' })).toHaveLength(1);
    expect(filterStorageRows(rows, 'ceph', { type: 'dir' })).toHaveLength(0);
  });

  it('query vide → toutes les lignes', () => {
    expect(filterStorageRows(rows, '   ')).toHaveLength(rows.length);
  });
});

// --- sortStorageRows --------------------------------------------------------------

describe('sortStorageRows', () => {
  const cfg = DEFAULT_OVERCOMMIT_CONFIG; // usage warn ≥ 70, crit > 90
  const rows = buildStorageInventory(data().storages, data().vms);
  // ceph(rbd,20%,ok,2 VMs) · local-pve1(dir,30%,ok,1 VM) · zfspool(zfs,na,0) · local-lvm(lvmthin,95%,crit,0)

  it('datastore : A→Z par défaut, Z→A en desc', () => {
    expect(sortStorageRows(rows, cfg, { key: 'datastore', dir: 'asc' }).map((r) => r.key)).toEqual([
      'ceph', 'local-lvm', 'local-pve1', 'zfspool',
    ]);
    expect(sortStorageRows(rows, cfg, { key: 'datastore', dir: 'desc' }).map((r) => r.key)).toEqual([
      'zfspool', 'local-pve1', 'local-lvm', 'ceph',
    ]);
  });

  it('capacity : les plus pleins d’abord (desc) — na (pct 0) en dernier', () => {
    expect(sortStorageRows(rows, cfg, { key: 'capacity', dir: 'desc' }).map((r) => r.key)).toEqual([
      'local-lvm', 'local-pve1', 'ceph', 'zfspool',
    ]);
  });

  it('vms : par nombre de VMs, égalités départagées par nom de datastore', () => {
    expect(sortStorageRows(rows, cfg, { key: 'vms', dir: 'desc' }).map((r) => r.key)).toEqual([
      'ceph', 'local-pve1', 'local-lvm', 'zfspool',
    ]);
  });

  it('state : crit d’abord (desc), na en dernier (asc), égalités par nom', () => {
    expect(sortStorageRows(rows, cfg, { key: 'state', dir: 'desc' }).map((r) => r.key)).toEqual([
      'local-lvm', 'ceph', 'local-pve1', 'zfspool',
    ]);
    expect(sortStorageRows(rows, cfg, { key: 'state', dir: 'asc' }).map((r) => r.key)).toEqual([
      'zfspool', 'ceph', 'local-pve1', 'local-lvm',
    ]);
  });

  it('type : tri alphabétique des types', () => {
    expect(sortStorageRows(rows, cfg, { key: 'type', dir: 'asc' }).map((r) => r.key)).toEqual([
      'local-pve1', 'local-lvm', 'ceph', 'zfspool',
    ]);
  });

  it('server : par nom du serveur (vue agrégée)', () => {
    const all = buildStorageInventoryAll(
      [
        { endpointId: 'b', storages: [stor('dir', 10, 100, { storage: 'db' })], vms: [] },
        { endpointId: 'a', storages: [stor('dir', 10, 100, { storage: 'aa' })], vms: [] },
      ],
      { a: 'Alpha', b: 'Beta' },
    );
    expect(sortStorageRows(all, cfg, { key: 'server', dir: 'asc' }).map((r) => r.endpointName)).toEqual(['Alpha', 'Beta']);
  });

  it('ne mutable pas le tableau d’entrée (renvoie une copie)', () => {
    const before = rows.map((r) => r.key).join(',');
    sortStorageRows(rows, cfg, { key: 'capacity', dir: 'desc' });
    expect(rows.map((r) => r.key).join(',')).toBe(before);
  });
});

// --- buildDatastoreForecast -------------------------------------------------------

describe('buildDatastoreForecast', () => {
  const GB = 1024 ** 3;

  it('moins de 7 jours → insufficientData, pas de projection', () => {
    // 3 jours seulement d'historique
    const pts = [
      { time: 1_000_000, used: 10 * GB, total: 100 * GB },
      { time: 1_086_400, used: 11 * GB, total: 100 * GB },
      { time: 1_172_800, used: 12 * GB, total: 100 * GB },
    ];
    const f = buildDatastoreForecast(pts);
    expect(f.insufficientData).toBe(true);
    expect(f.projection).toHaveLength(0);
    expect(f.daysTo90).toBeNull();
  });

  it('série croissante → jours avant 90 % estimés', () => {
    // 30 jours, croissance linéaire de 1 %/j (10 % → 40 %)
    const pts: { time: number; used: number; total: number }[] = [];
    const base = 1_700_000_000 - (30 * 86_400);
    for (let i = 0; i < 30; i++) {
      pts.push({ time: base + i * 86_400, used: (10 + i) * GB, total: 100 * GB });
    }
    const f = buildDatastoreForecast(pts);
    expect(f.insufficientData).toBe(false);
    expect(f.slopePerDay).toBeCloseTo(1, 1);
    expect(f.daysTo90).not.toBeNull();
    // dernière valeur = 39 % → (90 - 39) / 1 ≈ 51 j
    expect(f.daysTo90!).toBeGreaterThanOrEqual(45);
    expect(f.daysTo90!).toBeLessThanOrEqual(56);
  });

  it('série stable (pente ≈ 0) → daysTo90 null', () => {
    const pts: { time: number; used: number; total: number }[] = [];
    const base = 1_700_000_000 - (30 * 86_400);
    for (let i = 0; i < 30; i++) {
      pts.push({ time: base + i * 86_400, used: 50 * GB, total: 100 * GB });
    }
    const f = buildDatastoreForecast(pts);
    expect(f.daysTo90).toBeNull();
    expect(f.daysTo80).toBeNull();
  });

  it('points sans capacité (total=0) ignorés dans la moyenne journalière', () => {
    const pts = [
      { time: 1_000_000, used: 0, total: 0 }, // ignoré
      { time: 1_000_100, used: 25 * GB, total: 100 * GB }, // 25 %
    ];
    const f = buildDatastoreForecast(pts);
    expect(f.insufficientData).toBe(true); // 1 seul jour valide
  });
});
