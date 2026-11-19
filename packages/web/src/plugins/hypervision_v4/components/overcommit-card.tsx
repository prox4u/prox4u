import { useTranslation } from 'react-i18next';
import type { KpiSummary, OvercommitConfig, OvercommitMetric, SeverityOrNa } from '@prox4u/shared';
import { computeOvercommit } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Progress } from '../../../components/ui/progress';
import { formatBytes } from '../../../lib/utils';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useDashboard } from '../../../core/data/dashboard';

/** Échelle de la barre : pleine à 2× la borne critique (la surallocation est une pratique normale). */
function barMax(scale: OvercommitConfig['cpu']): number {
  return scale.warnMax * 2;
}

function toneColor(tone: SeverityOrNa): string {
  return tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'text-foreground';
}

/** Ligne « pire cas (p95 7 j) » — teinte = sévérité du risque dynamique. */
function RiskLine({ risk }: { risk?: { usagePct: number | null; severity: SeverityOrNa } }) {
  const { t } = useTranslation();
  if (!risk || risk.usagePct === null) return null;
  const color = risk.severity === 'crit' ? 'text-crit' : risk.severity === 'warn' ? 'text-warn' : 'text-ok';
  return (
    <div className={`text-[11px] tabular-nums ${color}`}>
      {t('overcommit.riskLine', { pct: risk.usagePct.toFixed(0) })}
    </div>
  );
}

function RatioBlock({ label, metric, scale, detail, risk }: { label: string; metric: OvercommitMetric; scale: OvercommitConfig['cpu']; detail: string; risk?: { usagePct: number | null; severity: SeverityOrNa } }) {
  const tone = metric.tone;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={`text-xl font-semibold tabular-nums ${toneColor(tone)}`}>
          {metric.ratio === null ? '—' : `×${metric.ratio.toFixed(1)}`}
        </span>
      </div>
      <Progress value={metric.ratio === null ? 0 : Math.min(metric.ratio / barMax(scale), 1) * 100} tone={tone === 'na' ? 'default' : tone} className="h-1.5" />
      <div className="text-[11px] text-muted-foreground">{detail}</div>
      <RiskLine risk={risk} />
    </div>
  );
}

/** CORPS de la carte surallocation — 3 blocs de ratio (le badge « données
 *  insuffisantes » est porté par le slot `extra` du widget dans la grille v4). */
export function OvercommitCardBody({ kpis, endpointId }: { kpis: KpiSummary; endpointId?: string }) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const report = computeOvercommit(kpis, config);
  const risk = useDashboard((s) => (endpointId ? s.risk[endpointId] : undefined));

  return (
    <div className="grid h-full grid-cols-1 content-start gap-4 overflow-y-auto sm:grid-cols-3">
        <RatioBlock
          label={t('metrics.cpu')}
          metric={report.cpu}
          scale={config.cpu}
          risk={risk?.cpu}
          detail={
            report.cpu.ratio === null
              ? '—'
              : t('overcommit.allocCores', { alloc: kpis.cpuAllocatedCores, cap: kpis.cpuTotalCores })
          }
        />
        <RatioBlock
          label={t('metrics.ram')}
          metric={report.ram}
          scale={config.ram}
          detail={
            report.ram.ratio === null
              ? '—'
              : t('overcommit.allocRam', {
                  alloc: formatBytes(kpis.ramAllocatedBytes + (config.hostRamProvisionPct / 100) * kpis.ramTotalBytes),
                  cap: formatBytes(kpis.ramTotalBytes),
                })
          }
          risk={risk?.ram}
        />
        <RatioBlock
          label={t('metrics.disk')}
          metric={report.disk}
          scale={config.disk}
          detail={
            report.disk.ratio === null
              ? t('overcommit.diskNa')
              : t('overcommit.allocDisk', { alloc: formatBytes(kpis.diskThinAllocatedBytes), cap: formatBytes(kpis.diskThinTotalBytes) })
          }
          risk={risk?.storage}
        />
    </div>
  );
}

export function OvercommitCard({ kpis, endpointId }: { kpis: KpiSummary; endpointId?: string }) {
  const { t } = useTranslation();
  const risk = useDashboard((s) => (endpointId ? s.risk[endpointId] : undefined));
  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between gap-2">
        <CardTitle>{t('overcommit.title')}</CardTitle>
        {risk?.insufficientData && (
          <span className="text-[11px] text-muted-foreground">{t('overcommit.insufficientData')}</span>
        )}
      </CardHeader>
      <CardContent>
        <OvercommitCardBody kpis={kpis} endpointId={endpointId} />
      </CardContent>
    </Card>
  );
}
