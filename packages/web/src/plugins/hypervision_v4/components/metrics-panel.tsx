import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { LineSeriesOption } from 'echarts/charts';
import type { MetricsTimeframe, MetricsPoint } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { downloadCsvFile } from '../../../lib/monitor-charts';
import { ExportCsvButton } from '../../../core/widgets/export-csv-button';
import { fetchMetrics } from '../../../core/api/apiClient';
import type { MetricsResponse } from '../../../core/api/types';

const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];

/** Mode du graphe — « all » = combiné (CPU + RAM + réseau), sinon un seul élément. */
export type MetricsPanelMetric = 'all' | 'cpu' | 'ram' | 'net';

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

/** En-tête du tooltip — date/heure lisible (et non le timestamp unix brut). */
function tooltipTimeLabel(t: number, tf: MetricsTimeframe): string {
  const d = new Date(t * 1000);
  if (tf === 'hour' || tf === 'day') {
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Export CSV d'un graphe métriques unitaire (on exporte ce qu'on voit). */
function exportClusterCsv(
  data: MetricsResponse | null,
  endpointId: string | undefined,
  tf: MetricsTimeframe,
  metric: 'cpu' | 'ram' | 'net',
): void {
  if (!data || data.points.length === 0) return;
  const cols: { label: string; get: (p: MetricsPoint) => number | null }[] =
    metric === 'cpu'
      ? [{ label: 'cpu_pct', get: (p) => p.cpuPct }]
      : metric === 'ram'
        ? [{ label: 'ram_pct', get: (p) => p.ramPct }]
        : [
            { label: 'net_in_bps', get: (p) => p.netInBps },
            { label: 'net_out_bps', get: (p) => p.netOutBps },
          ];
  const header = ['timestamp', ...cols.map((c) => c.label)];
  const rows = data.points.map((p) => [
    new Date(p.time * 1000).toISOString(),
    ...cols.map((c) => {
      const v = c.get(p);
      return v != null ? String(v) : '';
    }),
  ]);
  const id = endpointId ?? 'cluster';
  downloadCsvFile(`cluster-metrics-${id}-${metric}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

/**
 * CORPS du panneau métriques — switcher de timeframe + badge source + graphe.
 * Autonome (son propre état de timeframe + fetch). Utilisé par la grille v4
 * (widget « metrics » + unitaires CPU/RAM/réseau de la page cluster) ; la
 * version carte `MetricsPanel` l'encapsule dans une Card.
 *
 * `metric` : « all » = combiné (CPU + RAM + réseau, axe double), « cpu »/« ram »
 * = une seule série en %, « net » = rx/tx en o/s (axe unique). L'export CSV
 * n'est proposé que sur les modes unitaires. Le tooltip affiche la date/heure
 * lisible (et non le timestamp unix brut) dans son en-tête.
 */
export function MetricsPanelBody({
  endpointId,
  node,
  metric = 'all',
}: {
  endpointId?: string;
  node?: string;
  metric?: MetricsPanelMetric;
}) {
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
    const isAll = metric === 'all';
    const isNet = metric === 'net';
    const cpuName = t('metrics.cpu');
    const ramName = t('metrics.ram');
    const rxName = t('network.rx');
    const txName = t('network.tx');

    const series: LineSeriesOption[] = [];
    if (isAll || metric === 'cpu') {
      series.push({
        name: cpuName,
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
      });
    }
    if (isAll || metric === 'ram') {
      series.push({
        name: ramName,
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
      });
    }
    if (isAll || isNet) {
      series.push(
        {
          name: rxName,
          type: 'line',
          ...(isAll ? { yAxisIndex: 1 } : {}),
          smooth: true,
          symbol: 'none',
          data: data.points.map((p) => p.netInBps),
          lineStyle: { width: 1.5, color: ct.netIn },
          itemStyle: { color: ct.netIn },
        },
        {
          name: txName,
          type: 'line',
          ...(isAll ? { yAxisIndex: 1 } : {}),
          smooth: true,
          symbol: 'none',
          data: data.points.map((p) => p.netOutBps),
          lineStyle: { width: 1.5, color: ct.netOut },
          itemStyle: { color: ct.netOut },
        },
      );
    }

    // Axes Y — % (0–100) pour CPU/RAM, o/s pour le réseau ; double axe seulement en combiné.
    const yAxis: NonNullable<EChartsOption['yAxis']> = [];
    if (isNet) {
      yAxis.push({
        type: 'value',
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: number) => formatBps(v) },
        splitLine: { lineStyle: { color: ct.splitLine } },
      });
    } else {
      yAxis.push({
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { color: ct.splitLine } },
      });
      if (isAll) {
        yAxis.push({
          type: 'value',
          axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: number) => formatBps(v) },
          splitLine: { show: false },
        });
      }
    }

    return {
      animation: false,
      grid: { top: 32, right: isAll ? 56 : 40, bottom: 24, left: 40 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string | number; seriesName: string; value: number | null; marker: string }>;
          if (!Array.isArray(arr) || arr.length === 0) return '';
          const head = tooltipTimeLabel(Number(arr[0].axisValue), tf);
          const lines = arr.map((p) => {
            const isNetSeries = p.seriesName === rxName || p.seriesName === txName;
            const v =
              typeof p.value === 'number'
                ? isNetSeries
                  ? formatBps(p.value)
                  : `${p.value.toFixed(1)} %`
                : '—';
            return `${p.marker} ${p.seriesName} : ${v}`;
          });
          return `${head}<br/>${lines.join('<br/>')}`;
        },
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 12,
        itemHeight: 3,
        textStyle: { color: ct.legend, fontSize: 11 },
        data: series.map((s) => s.name as string),
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
      yAxis,
      series,
    };
  }, [data, tf, ct, t, metric]);

  const ref = useEChart(option);
  const unitary = metric === 'cpu' || metric === 'ram' || metric === 'net';

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
        <div className="flex items-center gap-1.5">
          {unitary && (
            <ExportCsvButton
              disabled={!data || data.points.length === 0}
              onClick={() => exportClusterCsv(data, endpointId, tf, metric as 'cpu' | 'ram' | 'net')}
            />
          )}
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
