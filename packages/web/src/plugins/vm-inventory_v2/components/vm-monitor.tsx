import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { MetricsTimeframe, VmFsResponse, VmFsSeries, VmMetricsPoint, VmMetricsResponse } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { pctOption, rateOption, timeLabel, downloadCsvFile } from '../../../lib/monitor-charts';
import { fetchVmMetrics, fetchVmFs } from '../../../core/api/apiClient';
import { formatBytes } from '../../../lib/utils';

const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];
/** Auto-refresh pendant que l'onglet est ouvert (données pushées toutes les 5 s côté serveur). */
const REFRESH_MS = 60_000;

interface Props {
  endpointId: string;
  vmid: number;
  /** Nom de la VM — utilisé dans le nom du fichier CSV exporté. */
  vmName: string;
  /** RAM allouée (octets) — ligne pointillée d'allocation du graphe mémoire. */
  maxmemBytes: number | null;
  /** Espace disque alloué à la VM (octets, maxdisk) — info, les graphs d'occupation sont par partition. */
  maxdiskBytes: number | null;
}

/**
 * Onglet Monitor d'une VM (v2) : historiques CPU / RAM / Disques I/O / Occupation disque
 * (par partition) / Réseau depuis InfluxDB (vm_metrics + vm_fs), timeframes 1 h / 24 h /
 * 7 j / 30 j, auto-refresh 60 s et export CSV du timeframe affiché.
 *
 * Occupation disque : un graphe PAR FILESYSTEM (point de montage / partition) — QEMU via
 * l'agent invité (get-fsinfo, 5 min), LXC via /cluster/resources. Chaque graphe montre
 * l'espace utilisé + la taille du fs (ligne pointillée d'allocation).
 */
