import { describe, expect, it } from 'vitest';
import type { MetricsPoint, PveNodeStatus, RrddataPoint } from '@prox4u/shared';
import { mergeStorageSeries, nodeCapacityFromDaily, nodeDailyFromRrd, storagePctByTime } from './routes.js';

const T0 = 1_792_128_000; // jour de référence (epoch seconds)
const T1 = T0 + 86_400;
const DAY = 86_400;

/** Série journalière de n jours, valeurs croissantes (base + step*i). */
function dailySeries(n: number, base: number, step: number) {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * DAY,
    cpuPct: base + step * i,
    ramPct: base + step * i,
    diskPct: base + step * i,
  }));
}

function point(time: number, storagePct: number | null): MetricsPoint {
  return { time, cpuPct: 1.5, ramPct: 2.5, storagePct, netInBps: 10, netOutBps: 20 };
}

describe('storagePctByTime', () => {
  it('pondère par capacité entre endpoints (Σ used / Σ total, pas moyenne simple)', () => {
    const pct = storagePctByTime([
      { t: T0, used: 30, total: 100 }, // endpoint A : 30 %
      { t: T0, used: 5, total: 1_000 }, // endpoint B : 0,5 %
    ]);
    // (30 + 5) / (100 + 1000) = 3,2 % — une moyenne non pondérée donnerait 15,25 %
    expect(pct.get(T0)).toBeCloseTo(3.2, 5);
  });

  it('ignore les buckets sans capacité totale', () => {
    const pct = storagePctByTime([{ t: T0, used: 42, total: 0 }]);
    expect(pct.has(T0)).toBe(false);
  });

  it('traite les valeurs non numériques comme 0 (par champ)', () => {
    const pct = storagePctByTime([
      { t: T0, used: null, total: 100 },
      { t: T0, used: 50, total: null },
    ]);
    // used = 0 + 50, total = 100 + 0 → 50 %
    expect(pct.get(T0)).toBe(50);
  });
});

describe('mergeStorageSeries', () => {
  it('conserve les valeurs legacy si la série storage_metrics est absente', () => {
    const points = [point(T0, 54.1), point(T1, 53.9)];
    expect(mergeStorageSeries(points, [])).toEqual(points);
  });

  it('remplace storagePct par l’usage stockage VM et met à null les buckets sans série', () => {
    const points = [point(T0, 54.1), point(T1, 53.9)];
    const merged = mergeStorageSeries(points, [{ t: T1, used: 29, total: 100 }]);
    expect(merged[0].storagePct).toBeNull(); // T0 : pas de série → null (pas de mélange rootfs)
    expect(merged[1].storagePct).toBe(29);
    // les autres champs sont intacts
    expect(merged[1].cpuPct).toBe(1.5);
    expect(merged[1].netInBps).toBe(10);
  });
});

describe('nodeCapacityFromDaily', () => {
  it('construit 3 prévisions (cpu/ram/disk) et conserve la source', () => {
    const res = nodeCapacityFromDaily(dailySeries(10, 20, 1), 'influx');
    expect(res.source).toBe('influx');
    expect(res.cpu.metric).toBe('cpu');
    expect(res.ram.metric).toBe('ram');
    expect(res.disk.metric).toBe('disk');
    // 10 jours d'historique → projection fiable (30 pts), historique conservé
    expect(res.cpu.insufficientData).toBe(false);
    expect(res.cpu.projection).toHaveLength(30);
    expect(res.cpu.history).toHaveLength(10);
    // pente positive (valeurs croissantes) → daysTo90 calculée
    expect(res.cpu.slopePerDay).toBeGreaterThan(0);
    expect(res.cpu.daysTo90).not.toBeNull();
  });

  it('moins de 7 jours → insufficientData (pas de projection fiable)', () => {
    const res = nodeCapacityFromDaily(dailySeries(3, 20, 1), 'influx');
    expect(res.cpu.insufficientData).toBe(true);
    expect(res.cpu.projection).toHaveLength(0);
    expect(res.cpu.daysTo90).toBeNull();
  });

  it('série vide → tout est insufficientData, source rrd', () => {
    const res = nodeCapacityFromDaily([], 'rrd');
    expect(res.source).toBe('rrd');
    expect(res.cpu.insufficientData).toBe(true);
    expect(res.ram.insufficientData).toBe(true);
    expect(res.disk.insufficientData).toBe(true);
  });
});

