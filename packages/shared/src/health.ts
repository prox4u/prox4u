import {
  HealthPenalty,
  HealthScore,
  KpiSummary,
  NodeHealth,
  PraReport,
  THRESHOLDS,
  type QdeviceState,
  type QuorumState,
} from './types.js';

/**
 * Formule déterministe du Health Score (documentée).
 *
 *   score = 100 − Σ pénalités, borné à [0, 100]
 *
 * Pénalités :
 *   - nœud hors ligne            : −25 par nœud
 *   - quorum cluster perdu       : −25   (guests actifs mais cluster en lecture seule)
 *   - Qdevice hors ligne         : −10   (quorum non protégé si un nœud tombe — risque)
 *   - CPU cluster  > 90 %        : −20   (ou > 80 % : −10)
 *   - RAM cluster  > 90 %        : −20   (ou > 80 % : −10)
 *   - pire stockage > 90 %       : −15   (ou > 80 % : −8)
 *   - PRA critique / vigilance   : −20 / −10  (« na » : 0)
 *
 * Libellés :  ≥ 80 Nominal · 50–79 Dégradé · < 50 Critique
 */
export function computeHealthScore(
  nodes: NodeHealth[],
  kpis: KpiSummary,
  pra: PraReport,
  cluster?: { quorum: number | null; quorumState: QuorumState | null; qdevice?: QdeviceState },
): HealthScore {
  const penalties: HealthPenalty[] = [];

  for (const n of nodes) {
    if (!n.online) {
      penalties.push({ reasonKey: 'health.penalty.nodeDown', params: { node: n.node }, points: 25 });
    }
  }

  if (cluster?.quorumState === 'lost') {
    penalties.push({
      reasonKey: 'health.penalty.quorumLost',
      params: { online: nodes.filter((n) => n.online).length, total: nodes.length },
      points: 25,
    });
  }

  // Qdevice configuré mais hors ligne : le quorum n'est plus protégé (si un
  // nœud tombe ensuite, le quorum est perdu). Pénalité « risque » (−10, même
  // poids que praWarn) — pas d'incident immédiat tant que le quorum tient.
  if (cluster?.qdevice === 'down') {
    penalties.push({ reasonKey: 'health.penalty.qdeviceDown', points: 10 });
  }

  const resourcePenalty = (pct: number, critKey: string, warnKey: string) => {
    if (pct > THRESHOLDS.crit) penalties.push({ reasonKey: critKey, params: { pct: Math.round(pct) }, points: 20 });
    else if (pct >= THRESHOLDS.warn) penalties.push({ reasonKey: warnKey, params: { pct: Math.round(pct) }, points: 10 });
  };

  resourcePenalty(kpis.cpuPct, 'health.penalty.cpuCrit', 'health.penalty.cpuWarn');
  resourcePenalty(kpis.ramPct, 'health.penalty.ramCrit', 'health.penalty.ramWarn');

  if (kpis.storagePct > THRESHOLDS.crit) {
    penalties.push({ reasonKey: 'health.penalty.diskCrit', params: { pct: Math.round(kpis.storagePct) }, points: 15 });
  } else if (kpis.storagePct >= THRESHOLDS.warn) {
    penalties.push({ reasonKey: 'health.penalty.diskWarn', params: { pct: Math.round(kpis.storagePct) }, points: 8 });
  }

  if (pra.globalSeverity === 'crit') {
    penalties.push({ reasonKey: 'health.penalty.praCrit', points: 20 });
  } else if (pra.globalSeverity === 'warn') {
    penalties.push({ reasonKey: 'health.penalty.praWarn', points: 10 });
  }

  const score = Math.max(0, Math.min(100, 100 - penalties.reduce((s, p) => s + p.points, 0)));
  const label =
    score >= THRESHOLDS.healthNominal ? 'nominal' : score >= THRESHOLDS.healthDegraded ? 'degraded' : 'critical';

  return { score, label, penalties };
}
