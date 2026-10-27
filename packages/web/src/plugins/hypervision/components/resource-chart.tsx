import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { KpiSummary, Severity } from '@prox4u/shared';
import { computeOvercommit, usageSeverity } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { fetchMetrics } from '../../../core/api/apiClient';
import type { MetricsResponse } from '../../../core/api/types';

export type ResourceMetric = 'cpu' | 'ram' | 'storage';

/** Couleur d'aire = sévérité de l'usage courant (code couleur 🟢🟠🔴 cohérent). */
const SEV_COLOR: Record<Severity, string> = { ok: '#10b981', warn: '#f59e0b', crit: '#ef4444' };
/** Ligne d'allocation : indigo pointillés (distingue l'alloué de l'usage réel). */
const ALLOC_COLOR = '#6366f1';

function timeLabel(t: number): string {
  return new Date(t * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/**
 * Graphe ressource en tête de dashboard (7 jours) :
 * - aire = usage réel (couleur = sévérité de l'usage courant) ;
 * - ligne pointillée indigo = allocation % (alloué / physique) ;
 * - bandes de fond = seuils d'usage d'overcommit.json.
 * `endpointId` absent → agrégat de tous les endpoints (vue d'ensemble).
 */
export function ResourceChart({ metric, endpointId, kpis }: { metric: ResourceMetric; endpointId?: string; kpis: KpiSummary }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const config = useOvercommitConfig();
  const [data, setData] = useState<MetricsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMetrics('week', endpointId ?? 'all')
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement graphe ressource en échec', err));
    return () => {
      cancelled = true;
    };
  }, [endpointId]);

  const ct = chartTheme(theme);
  const current = metric === 'cpu' ? kpis.cpuPct : metric === 'ram' ? kpis.ramPct : kpis.storagePct;
  const sev = usageSeverity(current, config);

  /** Allocation % (alloué / physique) — canon computeOvercommit() ; null si non applicable. */
  const allocPct = useMemo(() => {
    const report = computeOvercommit(kpis, config);
    const ratio = metric === 'cpu' ? report.cpu.ratio : metric === 'ram' ? report.ram.ratio : report.disk.ratio;
    return ratio === null ? null : ratio * 100;
  }, [metric, kpis, config]);

  const option = useMemo<EChartsOption | null>(() => {
    if (!data || data.points.length === 0) return null;
    const times = data.points.map((p) => p.time);
    const values = data.points.map((p) => (metric === 'cpu' ? p.cpuPct : metric === 'ram' ? p.ramPct : p.storagePct));
    const color = SEV_COLOR[sev];
    return {
      animation: false,
      grid: { top: 24, right: 16, bottom: 20, left: 36 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? `${v.toFixed(1)} %` : String(v)),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: times,
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: string) => timeLabel(Number(v)) },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series: [
        {
          name: t(`metrics.${metric === 'storage' ? 'disk' : metric}`),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: values,
          lineStyle: { width: 2, color },
          itemStyle: { color },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${color}55` },
                { offset: 1, color: `${color}00` },
              ],
            },
          },
          // bandes de seuils d'usage (overcommit.json) — fond très discret
          markArea: {
            silent: true,
            data: [
              [{ yAxis: 0, itemStyle: { color: '#10b981', opacity: 0.05 } }, { yAxis: config.usage.warnPct }],
              [{ yAxis: config.usage.warnPct, itemStyle: { color: '#f59e0b', opacity: 0.07 } }, { yAxis: config.usage.critPct }],
              [{ yAxis: config.usage.critPct, itemStyle: { color: '#ef4444', opacity: 0.08 } }, { yAxis: 100 }],
            ],
          },
          // ligne d'allocation (pointillés indigo) — bornée à l'axe si > 100 %
          markLine:
            allocPct !== null
              ? {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { type: 'dashed', color: ALLOC_COLOR, width: 1.5 },
                  label: {
                    formatter: `${t('res.alloc')} ${Math.round(allocPct)} %`,
                    color: ALLOC_COLOR,
                    fontSize: 10,
                    position: 'insideEndTop',
                  },
                  data: [{ yAxis: Math.min(allocPct, 99) }],
                }
              : undefined,
        },
      ],
    };
  }, [data, metric, sev, allocPct, ct, t, config]);

  const ref = useEChart(option);
  const hasData = !!data && data.points.length > 0;

  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between gap-2">
        <CardTitle>
          {t(`metrics.${metric === 'storage' ? 'disk' : metric}`)} — {t('res.window')}
        </CardTitle>
        <span className={`text-sm font-semibold tabular-nums ${sev === 'crit' ? 'text-crit' : sev === 'warn' ? 'text-warn' : 'text-ok'}`}>
          {current.toFixed(0)} %
        </span>
      </CardHeader>
      <CardContent className="flex flex-col">
        {!hasData ? (
          <Skeleton className="min-h-[140px] w-full flex-1" />
        ) : (
          <div ref={ref} className="min-h-[140px] w-full flex-1" />
        )}
      </CardContent>
    </Card>
  );
}
