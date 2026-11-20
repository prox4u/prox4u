import { describe, expect, it } from 'vitest';
import { clusterAltUrls, diskStorageOf, iscsiHostVg, mapLimit, promoteUrl } from './prox4u-client.js';

/**
 * PVE 9 ne renvoie plus le champ `storage` dans /cluster/resources :
 * le datastore du disque principal est dérivé de la config VM. Ce test couvre
 * les formats de volume (storage:vol, pool/vol, iso ignorés, qemu vs lxc).
 */
describe('diskStorageOf', () => {
  it('qemu lvmthin : scsi0 local-lvm:vm-100-disk-0', () => {
    expect(diskStorageOf({ scsi0: 'local-lvm:vm-100-disk-0,size=32G' }, 'qemu')).toBe('local-lvm');
  });

  it('qemu dir : virtio0 local:base-100.qcow2', () => {
    expect(diskStorageOf({ virtio0: 'local:base-100.qcow2' }, 'qemu')).toBe('local');
  });

  it('qemu zfs : scsi0 zfspool/vm-101-disk-0 (format pool/vol)', () => {
    expect(diskStorageOf({ scsi0: 'zfspool/vm-101-disk-0' }, 'qemu')).toBe('zfspool');
  });

  it('qemu rbd : scsi0 rbd/vm-102-disk-0', () => {
    expect(diskStorageOf({ scsi0: 'rbd/vm-102-disk-0,size=16G' }, 'qemu')).toBe('rbd');
  });

  it('qemu nfs : sata0 nfs:vm-103.qcow2', () => {
    expect(diskStorageOf({ sata0: 'nfs:vm-103.qcow2' }, 'qemu')).toBe('nfs');
  });

  it('qemu : priorité au disque de boot (scsi0 avant scsi1)', () => {
    expect(diskStorageOf({ scsi1: 'other:vm-104-disk-1', scsi0: 'local-lvm:vm-104-disk-0' }, 'qemu')).toBe('local-lvm');
  });

  it('qemu : ISO ignoré (ide0 local:iso/x.iso) → retombe sur le vrai disque', () => {
    expect(diskStorageOf({ ide0: 'local:iso/debian.iso', scsi0: 'local-lvm:vm-105-disk-0' }, 'qemu')).toBe('local-lvm');
  });

  it('lxc : rootfs local-lvm:vm-106-disk-0', () => {
    expect(diskStorageOf({ rootfs: 'local-lvm:vm-106-disk-0,size=32G' }, 'lxc')).toBe('local-lvm');
  });

  it('lxc : rootfs zfspool/vm-107-disk-0 (format pool/vol)', () => {
    expect(diskStorageOf({ rootfs: 'zfspool/vm-107-disk-0' }, 'lxc')).toBe('zfspool');
  });

  it('config sans disque → undefined', () => {
    expect(diskStorageOf({ memory: '4096' }, 'qemu')).toBeUndefined();
    expect(diskStorageOf({}, 'lxc')).toBeUndefined();
  });
});

describe('mapLimit', () => {
  it('borne la concurrence à `limit` et traite tous les éléments', async () => {
    let running = 0;
    let peak = 0;
    let done = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapLimit(items, 5, async () => {
      running += 1;
      peak = Math.max(peak, running);
      // laisse le temps aux autres workers de démarrer avant de se libérer
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      done += 1;
    });
    expect(peak).toBeLessThanOrEqual(5); // jamais plus de `limit` en vol
    expect(peak).toBeGreaterThan(1); // bien en parallèle (pas séquentiel)
    expect(done).toBe(50); // tout le monde est traité
  });

  it('ne fait rien si le tableau est vide', async () => {
    let n = 0;
    await mapLimit([], 5, async () => {
      n += 1;
    });
    expect(n).toBe(0);
  });
});

