import { CapacityForecast, CapacityMetric } from './types.js';

export interface RegressionResult {
  /** pente (unités de y par unité de x) */
  slope: number;
  intercept: number;
}

/** Régression linéaire par moindres carrés. */
export function linearRegression(points: { x: number; y: number }[]): RegressionResult {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0 };

  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxy += p.x * p.y;
    sxx += p.x * p.x;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Prévision de saturation à partir d'une série de moyennes journalières
 * exprimées en % de la capacité.
 *
 * - régression linéaire (moindres carrés) sur les 30 derniers jours
 * - jours avant seuil = (seuil − valeur courante) / pente  (null si pente ≤ 0)
 * - projection : 30 jours, bornée à [0, 100]
 */
export function buildForecast(
  metric: CapacityMetric,
  dailyHistory: { time: number; value: number }[],
  now: number = Date.now(),
): CapacityForecast {
  if (dailyHistory.length < 7) {
    return {
      metric,
      insufficientData: true,
      history: dailyHistory,
      slopePerDay: 0,
      daysTo80: null,
      daysTo90: null,
      projection: [],
    };
  }

  const points = dailyHistory.map((p, i) => ({ x: i, y: p.value }));
  const { slope } = linearRegression(points);
  const last = dailyHistory.length > 0 ? dailyHistory[dailyHistory.length - 1].value : 0;

  const daysTo = (threshold: number): number | null => {
    if (slope <= 0.001) return null;
    const d = (threshold - last) / slope;
    return d < 0 ? null : Math.round(d);
  };

  const lastTime = dailyHistory.length > 0 ? dailyHistory[dailyHistory.length - 1].time : now;
  const daySec = 86_400;
  const projection = Array.from({ length: 30 }, (_, i) => ({
    time: lastTime + (i + 1) * daySec,
    value: Math.round(clamp(last + slope * (i + 1), 0, 100) * 10) / 10,
  }));

  return {
    metric,
    insufficientData: false,
    history: dailyHistory,
    slopePerDay: Math.round(slope * 1000) / 1000,
    daysTo80: daysTo(80),
    daysTo90: daysTo(90),
    projection,
  };
}
