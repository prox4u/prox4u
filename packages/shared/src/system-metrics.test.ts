import { describe, expect, it } from 'vitest';
import { isPhysicalDevice, mapperLabel, parsePveMapperName, swapPct, zfsHitRatePct } from './system-metrics.js';

describe('parsePveMapperName', () => {
  it('décode un LV QEMU (vg simple)', () => {
    expect(parsePveMapperName('local--vm--101--disk--0')).toEqual({
      storage: 'local',
      lv: 'vm-101-disk-0',
      kind: 'vm',
      id: 101,
    });
  });

  it('décode un LV LXC (base-)', () => {
    expect(parsePveMapperName('rapide--base--103--disk--0')).toEqual({
      storage: 'rapide',
      lv: 'base-103-disk-0',
      kind: 'ct',
      id: 103,
    });
  });

  it('le VG peut contenir des tirets (storage avec -) — on part du suffixe LV', () => {
    expect(parsePveMapperName('my--storage--vm--10--disk--1')).toEqual({
      storage: 'my--storage',
      lv: 'vm-10-disk-1',
      kind: 'vm',
      id: 10,
    });
  });

  it('vmid 10 ≠ 101 (les tirets bornent le numéro)', () => {
    expect(parsePveMapperName('vg--vm--101--disk--0').id).toBe(101);
    expect(parsePveMapperName('vg--vm--10--disk--0').id).toBe(10);
  });

  it('un LV sans pattern VM/CT = other (root, pool…)', () => {
    expect(parsePveMapperName('local--root')).toEqual({ storage: '', lv: 'local-root', kind: 'other', id: null });
    expect(parsePveMapperName('vg--vm--pool')).toEqual({ storage: '', lv: 'vg-vm-pool', kind: 'other', id: null });
  });
});

describe('mapperLabel', () => {
  it('libellé lisible pour un LV VM/CT', () => {
    expect(mapperLabel('local--vm--100--disk--0')).toBe('vm-100-disk-0 (vg local)');
    expect(mapperLabel('rapide--base--103--disk--1')).toBe('base-103-disk-1 (vg rapide)');
  });

  it('other = nom avec tirets simples, sans vg', () => {
    expect(mapperLabel('local--root')).toBe('local-root');
  });
});

describe('isPhysicalDevice', () => {
  it('accepte les disques entiers', () => {
    expect(isPhysicalDevice('nvme0n1')).toBe(true);
    expect(isPhysicalDevice('nvme1n1')).toBe(true);
    expect(isPhysicalDevice('sda')).toBe(true);
    expect(isPhysicalDevice('sdb')).toBe(true);
    expect(isPhysicalDevice('vda')).toBe(true);
    expect(isPhysicalDevice('cciss/c0d0')).toBe(false); // pas le format attendu ici (cciss0 oui)
    expect(isPhysicalDevice('cciss0')).toBe(true);
  });

  it('exclut device-mapper (LV double-comptés)', () => {
    expect(isPhysicalDevice('dm-0')).toBe(false);
    expect(isPhysicalDevice('dm-12')).toBe(false);
  });

  it('exclut les partitions (sous-ensemble du disque entier)', () => {
    expect(isPhysicalDevice('sda1')).toBe(false);
    expect(isPhysicalDevice('sda15')).toBe(false);
    expect(isPhysicalDevice('nvme0n1p1')).toBe(false);
    expect(isPhysicalDevice('nvme0n1p29')).toBe(false);
    expect(isPhysicalDevice('vda3')).toBe(false);
  });

  it('exclut loop / md (RAID) / sr (CD) / ram', () => {
    expect(isPhysicalDevice('loop0')).toBe(false);
    expect(isPhysicalDevice('md127')).toBe(false);
    expect(isPhysicalDevice('sr0')).toBe(false);
    expect(isPhysicalDevice('ram0')).toBe(false);
    expect(isPhysicalDevice('zram0')).toBe(false);
  });
});

describe('zfsHitRatePct (Monitor nœud v4 — ZFS ARC)', () => {
  it('compute le hit rate depuis les deltas de compteurs', () => {
    expect(zfsHitRatePct(950, 50)).toBeCloseTo(95, 5);
    expect(zfsHitRatePct(10, 10)).toBeCloseTo(50, 5);
  });

  it('retourne null sur total nul (compteurs à 0 — pas de pool ZFS actif)', () => {
    expect(zfsHitRatePct(0, 0)).toBeNull();
  });

  it('retourne null sur delta négatif (reset de counter au reboot)', () => {
    expect(zfsHitRatePct(-1, 5)).toBeNull();
    expect(zfsHitRatePct(5, -1)).toBeNull();
  });

  it('retourne null si un delta est manquant', () => {
    expect(zfsHitRatePct(null, 5)).toBeNull();
    expect(zfsHitRatePct(5, null)).toBeNull();
  });
});

describe('swapPct (Monitor nœud v4 — swap)', () => {
  it('compute le % utilisé', () => {
    expect(swapPct(50, 100)).toBeCloseTo(50, 5);
    expect(swapPct(0, 100)).toBe(0);
  });

  it('retourne null si pas de swap (total = 0) ou mesure manquante', () => {
    expect(swapPct(0, 0)).toBeNull();
    expect(swapPct(null, 100)).toBeNull();
    expect(swapPct(50, null)).toBeNull();
  });
});
