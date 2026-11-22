import {
  DEFAULT_HEALTH_CONFIG,
  HealthPenalty,
  HealthScore,
  KpiSummary,
  NodeHealth,
  PraReport,
  type HealthConfig,
  type QdeviceState,
  type QuorumState,
} from './types.js';

/**
 * Formule déterministe du Health Score (documentée).
 *
 *   score = 100 − Σ pénalités, borné à [0, 100]
 *
 * Pénalités (défauts — ajustables via `health.json`, hot-reload) :
 *   - nœud hors ligne            : −25 par nœud
 *   - quorum cluster perdu       : −25   (guests actifs mais cluster en lecture seule)
 *   - Qdevice hors ligne         : −10   (quorum non protégé si un nœud tombe — risque)
 *   - CPU cluster  > crit %      : −20   (ou ≥ warn % : −10)
 *   - RAM cluster  > crit %      : −20   (ou ≥ warn % : −10)
 *   - pire stockage > crit %     : −15   (ou ≥ warn % : −8)
 *   - PRA critique / vigilance   : −20 / −10  (« na » : 0)
 *
 * Libellés (défauts) :  ≥ 80 Nominal · 50–79 Dégradé · < 50 Critique
 *
 * Les seuils et pénalités proviennent de `config` (défaut : `DEFAULT_HEALTH_CONFIG`).
 * Le seuil effectif est porté dans les `params` des constats → les libellés i18n
 * restent vrais si l'utilisateur change les seuils dans `health.json`.
 */
export function computeHealthScore(
  nodes: NodeHealth[],
  kpis: KpiSummary,
  pra: PraReport,
  cluster?: { quorum: number | null; quorumState: QuorumState | null; qdevice?: QdeviceState },
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
): HealthScore {
  const { thresholds: t, penalties: p } = config;
  const penalties: HealthPenalty[] = [];

  for (const n of nodes) {
    if (!n.online) {
      penalties.push({ reasonKey: 'health.penalty.nodeDown', params: { node: n.node }, points: p.nodeDown });
    }
  }

  if (cluster?.quorumState === 'lost') {
    penalties.push({
      reasonKey: 'health.penalty.quorumLost',
      params: { online: nodes.filter((n) => n.online).length, total: nodes.length },
      points: p.quorumLost,
    });
  }

  // Qdevice configuré mais hors ligne : le quorum n'est plus protégé (si un
  // nœud tombe ensuite, le quorum est perdu). Pénalité « risque » (−10, même
  // poids que praWarn) — pas d'incident immédiat tant que le quorum tient.
  if (cluster?.qdevice === 'down') {
    penalties.push({ reasonKey: 'health.penalty.qdeviceDown', points: p.qdeviceDown });
  }

  const resourcePenalty = (pct: number, critKey: string, warnKey: string, critPts: number, warnPts: number) => {
    if (pct > t.crit)
      penalties.push({ reasonKey: critKey, params: { pct: Math.round(pct), threshold: t.crit }, points: critPts });
    else if (pct >= t.warn)
      penalties.push({ reasonKey: warnKey, params: { pct: Math.round(pct), threshold: t.warn }, points: warnPts });
  };

  resourcePenalty(kpis.cpuPct, 'health.penalty.cpuCrit', 'health.penalty.cpuWarn', p.cpuCrit, p.cpuWarn);
  resourcePenalty(kpis.ramPct, 'health.penalty.ramCrit', 'health.penalty.ramWarn', p.ramCrit, p.ramWarn);

  if (kpis.storagePct > t.crit) {
    penalties.push({
      reasonKey: 'health.penalty.diskCrit',
      params: { pct: Math.round(kpis.storagePct), threshold: t.crit },
      points: p.diskCrit,
    });
  } else if (kpis.storagePct >= t.warn) {
    penalties.push({
      reasonKey: 'health.penalty.diskWarn',
      params: { pct: Math.round(kpis.storagePct), threshold: t.warn },
      points: p.diskWarn,
    });
  }

  if (pra.globalSeverity === 'crit') {
    penalties.push({ reasonKey: 'health.penalty.praCrit', points: p.praCrit });
  } else if (pra.globalSeverity === 'warn') {
    penalties.push({ reasonKey: 'health.penalty.praWarn', points: p.praWarn });
  }

  const score = Math.max(0, Math.min(100, 100 - penalties.reduce((s, x) => s + x.points, 0)));
  const label =
    score >= t.healthNominal ? 'nominal' : score >= t.healthDegraded ? 'degraded' : 'critical';

  return { score, label, penalties };
}
