import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import { fetchInfluxHistory } from '../../../core/api/apiClient';
import type { InfluxHistoryRange, InfluxHistoryResponse } from '@prox4u/shared';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Select } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';

const RANGES: InfluxHistoryRange[] = ['24h', '7d', '30d'];

/** Charge l'historique InfluxDB pour un range (cache serveur 5 min). */
function useInfluxHistory(range: InfluxHistoryRange): { data: InfluxHistoryResponse | null; loading: boolean } {
  const [data, setData] = useState<InfluxHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchInfluxHistory(range)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err) => console.warn('chargement influxdb-history en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);
  return { data, loading };
}

/**
 * Débit d'écriture (lignes/s) : delta du compteur monotone enqueued entre buckets.
 * `enqueued = 0` = trou de data (0-fill serveur) → débit non calculable = 0
 * (sinon le delta à la sortie du trou vaudrait le total cumulé → pic artificiel).
 */
function writeRate(points: InfluxHistoryResponse['points']): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t;
    if (dt <= 0) continue;
    const prev = points[i - 1].enqueued;
    const cur = points[i].enqueued;
    const d = prev > 0 && cur > 0 ? cur - prev : 0;
    out.push([points[i].t * 1000, Math.max(0, d / dt)]);
  }
  return out;
}

interface MiniChartProps {
  title: string;
  unit: string;
  series: Array<[number, number]>;
  color: string;
  loading: boolean;
  empty: boolean;
}

/** Graphe de série temporelle compact (1 série). */
function MiniChart({ title, unit, series, color, loading, empty }: MiniChartProps) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);
  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { top: 8, right: 12, bottom: 22, left: 44 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? `${v.toFixed(1)} ${unit}` : String(v)),
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { color: ct.axisLabel, fontSize: 10 },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series: [{ type: 'line', data: series, showSymbol: false, lineStyle: { width: 1.5, color }, areaStyle: { opacity: 0.08, color } }],
    }),
    [series, color, ct, unit],
  );
  const ref = useEChart(option);
  return (
    <Card className="border">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-3">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : empty ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">{t('influxdb.charts.empty')}</div>
        ) : (
          <div ref={ref} className="h-32 w-full" />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 4 graphiques d'historique InfluxDB (file, abandons, latence, débit d'écriture)
 * + sélecteur de fenêtre (24 h / 7 j / 30 j). Données : GET /api/influxdb/history.
 */
export function InfluxHistoryCharts() {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);
  const [range, setRange] = useState<InfluxHistoryRange>('24h');
  const { data, loading } = useInfluxHistory(range);

  const points = data?.points ?? [];
  const empty = !loading && (data?.source !== 'influx' || points.length === 0);
  const queue = useMemo(() => points.map((p) => [p.t * 1000, p.queueDepth] as [number, number]), [points]);
  const dropped = useMemo(() => points.map((p) => [p.t * 1000, p.dropped] as [number, number]), [points]);
  const queryMs = useMemo(() => points.map((p) => [p.t * 1000, p.queryMs] as [number, number]), [points]);
  const rate = useMemo(() => writeRate(points), [points]);

  const sourceNote =
    data?.source === 'disabled' ? t('influxdb.charts.disabled') : data?.source === 'empty' ? t('influxdb.charts.empty') : null;

  return (
    <Card className="border">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">{t('influxdb.charts.title')}</CardTitle>
        <Select
          value={range}
          onChange={(e) => setRange(e.target.value as InfluxHistoryRange)}
          className="h-8 w-28 text-xs"
          aria-label={t('influxdb.charts.range')}
        >
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {t(`influxdb.charts.range.${r}`)}
            </option>
          ))}
        </Select>
      </CardHeader>
      <CardContent className="p-3">
        {sourceNote && !loading && (
          <div className="mb-2 text-xs text-muted-foreground">{sourceNote}</div>
        )}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MiniChart title={t('influxdb.charts.queue')} unit={t('influxdb.charts.unit.lines')} series={queue} color={ct.cpu} loading={loading} empty={empty} />
          <MiniChart title={t('influxdb.charts.dropped')} unit={t('influxdb.charts.unit.lines')} series={dropped} color={ct.disk} loading={loading} empty={empty} />
          <MiniChart title={t('influxdb.charts.queryMs')} unit="ms" series={queryMs} color={ct.ram} loading={loading} empty={empty} />
          <MiniChart title={t('influxdb.charts.rate')} unit={t('influxdb.charts.unit.linesPerSec')} series={rate} color={ct.netIn} loading={loading} empty={empty} />
        </div>
      </CardContent>
    </Card>
  );
}
