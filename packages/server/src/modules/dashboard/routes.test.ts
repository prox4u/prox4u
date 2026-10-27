import { describe, expect, it } from 'vitest';
import type { MetricsPoint } from '@prox4u/shared';
import { mergeStorageSeries, storagePctByTime } from './routes.js';

const T0 = 1_792_128_000; // jour de référence (epoch seconds)
const T1 = T0 + 86_400;

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
