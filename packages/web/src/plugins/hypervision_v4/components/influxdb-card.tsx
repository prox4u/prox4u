import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { EChartsOption } from 'echarts';
import type { InfluxHistoryResponse, InfluxStatus } from '@prox4u/shared';
import { fetchInfluxHistory } from '../../../core/api/apiClient';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';

/** Charge l'historique 24 h (cache serveur 5 min) — refresh 5 min. */
function useInfluxHistory24h(): { data: InfluxHistoryResponse | null; loading: boolean } {
  const [data, setData] = useState<InfluxHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchInfluxHistory('24h')
        .then((r) => {
          if (!cancelled) setData(r);
        })
        .catch((err) => console.warn('chargement influxdb-history (overview) en échec', err))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const id = setInterval(load, 300_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return { data, loading };
}

/**
 * Widget « InfluxDB » de la vue d'ensemble (v4) — santé de la base de métriques.
 * Live : multi.influx (WS, zéro API) ; mini-graphe 24 h : /api/influxdb/history.
 * Clic → page /influxdb.
 */
export function InfluxDbBody({ status }: { status: InfluxStatus | null }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);
  const { data, loading } = useInfluxHistory24h();

  const points = data?.points ?? [];
  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { top: 16, right: 12, bottom: 22, left: 40 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
      },
      legend: { top: 0, textStyle: { color: ct.legend, fontSize: 10 } },
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
      series: [
        {
          name: t('influxdb.charts.queue'),
          type: 'line',
          data: points.map((p) => [p.t * 1000, p.queueDepth]),
          showSymbol: false,
          lineStyle: { width: 1.5, color: ct.cpu },
          itemStyle: { color: ct.cpu },
        },
        {
          name: t('influxdb.charts.dropped'),
          type: 'line',
          data: points.map((p) => [p.t * 1000, p.dropped]),
          showSymbol: false,
          lineStyle: { width: 1.5, color: ct.disk },
          itemStyle: { color: ct.disk },
        },
      ],
    }),
    [points, ct, t],
  );
  const ref = useEChart(option);

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-sm text-muted-foreground">
        {t('influxdb.charts.disabled')}
      </div>
    );
  }

  const headroomTone = status.headroom === 'crit' ? 'crit' : status.headroom === 'warn' ? 'warn' : 'ok';

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">{t('influxdb.kpi.queue')}</div>
          <div className="font-semibold tabular-nums">{status.queueDepth}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{t('influxdb.kpi.dropped')}</div>
          <div className={`font-semibold tabular-nums ${status.dropped > 0 ? 'text-warn' : ''}`}>{status.dropped}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{t('influxdb.kpi.headroom')}</div>
          <div className="font-semibold">
            <Badge tone={headroomTone}>{t(`influxdb.headroom.${status.headroom}`)}</Badge>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : points.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t('influxdb.charts.empty')}
          </div>
        ) : (
          <div ref={ref} className="h-full w-full" />
        )}
      </div>
      <Link to="/influxdb" className="text-xs text-primary hover:underline">
        {t('influxdb.title')} →
      </Link>
    </div>
  );
}
