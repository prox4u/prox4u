import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { MetricsTimeframe, NodeDiskioResponse } from '@prox4u/shared';
import { fetchNodeDiskio } from '../../../core/api/apiClient';
import { formatBps } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { timeLabel } from '../../../lib/monitor-charts';

const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];
/** Palette par device (clefs chartTheme) — lecture = trait plein, écriture = pointillé. */
const PALETTE = ['diskRead', 'diskWrite', 'cpu', 'ram', 'netIn', 'disk'] as const;
/** Trous = null (jamais d'interpolation) ; le graphe se met à jour à chaque tick 60 s. */
const REFRESH_MS = 60_000;

interface DevicePoint {
  rb: number | null;
  wb: number | null;
  io: number | null;
  bp: number | null;
}

/**
 * Vue d'ensemble — carte « I/O disques (nœud) » : débits (lecture/écriture) et
 * saturation (busy % + IOPS) PAR DEVICE PHYSIQUE (nvme0n1, sda…) — disques
 * entiers seulement, device-mapper et partitions exclus (I/O double-comptée).
 * Nœud + timeframe sélectionnables ; les trous (nœud éteint, reboot) restent
 * visibles : c'est le signal, pas un défaut.
 */
export function NodeDiskioCard({ nodes }: { nodes: string[] }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);
  const [node, setNode] = useState('');
  const [tf, setTf] = useState<MetricsTimeframe>('day');
  const [data, setData] = useState<NodeDiskioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Nœud par défaut = le premier connu de l'agent (les 3 nœuds ne sont pas
  // forcément up — la liste vient des données, pas de la config).
  useEffect(() => {
    if (!node && nodes.length > 0) setNode(nodes[0]);
  }, [nodes, node]);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!node) return;
    let cancelled = false;
    setLoading(true);
    fetchNodeDiskio(node, tf)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement node-diskio en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node, tf, tick]);

  /** Base de temps commune (union des buckets) — trous = null dans chaque série. */
  const times = useMemo(() => {
    const s = new Set<number>();
    for (const d of data?.devices ?? []) s.add(d.t);
    return [...s].sort((a, b) => a - b);
  }, [data]);

  const devices = useMemo(() => {
    const m = new Map<string, Map<number, DevicePoint>>();
    for (const d of data?.devices ?? []) {
      const dev = m.get(d.device) ?? new Map<number, DevicePoint>();
      dev.set(d.t, { rb: d.readBps, wb: d.writeBps, io: d.iops, bp: d.busyPct });
      m.set(d.device, dev);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [data]);

  const palette = useMemo(() => devices.map((_, i) => ct[PALETTE[i % PALETTE.length]]), [devices, ct]);
  const devPts = (dev: string) => devices.find(([d]) => d === dev)?.[1] ?? new Map<number, DevicePoint>();

  /** Débits : lecture (plein) + écriture (pointillé) par device. */
  const rwOption = useMemo<EChartsOption | null>(() => {
    if (times.length === 0 || devices.length === 0) return null;
    const series = devices.flatMap(([dev], di) => {
      const pts = devPts(dev);
      const color = palette[di];
      return [
        {
          name: `${dev} · ${t('vm.mon.disk.read')}`,
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: times.map((x) => pts.get(x)?.rb ?? null),
          lineStyle: { width: 2, color },
          itemStyle: { color },
        },
        {
          name: `${dev} · ${t('vm.mon.disk.write')}`,
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: times.map((x) => pts.get(x)?.wb ?? null),
          lineStyle: { width: 2, type: 'dashed' as const, color },
          itemStyle: { color },
        },
      ];
    });
    return {
      animation: false,
      grid: { top: 26, right: 12, bottom: 18, left: 56 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? formatBps(v) : String(v)),
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 12,
        itemHeight: 3,
        textStyle: { color: ct.legend, fontSize: 10 },
        data: series.map((s) => s.name),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: times,
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: (v: string) => timeLabel(Number(v), tf) },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: (v: number) => formatBps(v) },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, devices, palette, tf, ct, t]);

  /** Saturation : busy % (axe gauche 0–100) + IOPS (axe droit) par device. */
  const busyOption = useMemo<EChartsOption | null>(() => {
    if (times.length === 0 || devices.length === 0) return null;
    const iopsLabel = t('vm.mon.iops');
    const series = devices.flatMap(([name, ptsMap], di) => {
      const color = palette[di];
      return [
        {
          name: `${name} · ${t('vm.mon.busy')}`,
          type: 'line' as const,
          yAxisIndex: 0,
          smooth: true,
          symbol: 'none',
          data: times.map((x) => ptsMap.get(x)?.bp ?? null),
          lineStyle: { width: 2, color },
          itemStyle: { color },
        },
        {
          name: `${name} · ${iopsLabel}`,
          type: 'line' as const,
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: times.map((x) => ptsMap.get(x)?.io ?? null),
          lineStyle: { width: 1.5, type: 'dashed' as const, color },
          itemStyle: { color },
        },
      ];
    });
    return {
      animation: false,
      grid: { top: 26, right: 40, bottom: 18, left: 36 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string | number; seriesName: string; value: number | null; marker: string }>;
          if (!Array.isArray(arr) || arr.length === 0) return '';
          const head = timeLabel(Number(arr[0].axisValue), tf);
          const lines = arr.map((p) => {
            const v = typeof p.value === 'number' ? p.value.toFixed(1) : '—';
            const unit = p.seriesName.includes(t('vm.mon.busy')) ? ' %' : '';
            return `${p.marker} ${p.seriesName} : ${v}${unit}`;
          });
          return `${head}<br/>${lines.join('<br/>')}`;
        },
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 12,
        itemHeight: 3,
        textStyle: { color: ct.legend, fontSize: 10 },
        data: series.map((s) => s.name),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: times,
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: (v: string) => timeLabel(Number(v), tf) },
      },
      yAxis: [
        {
          type: 'value',
          min: 0,
          max: 100,
          axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: '{value} %' },
          splitLine: { lineStyle: { color: ct.splitLine } },
        },
        {
          type: 'value',
          position: 'right',
          axisLabel: { color: ct.axisLabel, fontSize: 9 },
          splitLine: { show: false },
        },
      ],
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, devices, palette, tf, ct, t]);

  const rwRef = useEChart(rwOption);
  const busyRef = useEChart(busyOption);

  return (
    <Card>
      <CardHeader draggable>
        <CardTitle title={t('overview.diskio.hint')}>{t('overview.diskio')}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
        {nodes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
            {t('overview.system.none')}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex rounded-lg border bg-secondary p-0.5">
                {TIMEFRAMES.map((x) => (
                  <button
                    key={x}
                    onClick={() => setTf(x)}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      tf === x ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t(`metrics.tf.${x}`)}
                  </button>
                ))}
              </div>
              <select
                value={node}
                onChange={(e) => setNode(e.target.value)}
                className="rounded-md border bg-transparent px-1.5 py-0.5 text-[11px] text-foreground"
              >
                {nodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            {loading && times.length === 0 ? (
              <Skeleton className="min-h-0 w-full flex-1" />
            ) : (
              <>
                <div ref={rwRef} className={`min-h-0 w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
                <div ref={busyRef} className={`min-h-0 w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
              </>
            )}
            {data && !loading && times.length === 0 && (
              <div className="pb-1 text-center text-[11px] text-muted-foreground">{t('overview.diskio.none')}</div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
