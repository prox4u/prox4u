import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERCOMMIT_CONFIG,
  computeOvercommit,
  isThinStorage,
  overcommitTone,
  riskSeverity,
  usageSeverity,
} from './overcommit.js';
import type { KpiSummary, OvercommitConfig } from './types.js';

const GB = 1024 ** 3;

const kpis = (over: Partial<KpiSummary> = {}): KpiSummary => ({
  nodes: { online: 1, total: 1 },
  cpuTotalCores: 24,
  cpuUsedCores: 6,
  cpuPct: 25,
  cpuAllocatedCores: 35,
  ramUsedBytes: 60 * GB,
  ramTotalBytes: 128 * GB,
  ramPct: 47,
  ramAllocatedBytes: 80 * GB,
  diskAllocatedBytes: 4 * 1024 * GB,
  diskThinTotalBytes: 8 * 1024 * GB,
  storageUsedBytes: 2 * 1024 * GB,
  storageTotalBytes: 10 * 1024 * GB,
  storagePct: 20,
  storageDaysToFull: null,
  vmsRunning: 4,
  vmsStopped: 1,
  vmsTotal: 5,
  ...over,
});

describe('isThinStorage', () => {
  it('LVM-thin, ZFS et Ceph RBD sont thin ; le reste non', () => {
    expect(isThinStorage('lvmthin')).toBe(true);
    expect(isThinStorage('zfs')).toBe(true);
    expect(isThinStorage('rbd')).toBe(true);
    expect(isThinStorage('lvm')).toBe(false);
    expect(isThinStorage('dir')).toBe(false);
    expect(isThinStorage('nfs')).toBe(false);
  });
});

describe('overcommitTone', () => {
  const cpu = DEFAULT_OVERCOMMIT_CONFIG.cpu; // ok ≤ 2, warn ≤ 4
  it('bornes CPU : ≤2 ok, 2–4 warn, >4 crit', () => {
    expect(overcommitTone(1.5, cpu)).toBe('ok');
    expect(overcommitTone(2, cpu)).toBe('ok');
    expect(overcommitTone(2.1, cpu)).toBe('warn');
    expect(overcommitTone(4, cpu)).toBe('warn');
    expect(overcommitTone(4.01, cpu)).toBe('crit');
  });

  it('bornes RAM : ≤1 ok, 1–1.2 warn, >1.2 crit', () => {
    const ram = DEFAULT_OVERCOMMIT_CONFIG.ram;
    expect(overcommitTone(1, ram)).toBe('ok');
    expect(overcommitTone(1.05, ram)).toBe('warn');
    expect(overcommitTone(1.2, ram)).toBe('warn');
    expect(overcommitTone(1.21, ram)).toBe('crit');
  });

  it('bornes disk : ≤1 ok, 1–1.5 warn, >1.5 crit', () => {
    const disk = DEFAULT_OVERCOMMIT_CONFIG.disk;
    expect(overcommitTone(0.9, disk)).toBe('ok');
    expect(overcommitTone(1.1, disk)).toBe('warn');
    expect(overcommitTone(1.5, disk)).toBe('warn');
    expect(overcommitTone(1.6, disk)).toBe('crit');
  });

  it('suit à une échelle custom (fichier modifié)', () => {
    expect(overcommitTone(3, { okMax: 5, warnMax: 8 })).toBe('ok');
    expect(overcommitTone(6, { okMax: 5, warnMax: 8 })).toBe('warn');
    expect(overcommitTone(9, { okMax: 5, warnMax: 8 })).toBe('crit');
  });
});

describe('usageSeverity', () => {
  const cfg = DEFAULT_OVERCOMMIT_CONFIG; // warn ≥ 70, crit > 90
  it('bornes d’usage : <70 ok, 70–90 warn, >90 crit', () => {
    expect(usageSeverity(50, cfg)).toBe('ok');
    expect(usageSeverity(70, cfg)).toBe('warn');
    expect(usageSeverity(90, cfg)).toBe('warn');
    expect(usageSeverity(91, cfg)).toBe('crit');
  });

  it('suit aux seuils custom du fichier', () => {
    const custom: OvercommitConfig = { ...cfg, usage: { warnPct: 60, critPct: 85 } };
    expect(usageSeverity(65, custom)).toBe('warn');
    expect(usageSeverity(86, custom)).toBe('crit');
  });
});