export function VmMonitor({ endpointId, vmid, vmName, maxmemBytes, maxdiskBytes }: Props) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const config = useOvercommitConfig();
  const [tf, setTf] = useState<MetricsTimeframe>('day');
  const [data, setData] = useState<VmMetricsResponse | null>(null);
  const [fsData, setFsData] = useState<VmFsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchVmMetrics(endpointId, vmid, tf), fetchVmFs(endpointId, vmid, tf)])
      .then(([d, fs]) => {
        if (!cancelled) {
          setData(d);
          setFsData(fs);
        }
      })
      .catch((err) => console.warn('chargement métriques VM en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpointId, vmid, tf, tick]);

  const ct = chartTheme(theme);
  const hasData = !!data && data.points.length > 0;
  const times = useMemo(() => (hasData && data ? data.points.map((p) => p.time) : []), [hasData, data]);

  /** CPU : % du CPU alloué (0–100) + bandes de seuils overcommit.json. */
  const cpuOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return pctOption(
      ct,
      tf,
      times,
      [{ name: t('vm.mon.cpu'), data: data.points.map((p) => p.cpuPct), color: ct.cpu, areaAlpha: '55' }],
      { warnPct: config.usage.warnPct, critPct: config.usage.critPct },
    );
  }, [hasData, data, times, tf, ct, t, config]);

  /** RAM : utilisée (octets) + ligne pointillée d'allocation si connue. */
  const memOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return {
      animation: false,
      grid: { top: 24, right: 16, bottom: 20, left: 56 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? formatBytes(v) : String(v)),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: times,
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: string) => timeLabel(Number(v), tf) },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: number) => formatBytes(v) },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series: [
        {
          name: t('vm.mon.mem'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: data.points.map((p) => p.memBytes),
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
          // ligne d'allocation (pointillés indigo) — si la RAM allouée est connue
          markLine:
            maxmemBytes != null && maxmemBytes > 0
              ? {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { type: 'dashed', color: '#6366f1', width: 1.5 },
                  label: {
                    formatter: `${t('vm.mon.alloc')} ${formatBytes(maxmemBytes)}`,
                    color: '#6366f1',
                    fontSize: 10,
                    position: 'insideEndTop',
                  },
                  data: [{ yAxis: maxmemBytes }],
                }
              : undefined,
        },
      ],
    };
  }, [hasData, data, times, tf, ct, t, maxmemBytes]);

  /** Disques I/O : lecture + écriture (octets/s). */
  const diskOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return rateOption(ct, tf, times, [
      { name: t('vm.mon.disk.read'), data: data.points.map((p) => p.diskReadBps), color: ct.diskRead },
      { name: t('vm.mon.disk.write'), data: data.points.map((p) => p.diskWriteBps), color: ct.diskWrite },
    ]);
  }, [hasData, data, times, tf, ct, t]);

  /** Réseau : RX + TX (bits/s, unité PVE — même convention que le dashboard). */
  const netOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return rateOption(ct, tf, times, [
      { name: t('network.rx'), data: data.points.map((p) => p.netInBps), color: ct.netIn },
      { name: t('network.tx'), data: data.points.map((p) => p.netOutBps), color: ct.netOut },
    ]);
  }, [hasData, data, times, tf, ct, t]);

  const cpuRef = useEChart(cpuOption);
  const memRef = useEChart(memOption);
  const diskRef = useEChart(diskOption);
  const netRef = useEChart(netOption);

  /** Colonnes CSV (général) : cpu/mem/io/réseau. L'occupation par partition est exportée par son propre graphe. */
  const ALL_COLS: { label: string; get: (p: VmMetricsPoint) => number | null }[] = [
    { label: 'cpu_pct', get: (p) => p.cpuPct },
    { label: 'mem_bytes', get: (p) => p.memBytes },
    { label: 'disk_read_bps', get: (p) => p.diskReadBps },
    { label: 'disk_write_bps', get: (p) => p.diskWriteBps },
    { label: 'net_in_bps', get: (p) => p.netInBps },
    { label: 'net_out_bps', get: (p) => p.netOutBps },
  ];

  /**
   * Export CSV du timeframe affiché (on exporte ce qu'on voit) — BOM UTF-8 + échappement.
   * `scope` = all (général) / cpu / mem / disk / net → nom de fichier + colonnes.
   */
  const downloadCsv = (scope: string, cols: typeof ALL_COLS) => {
    if (!data || data.points.length === 0) return;
    const header = ['timestamp', ...cols.map((c) => c.label)];
    const rows = data.points.map((p) => [
      new Date(p.time * 1000).toISOString(),
      ...cols.map((c) => {
        const v = c.get(p);
        return v != null ? String(v) : '';
      }),
    ]);
    downloadCsvFile(`vm-metrics-${vmName}-${scope}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  };

  /** Export général (barre d'outils) : toutes les colonnes. */
  const exportCsv = () => downloadCsv('all', ALL_COLS);

  /** Carte graphe (titre + source + export CSV du graphe + zone de rendu). */
  const chartCard = (title: string, ref: RefObject<HTMLDivElement>, showSource: boolean, onExport?: () => void) => (
    <Card>
      <CardHeader draggable={false} className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <div className="flex items-center gap-1.5">
          {showSource && data && hasData && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${data.source === 'influx' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
              {t(`metrics.source.${data.source}`)}
            </span>
          )}
          {onExport && (
            <button
              onClick={onExport}
              disabled={!hasData}
              title={t('vm.mon.export')}
              className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col">
        {loading && !hasData ? (
          <Skeleton className="min-h-[260px] w-full flex-1" />
        ) : (
          <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Barre d'outils : timeframes + export CSV. */}
      <div className="flex items-center justify-between gap-2">
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
        <button
          onClick={exportCsv}
          disabled={!hasData}
          title={t('vm.mon.export')}
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          {t('vm.mon.export')}
        </button>
      </div>

      {/* Pas de série : InfluxDB indisponible, ou VM arrêtée / trop récente. */}
      {data && data.source === 'insufficientData' ? (
        <div className="rounded-lg border px-3 py-6 text-center text-xs text-muted-foreground">
          {t('vm.mon.insufficient')}
        </div>
      ) : (
        /* Un graphe par ligne (pleine largeur) + export CSV par graphe.
           Occupation disque : UN GRAPHE PAR FILESYSTEM (partition) — un composant par série. */
        <div className="flex flex-col gap-3">
          {chartCard(t('vm.mon.cpu'), cpuRef, true, () => downloadCsv('cpu', ALL_COLS.slice(0, 1)))}
          {chartCard(t('vm.mon.mem'), memRef, false, () => downloadCsv('mem', ALL_COLS.slice(1, 2)))}
          {chartCard(t('metrics.disk'), diskRef, false, () => downloadCsv('disk', ALL_COLS.slice(2, 4)))}
          {/* Occupation disque par partition (agent invité QEMU / rootfs LXC). */}
          <FsOccupancySection fsData={fsData} vmName={vmName} tf={tf} loading={loading} hasData={hasData} maxdiskBytes={maxdiskBytes} />
          {chartCard(t('vm.mon.net'), netRef, false, () => downloadCsv('net', ALL_COLS.slice(4)))}
        </div>
      )}
    </div>
  );
}

/**
 * Section « Occupation disque » : un graphe PAR FILESYSTEM (point de montage / partition).
 * Chaque graphe = espace utilisé (courbe) + taille du fs (ligne pointillée d'allocation).
 */
function FsOccupancySection({
  fsData,
  vmName,
  tf,
  loading,
  hasData,
  maxdiskBytes,
}: {
  fsData: VmFsResponse | null;
  vmName: string;
  tf: MetricsTimeframe;
  loading: boolean;
  hasData: boolean;
  maxdiskBytes: number | null;
}) {
  const { t } = useTranslation();
  if (!fsData || fsData.series.length === 0) {
    return (
      <Card>
        <CardHeader draggable={false}>
          <CardTitle>{t('vm.mon.diskUsage')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border px-3 py-6 text-center text-xs text-muted-foreground">
            {t('vm.mon.fsNone')}
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {fsData.series.map((s) => (
        <FsUsageChart key={s.mountpoint} series={s} vmName={vmName} tf={tf} loading={loading} hasData={hasData} />
      ))}
      {maxdiskBytes != null && maxdiskBytes > 0 && (
        <p className="px-1 text-[11px] text-muted-foreground">
          {t('vm.mon.fsTotal')} {formatBytes(maxdiskBytes)}
        </p>
      )}
    </div>
  );
}

/** Graphe d'occupation d'UN filesystem (partition) : utilisé + taille (allocation). */
function FsUsageChart({ series, vmName, tf, loading, hasData }: { series: VmFsSeries; vmName: string; tf: MetricsTimeframe; loading: boolean; hasData: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const option = useMemo<EChartsOption | null>(() => {
    if (series.points.length === 0) return null;
    const times = series.points.map((p) => p.time);
    // taille du filesystem (constante) — 2ᵉ série plate pour apparaître dans la légende
    const total = series.points[series.points.length - 1]?.totalBytes ?? null;
    const totalData = series.points.map((p) => p.totalBytes ?? total ?? null);
    return {
      animation: false,
      grid: { top: 32, right: 16, bottom: 20, left: 56 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? formatBytes(v) : String(v)),
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 12,
        itemHeight: 3,
        textStyle: { color: ct.legend, fontSize: 11 },
        data: [t('vm.mon.fsUsed'), t('vm.mon.alloc')],
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: times,
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: string) => timeLabel(Number(v), tf) },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: number) => formatBytes(v) },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series: [
        {
          name: t('vm.mon.fsUsed'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: series.points.map((p) => p.usedBytes),
          lineStyle: { width: 2, color: ct.disk },
          itemStyle: { color: ct.disk },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${ct.disk}44` },
                { offset: 1, color: `${ct.disk}00` },
              ],
            },
          },
        },
        {
          name: t('vm.mon.alloc'),
          type: 'line',
          smooth: false,
          symbol: 'none',
          data: totalData,
          lineStyle: { type: 'dashed', width: 1.5, color: '#6366f1' },
          itemStyle: { color: '#6366f1' },
        },
      ],
    };
  }, [series, tf, ct, t]);

  const ref = useEChart(option);

  const exportCsv = () => {
    if (series.points.length === 0) return;
    const header = ['timestamp', 'used_bytes', 'total_bytes'];
    const rows = series.points.map((p) => [
      new Date(p.time * 1000).toISOString(),
      p.usedBytes != null ? String(p.usedBytes) : '',
      p.totalBytes != null ? String(p.totalBytes) : '',
    ]);
    const mp = (series.mountpoint || 'root').replace(/[^a-zA-Z0-9_-]/g, '_');
    downloadCsvFile(`vm-fs-${vmName}-${mp}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  };

  const title = `${t('vm.mon.diskUsage')} — ${series.mountpoint}`;

  return (
    <Card>
      <CardHeader draggable={false} className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <button
          onClick={exportCsv}
          disabled={series.points.length === 0}
          title={t('vm.mon.export')}
          className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </CardHeader>
      <CardContent className="flex flex-col">
        {loading && !hasData ? (
          <Skeleton className="min-h-[260px] w-full flex-1" />
        ) : (
          <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
        )}
      </CardContent>
    </Card>
  );
}
