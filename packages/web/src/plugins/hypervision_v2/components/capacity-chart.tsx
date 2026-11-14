import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { LineSeriesOption } from 'echarts/charts';
import type { CapacityMetric } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { useEChart } from '../../../hooks/use-echart';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import type { CapacityResponse } from '../../../core/api/types';

const COLORS: Record<CapacityMetric, string> = { cpu: '#3b82f6', ram: '#8b5cf6', disk: '#0ea5e9' };

function dayLabel(t: number): string {
  return new Date(t * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

export function CapacityChart({ capacity }: { capacity: CapacityResponse | null }) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();

  const option = useMemo<EChartsOption | null>(() => {
    if (!capacity) return null;
    const metrics: CapacityMetric[] = ['cpu', 'ram', 'disk'];
    const allTimes = new Set<number>();
    for (const m of metrics) {
      for (const p of capacity[m].history) allTimes.add(p.time);
      for (const p of capacity[m].projection) allTimes.add(p.time);
    }
    const times = [...allTimes].sort((a, b) => a - b);

    const round = (v: number | undefined) => (v === undefined ? null : Number(v.toFixed(1)));

    const series: LineSeriesOption[] = metrics.flatMap((m) => {
      const fc = capacity[m];
      const histMap = new Map(fc.history.map((p) => [p.time, p.value]));
      const projMap = new Map(fc.projection.map((p) => [p.time, p.value]));
      return [
        {
          name: t(`capacity.${m}`),
          type: 'line',
          data: times.map((tm) => round(histMap.get(tm))),
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 2, color: COLORS[m] },
          itemStyle: { color: COLORS[m] },
        },
        {
          name: `${t(`capacity.${m}`)} (${t('capacity.projection')})`,
          type: 'line',
          data: times.map((tm) => round(projMap.get(tm))),
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 2, type: 'dashed', color: COLORS[m], opacity: 0.6 },
          itemStyle: { color: COLORS[m] },
        },
      ];
    });

    // bandes de seuils d'usage (overcommit.json) sur la première série
    const { warnPct, critPct } = config.usage;
    series[0].markArea = {
      silent: true,
      data: [
        [{ yAxis: warnPct, itemStyle: { color: 'rgba(245,158,11,0.07)' } }, { yAxis: critPct }],
        [{ yAxis: critPct, itemStyle: { color: 'rgba(239,68,68,0.09)' } }, { yAxis: 100 }],
      ],
    };

    return {
      grid: { left: 40, right: 16, top: 32, bottom: 28 },
      tooltip: { trigger: 'axis', valueFormatter: (v) => `${Number(v).toFixed(1)} %` },
      legend: {
        top: 0,
        data: metrics.map((m) => t(`capacity.${m}`)),
        textStyle: { fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: times.map(dayLabel),
        axisLabel: { fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { formatter: '{value} %', fontSize: 10 },
      },
      series,
    };
  }, [capacity, t, config]);

  const ref = useEChart(option);

  return (
    <Card>
      <CardHeader draggable>
        <CardTitle>{t('capacity.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {capacity ? (
          <>
            <div ref={ref} className="h-52 w-full" />
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {(['cpu', 'ram', 'disk'] as CapacityMetric[]).map((m) => {
                const fc = capacity[m];
                return (
                  <div key={m} className="rounded-lg border p-2 text-xs">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold">{t(`capacity.${m}`)}</span>
                      {fc.insufficientData ? (
                        <Badge tone="default">—</Badge>
                      ) : fc.daysTo90 !== null ? (
                        <Badge tone={fc.daysTo90 < 30 ? 'crit' : fc.daysTo90 < 90 ? 'warn' : 'ok'}>
                          {t('capacity.daysTo90', { days: fc.daysTo90 })}
                        </Badge>
                      ) : (
                        <Badge tone="ok">{t('capacity.stable')}</Badge>
                      )}
                    </div>
                    <span className="text-muted-foreground">
                      {fc.insufficientData
                        ? 'historique insuffisant (< 7 j)'
                        : `pente ${fc.slopePerDay >= 0 ? '+' : ''}${fc.slopePerDay.toFixed(2)} %/j`}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">…</div>
        )}
      </CardContent>
    </Card>
  );
}