describe('nodeDailyFromRrd', () => {
  const node: PveNodeStatus = {
    node: 'proxmox',
    online: true,
    cpu: null,
    cpus: 8,
    memTotal: 1000,
    memUsed: null,
    swapTotal: null,
    swapUsed: null,
    loadavg: null,
    uptime: null,
    rootfsTotal: 2000,
    rootfsUsed: null,
    netin: null,
    netout: null,
  };

  it('convertit cpu (fraction ×100), ram (mem/memTotal), disk (rootfs/rootfsTotal)', () => {
    const points: RrddataPoint[] = [
      { time: T0, cpu: 0.5, mem: 250, disk: 500, netin: 0, netout: 0 },
    ];
    const days = nodeDailyFromRrd(points, node);
    expect(days).toHaveLength(1);
    expect(days[0].cpuPct).toBe(50); // 0.5 × 100
    expect(days[0].ramPct).toBe(25); // 250 / 1000 × 100
    expect(days[0].diskPct).toBe(25); // 500 / 2000 × 100
  });

  it('moyenne les points d’une même journée et trie par jour', () => {
    const points: RrddataPoint[] = [
      // jour 2 (T1) d'abord dans l'entrée → le résultat doit être trié
      { time: T1, cpu: 0.8, mem: 400, disk: 800, netin: 0, netout: 0 },
      // jour 1 (T0) : deux points → moyenne
      { time: T0 + 3600, cpu: 0.2, mem: 100, disk: 200, netin: 0, netout: 0 },
      { time: T0 + 7200, cpu: 0.4, mem: 300, disk: 400, netin: 0, netout: 0 },
    ];
    const days = nodeDailyFromRrd(points, node);
    expect(days).toHaveLength(2);
    expect(days[0].time).toBe(Math.floor(T0 / DAY) * DAY);
    // cpu : (20 + 40) / 2 = 30 ; ram : (10 + 30) / 2 = 20 ; disk : (10 + 20) / 2 = 15
    expect(days[0].cpuPct).toBe(30);
    expect(days[0].ramPct).toBe(20);
    expect(days[0].diskPct).toBe(15);
    expect(days[1].cpuPct).toBe(80);
  });

  it('ignore les champs null (pas de contamination de la moyenne)', () => {
    const points: RrddataPoint[] = [
      { time: T0, cpu: null, mem: 500, disk: null, netin: 0, netout: 0 },
      { time: T0 + 3600, cpu: 0.5, mem: null, disk: 1000, netin: 0, netout: 0 },
    ];
    const days = nodeDailyFromRrd(points, node);
    expect(days).toHaveLength(1);
    // cpu : seul le 2e point compte → 50 ; ram : seul le 1er → 50 ; disk : seul le 2e → 50
    expect(days[0].cpuPct).toBe(50);
    expect(days[0].ramPct).toBe(50);
    expect(days[0].diskPct).toBe(50);
  });

  it('capacité nulle (memTotal/rootfsTotal) → métrique ignorée', () => {
    const noCap: PveNodeStatus = { ...node, memTotal: null, rootfsTotal: null };
    const points: RrddataPoint[] = [
      { time: T0, cpu: 0.5, mem: 500, disk: 500, netin: 0, netout: 0 },
    ];
    const days = nodeDailyFromRrd(points, noCap);
    expect(days[0].cpuPct).toBe(50);
    expect(days[0].ramPct).toBe(0); // pas de memTotal → ignoré → 0
    expect(days[0].diskPct).toBe(0); // pas de rootfsTotal → ignoré → 0
  });
});