describe('computeOvercommit', () => {
  it('CPU = Σ vCPU alloués / cœurs physiques', () => {
    const r = computeOvercommit(kpis(), DEFAULT_OVERCOMMIT_CONFIG);
    expect(r.cpu.ratio).toBeCloseTo(35 / 24, 5); // ×1.46
    expect(r.cpu.tone).toBe('ok'); // ≤ 2
  });

  it('RAM intègre la provision hôte (10 % de la RAM physique)', () => {
    const r = computeOvercommit(kpis(), DEFAULT_OVERCOMMIT_CONFIG);
    // (80 + 12.8) / 128 = ×0.725
    expect(r.ram.ratio).toBeCloseTo((80 + 12.8) / 128, 5);
    expect(r.ram.tone).toBe('ok'); // ≤ 1
  });

  it('disk = Σ maxdisk / capacité thin', () => {
    const r = computeOvercommit(kpis(), DEFAULT_OVERCOMMIT_CONFIG);
    expect(r.disk.ratio).toBeCloseTo(0.5, 5);
    expect(r.disk.tone).toBe('ok');
  });

  it('sans stockage thin → disk non applicable (na)', () => {
    const r = computeOvercommit(kpis({ diskThinTotalBytes: 0 }), DEFAULT_OVERCOMMIT_CONFIG);
    expect(r.disk.ratio).toBeNull();
    expect(r.disk.tone).toBe('na');
  });

  it('sans capacité physique → ratios non applicables', () => {
    const r = computeOvercommit(kpis({ cpuTotalCores: 0, ramTotalBytes: 0 }), DEFAULT_OVERCOMMIT_CONFIG);
    expect(r.cpu.ratio).toBeNull();
    expect(r.ram.ratio).toBeNull();
  });

  it('provision hôte configurable', () => {
    const cfg: OvercommitConfig = { ...DEFAULT_OVERCOMMIT_CONFIG, hostRamProvisionPct: 0 };
    const r = computeOvercommit(kpis(), cfg);
    expect(r.ram.ratio).toBeCloseTo(80 / 128, 5); // ×0.625 sans provision
  });

  it('niveaux de risque selon les échelles', () => {
    const r = computeOvercommit(kpis(), DEFAULT_OVERCOMMIT_CONFIG);
    expect(r.cpu.tone).toBe('ok'); // ×1.46 ≤ 2
    // 35 → 50 vCPU : ×2.08 → warn ; 96 vCPU : ×4 → warn (borne) ; 97 : crit
    expect(computeOvercommit(kpis({ cpuAllocatedCores: 50 }), DEFAULT_OVERCOMMIT_CONFIG).cpu.tone).toBe('warn');
    expect(computeOvercommit(kpis({ cpuAllocatedCores: 96 }), DEFAULT_OVERCOMMIT_CONFIG).cpu.tone).toBe('warn');
    expect(computeOvercommit(kpis({ cpuAllocatedCores: 97 }), DEFAULT_OVERCOMMIT_CONFIG).cpu.tone).toBe('crit');
    // RAM : 120 Go alloués → (120+12.8)/128 = ×1.0375 → warn ; 140 → ×1.19 → warn ; 150 → ×1.27 → crit
    expect(computeOvercommit(kpis({ ramAllocatedBytes: 120 * GB }), DEFAULT_OVERCOMMIT_CONFIG).ram.tone).toBe('warn');
    expect(computeOvercommit(kpis({ ramAllocatedBytes: 140 * GB }), DEFAULT_OVERCOMMIT_CONFIG).ram.tone).toBe('warn');
    expect(computeOvercommit(kpis({ ramAllocatedBytes: 150 * GB }), DEFAULT_OVERCOMMIT_CONFIG).ram.tone).toBe('crit');
  });
});

describe('riskSeverity (risque dynamique — pire cas p95 7 j)', () => {
  const th = DEFAULT_OVERCOMMIT_CONFIG.risk; // warn ≥ 80 % / ×2 · crit > 100 % / ≥ ×3

  it('🟢 : usage < 80 % et ratio < 2×', () => {
    expect(riskSeverity(50, 1.5, th)).toBe('ok');
    expect(riskSeverity(79.9, 1.99, th)).toBe('ok');
    expect(riskSeverity(0, 0, th)).toBe('ok');
  });

  it('🟠 : usage 80–100 % ou ratio 2–3× (bornes incluses)', () => {
    expect(riskSeverity(80, 1, th)).toBe('warn'); // borne usage
    expect(riskSeverity(50, 2, th)).toBe('warn'); // borne ratio
    expect(riskSeverity(99.9, 2.99, th)).toBe('warn');
  });

  it('🔴 : usage > 100 % ou ratio ≥ 3×', () => {
    expect(riskSeverity(100.1, 1, th)).toBe('crit');
    expect(riskSeverity(50, 3, th)).toBe('crit'); // borne ratio critique
    expect(riskSeverity(150, 4, th)).toBe('crit');
  });

  it('une seule valeur disponible suffit à qualifier', () => {
    expect(riskSeverity(null, 2.5, th)).toBe('warn');
    expect(riskSeverity(90, null, th)).toBe('warn');
    expect(riskSeverity(null, 3, th)).toBe('crit');
    expect(riskSeverity(10, null, th)).toBe('ok');
  });

  it('aucune valeur → na', () => {
    expect(riskSeverity(null, null, th)).toBe('na');
  });

  it('suit aux seuils custom du fichier', () => {
    const custom = { warnPct: 60, critPct: 90, warnRatio: 1.5, critRatio: 2 };
    expect(riskSeverity(65, 1, custom)).toBe('warn');
    expect(riskSeverity(91, 1, custom)).toBe('crit');
    expect(riskSeverity(50, 1.6, custom)).toBe('warn');
    expect(riskSeverity(50, 2, custom)).toBe('crit');
  });
});
