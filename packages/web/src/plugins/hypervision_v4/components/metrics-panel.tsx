import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { MetricsTimeframe } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { fetchMetrics } from '../../../core/api/apiClient';
import type { MetricsResponse } from '../../../core/api/types';

const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];

function formatBps(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} Go/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mo/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} Ko/s`;
  return `${v} o/s`;
}

function timeLabel(t: number, tf: MetricsTimeframe): string {
  const d = new Date(t * 1000);
  if (tf === 'hour' || tf === 'day') {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/**
 * CORPS du panneau métriques — switcher de timeframe + badge source + graphe.
 * Autonome (son propre état de timeframe + fetch). Utilisé par la grille v4
 * (widget « metrics » de la page cluster) ; la version carte `MetricsPanel`
 * l'encapsule dans une Card.
 */
export function MetricsPanelBody({ endpointId, node }: { endpointId?: string; node?: string }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const [tf, setTf] = useState<MetricsTimeframe>('hour');
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchMetrics(tf, endpointId, node)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement métriques en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tf, endpointId, node]);

  const ct = chartTheme(theme);

  const option = useMemo<EChartsOption | null>(() => {
    if (!data || data.points.length === 0) return null;
    const times = data.points.map((p) => p.time);
    return {
      animation: false,
      grid: { top: 32, right: 56, bottom: 24, left: 40 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? `${v.toFixed(1)} %` : String(v)),
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 12,
        itemHeight: 3,
        textStyle: { color: ct.legend, fontSize: 11 },
        data: [t('metrics.cpu'), t('metrics.ram')],
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: times,
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: {
          color: ct.axisLabel,
          fontSize: 10,
          formatter: (v: string) => timeLabel(Number(v), tf),
        },
      },
      yAxis: [
        {
          type: 'value',
          min: 0,
          max: 100,
          axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: '{value} %' },
          splitLine: { lineStyle: { color: ct.splitLine } },
        },
        {
          type: 'value',
          axisLabel: {
            color: ct.axisLabel,
            fontSize: 10,
            formatter: (v: number) => formatBps(v),
          },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: t('metrics.cpu'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: data.points.map((p) => p.cpuPct),
          lineStyle: { width: 2, color: ct.cpu },
          itemStyle: { color: ct.cpu },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${ct.cpu}55` },
                { offset: 1, color: `${ct.cpu}00` },
              ],
            },
          },
        },
        {
          name: t('metrics.ram'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: data.points.map((p) => p.ramPct),
          lineStyle: { width: 2, color: ct.ram },
          itemStyle: { color: ct.ram },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${ct.ram}44` },
                { offset: 1, color: `${ct.ram}00` },
              ],
            },
          },
        },
        {
          name: t('network.rx'),
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: data.points.map((p) => p.netInBps),
          lineStyle: { width: 1.5, color: ct.netIn },
          itemStyle: { color: ct.netIn },
        },
        {
          name: t('network.tx'),
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: data.points.map((p) => p.netOutBps),
          lineStyle: { width: 1.5, color: ct.netOut },
          itemStyle: { color: ct.netOut },
        },
      ],
    };
  }, [data, tf, ct, t]);

  const ref = useEChart(option);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {data && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                data.source === 'influx' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
              }`}
            >
              {t(`metrics.source.${data.source}`)}
            </span>
          )}
        </div>
        <div className="flex rounded-lg border bg-secondary p-0.5">
          {TIMEFRAMES.map((x) => (
            <button
              key={x}
              onClick={() => setTf(x)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                tf === x ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`metrics.tf.${x}`)}
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <Skeleton className="min-h-[200px] w-full flex-1" />
      ) : (
        <div ref={ref} className={`min-h-[200px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

export function MetricsPanel({ endpointId, node }: { endpointId?: string; node?: string }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader draggable>
        <CardTitle>{node ? t('metrics.titleNode') : t('metrics.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col">
        <MetricsPanelBody endpointId={endpointId} node={node} />
      </CardContent>
    </Card>
  );
}
