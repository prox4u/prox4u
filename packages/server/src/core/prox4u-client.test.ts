import { describe, expect, it } from 'vitest';
import { diskStorageOf, mapLimit } from './prox4u-client.js';

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