describe('iscsiHostVg (dédoublonnage iSCSI / VG LVM)', () => {
  // Scénario réel clusterproxmox : la cible iSCSI « baie-iscsi » porte un VG LVM
  // « Lun-iscsi » (base = « baie-iscsi:0.0.0.scsi-… ») → même volume, deux datastores.
  const withVg = [
    { storage: 'baie-iscsi', type: 'iscsi' },
    { storage: 'Lun-iscsi', type: 'lvm', base: 'baie-iscsi:0.0.0.scsi-xyz' },
  ];

  it('cible iSCSI avec un VG dessus → renvoie le VG hôte', () => {
    expect(iscsiHostVg(withVg, 'baie-iscsi')).toMatchObject({ storage: 'Lun-iscsi' });
  });

  it('cible iSCSI sans VG (LUN brut) → undefined (pas de doublon)', () => {
    expect(iscsiHostVg([{ storage: 'san-brute', type: 'iscsi' }], 'san-brute')).toBeUndefined();
  });

  it('le VG pointe vers une AUTRE cible → undefined pour celle-ci', () => {
    const other = [
      { storage: 'iscsi-A', type: 'iscsi' },
      { storage: 'iscsi-B', type: 'iscsi' },
      { storage: 'vg', type: 'lvm', base: 'iscsi-A:lun-0' },
    ];
    expect(iscsiHostVg(other, 'iscsi-A')).toMatchObject({ storage: 'vg' });
    expect(iscsiHostVg(other, 'iscsi-B')).toBeUndefined();
  });

  it('préfixe exact : « baie » ne doit pas matcher « baie-iscsi »', () => {
    const tricky = [
      { storage: 'baie', type: 'iscsi' },
      { storage: 'baie-iscsi', type: 'iscsi' },
      { storage: 'vg', type: 'lvm', base: 'baie-iscsi:lun-0' },
    ];
    expect(iscsiHostVg(tricky, 'baie-iscsi')).toMatchObject({ storage: 'vg' });
    expect(iscsiHostVg(tricky, 'baie')).toBeUndefined(); // « baie-iscsi:… » ne commence pas par « baie: »
  });
});

describe('clusterAltUrls (failover — alternatives = APIs des autres nœuds)', () => {
  it('cluster 2 nœuds, primaire .202 → alternative .201', () => {
    expect(clusterAltUrls('https://192.168.1.202:8006', ['192.168.1.201', '192.168.1.202'])).toEqual([
      'https://192.168.1.201:8006',
    ]);
  });

  it('exclut l’URL primaire (même IP, même port)', () => {
    expect(clusterAltUrls('https://192.168.1.201:8006', ['192.168.1.201'])).toEqual([]);
  });

  it('dédoublonne les IPs en double', () => {
    expect(clusterAltUrls('https://pve1:8006', ['10.0.0.1', '10.0.0.1', '10.0.0.2'])).toEqual([
      'https://10.0.0.1:8006',
      'https://10.0.0.2:8006',
    ]);
  });

  it('ignore les IPs null/undefined', () => {
    expect(clusterAltUrls('https://pve1:8006', [null, undefined, '10.0.0.1'])).toEqual(['https://10.0.0.1:8006']);
  });

  it('hérite le port de l’URL primaire (port custom)', () => {
    expect(clusterAltUrls('https://pve1:9443', ['10.0.0.1'])).toEqual(['https://10.0.0.1:9443']);
  });

  it('port par défaut 443 si l’URL primaire n’en a pas', () => {
    expect(clusterAltUrls('https://pve1', ['10.0.0.1'])).toEqual(['https://10.0.0.1:443']);
  });

  it('URL primaire invalide → liste vide (pas de failover)', () => {
    expect(clusterAltUrls('pas une url', ['10.0.0.1'])).toEqual([]);
  });

  it('pas d’IP connue → liste vide (standalone)', () => {
    expect(clusterAltUrls('https://pve1:8006', [undefined, null])).toEqual([]);
  });
});

describe('promoteUrl (failover sticky — promotion de l’URL qui a répondu)', () => {
  it('activeIndex 0 → inchangé (déjà en tête)', () => {
    expect(promoteUrl(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
  });

  it('activeIndex 1 → rotation : l’URL vivante passe en tête', () => {
    expect(promoteUrl(['mort', 'vivant', 'c'], 1)).toEqual(['vivant', 'mort', 'c']);
  });

  it('activeIndex 2 → rotation complète', () => {
    expect(promoteUrl(['a', 'b', 'c'], 2)).toEqual(['c', 'a', 'b']);
  });

  it('index hors bornes (négatif / ≥ longueur) → inchangé', () => {
    expect(promoteUrl(['a', 'b'], -1)).toEqual(['a', 'b']);
    expect(promoteUrl(['a', 'b'], 5)).toEqual(['a', 'b']);
  });

  it('liste à une URL → inchangé', () => {
    expect(promoteUrl(['a'], 0)).toEqual(['a']);
  });
});
