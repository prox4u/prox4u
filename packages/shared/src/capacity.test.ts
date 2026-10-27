import { describe, expect, it } from 'vitest';
import { buildForecast, linearRegression } from './capacity.js';

describe('linearRegression', () => {
  it('ajuste exactement une droite', () => {
    const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 1 }));
    const r = linearRegression(pts);
    expect(r.slope).toBeCloseTo(2, 10);
    expect(r.intercept).toBeCloseTo(1, 10);
  });

  it('pente nulle sur série plate', () => {
    const r = linearRegression([0, 1, 2].map((x) => ({ x, y: 5 })));
    expect(r.slope).toBeCloseTo(0, 10);
  });

  it('gère n < 2 points', () => {
    expect(linearRegression([]).slope).toBe(0);
    expect(linearRegression([{ x: 0, y: 7 }]).intercept).toBe(7);
  });
});

describe('buildForecast', () => {
  const day = 86_400;
  const now = 1_700_000_000;

  it('série croissante → jours avant seuil cohérents', () => {
    // 20 → 49 % sur 30 j, pente = 1 %/j → 90 % dans 41 j, 80 % dans 31 j
    const steep = Array.from({ length: 30 }, (_, i) => ({
      time: now - (29 - i) * day,
      value: 20 + i,
    }));
    const f = buildForecast('ram', steep, now);
    expect(f.slopePerDay).toBeCloseTo(1, 5);
    expect(f.daysTo90).toBe(41);
    expect(f.daysTo80).toBe(31);
    expect(f.projection).toHaveLength(30);
  });

  it('série plate ou décroissante → null (pas de saturation)', () => {
    const flat = Array.from({ length: 30 }, (_, i) => ({ time: now - (29 - i) * day, value: 40 }));
    expect(buildForecast('cpu', flat, now).daysTo90).toBeNull();

    const down = Array.from({ length: 30 }, (_, i) => ({ time: now - (29 - i) * day, value: 80 - i }));
    expect(buildForecast('disk', down, now).daysTo90).toBeNull();
  });

  it('moins de 7 jours → insufficientData, pas de projection', () => {
    const short = Array.from({ length: 3 }, (_, i) => ({ time: now - (2 - i) * day, value: 50 + i }));
    const f = buildForecast('ram', short, now);
    expect(f.insufficientData).toBe(true);
    expect(f.projection).toHaveLength(0);
    expect(f.daysTo90).toBeNull();
  });

  it('projection bornée à [0, 100]', () => {
    const steep = Array.from({ length: 30 }, (_, i) => ({ time: now - (29 - i) * day, value: 95 + i / 10 }));
    const f = buildForecast('disk', steep, now);
    for (const p of f.projection) expect(p.value).toBeLessThanOrEqual(100);
  });
});
