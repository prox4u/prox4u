import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
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
import { timeLabel, downloadCsvFile } from '../../../lib/monitor-charts';

/** Palette par device (clefs chartTheme) — lecture = trait plein, écriture = pointillé. */
const PALETTE = ['diskRead', 'diskWrite', 'cpu', 'ram', 'netIn', 'disk'] as const;
/** Trous = null (jamais d'interpolation) ; le graphe se met à jour à chaque tick 60 s. */
const REFRESH_MS = 60_000;
/** Hauteur d'un des deux graphes (pleine largeur dans l'onglet Monitor). */
const CHART_H = 240;

interface DevicePoint {
  rb: number | null;
  wb: number | null;
  io: number | null;
  bp: number | null;
}

/**
 * Monitor nœud (Vue VM v2) — section « I/O disques (nœud) » : débits (lecture/écriture)
 * et saturation (busy % + IOPS) PAR DEVICE PHYSIQUE (nvme0n1, sda…) — disques entiers
 * seulement, device-mapper et partitions exclus (I/O double-comptée). Nœud fixe (celui
 * affiché), timeframe piloté par la barre d'outils de l'onglet. Les trous (nœud éteint,
 * reboot) restent visibles : c'est le signal, pas un défaut.
 */
export function NodeDiskioCard({ node, timeframe }: { node: string; timeframe: MetricsTimeframe }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);
  const [data, setData] = useState<NodeDiskioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchNodeDiskio(node, timeframe)
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
  }, [node, timeframe, tick]);

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
        axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: (v: string) => timeLabel(Number(v), timeframe) },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: (v: number) => formatBps(v) },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, devices, palette, timeframe, ct, t]);

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
          const head = timeLabel(Number(arr[0].axisValue), timeframe);
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
        axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: (v: string) => timeLabel(Number(v), timeframe) },
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
  }, [times, devices, palette, timeframe, ct, t]);

  const rwRef = useEChart(rwOption);
  const busyRef = useEChart(busyOption);

  /** Export CSV du timeframe affiché — mêmes conventions que le reste de l'onglet Monitor. */
  const exportCsv = () => {
    if (!data || data.devices.length === 0) return;
    const header = ['timestamp', 'device', 'read_bps', 'write_bps', 'iops', 'busy_pct', 'await_ms'];
    const rows = [...data.devices]
      .sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }) || a.t - b.t)
      .map((d) => [
        new Date(d.t * 1000).toISOString(),
        d.device,
        d.readBps != null ? String(d.readBps) : '',
        d.writeBps != null ? String(d.writeBps) : '',
        d.iops != null ? String(d.iops) : '',
        d.busyPct != null ? String(d.busyPct) : '',
        d.awaitMs != null ? String(d.awaitMs) : '',
      ]);
    downloadCsvFile(`node-diskio-${node}-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle title={t('overview.diskio.hint')}>{t('overview.diskio')}</CardTitle>
        <button
          onClick={exportCsv}
          disabled={!data || data.devices.length === 0}
          title={t('vm.mon.export')}
          className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loading && times.length === 0 ? (
          <Skeleton className="w-full" style={{ height: CHART_H }} />
        ) : (
          <>
            <div ref={rwRef} style={{ height: CHART_H }} className={`w-full ${loading ? 'opacity-50' : ''}`} />
            <div ref={busyRef} style={{ height: CHART_H }} className={`w-full ${loading ? 'opacity-50' : ''}`} />
          </>
        )}
        {data && !loading && times.length === 0 && (
          <div className="pb-1 text-center text-[11px] text-muted-foreground">{t('overview.diskio.none')}</div>
        )}
      </CardContent>
    </Card>
  );
}
