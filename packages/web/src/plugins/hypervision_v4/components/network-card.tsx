import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { ClusterNetwork } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import type { SparkPoint } from '../../../core/data/dashboard';

function formatBps(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Go/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mo/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} Ko/s`;
  return `${v} o/s`;
}

/** CORPS de la carte réseau — stats rx/tx + sparkline (le badge « 5 min » est porté
 *  par le slot `extra` du widget dans la grille v4). */
export function NetworkCardBody({ network, spark }: { network: ClusterNetwork; spark: SparkPoint[] }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const option = useMemo<EChartsOption | null>(() => {
    if (spark.length < 2) return null;
    return {
      animation: false,
      grid: { top: 8, right: 4, bottom: 4, left: 4 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        valueFormatter: (v) => (typeof v === 'number' ? formatBps(v) : String(v)),
      },
      xAxis: { type: 'category', boundaryGap: false, data: spark.map((p) => p.time), show: false },
      yAxis: { type: 'value', show: false },
      series: [
        {
          name: t('network.rx'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: spark.map((p) => p.rxBps),
          lineStyle: { width: 1.5, color: ct.netIn },
          itemStyle: { color: ct.netIn },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${ct.netIn}55` },
                { offset: 1, color: `${ct.netIn}00` },
              ],
            },
          },
        },
        {
          name: t('network.tx'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: spark.map((p) => p.txBps),
          lineStyle: { width: 1.5, color: ct.netOut },
          itemStyle: { color: ct.netOut },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${ct.netOut}44` },
                { offset: 1, color: `${ct.netOut}00` },
              ],
            },
          },
        },
      ],
    };
  }, [spark, ct, t]);

  const ref = useEChart(option);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 grid shrink-0 grid-cols-2 gap-3">
        <div className="rounded-xl bg-secondary/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: ct.netIn }} />
            {t('network.rx')}
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums">{formatBps(network.rxBps)}</div>
        </div>
        <div className="rounded-xl bg-secondary/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: ct.netOut }} />
            {t('network.tx')}
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums">{formatBps(network.txBps)}</div>
        </div>
      </div>
      <div ref={ref} className="min-h-[80px] w-full flex-1" />
    </div>
  );
}

export function NetworkCard({ network, spark }: { network: ClusterNetwork; spark: SparkPoint[] }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle>{t('network.title')}</CardTitle>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">5 min</span>
      </CardHeader>
      <CardContent className="flex flex-col">
        <NetworkCardBody network={network} spark={spark} />
      </CardContent>
    </Card>
  );
}
