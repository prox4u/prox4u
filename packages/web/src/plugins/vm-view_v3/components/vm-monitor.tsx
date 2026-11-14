import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type {
  MetricsTimeframe,
  VmDiskioResponse,
  VmDiskioSeries,
  VmFsResponse,
  VmFsSeries,
  VmMetricsPoint,
  VmMetricsResponse,
  VmNetResponse,
  VmNetSeries,
  WidgetItem,
} from '@prox4u/shared';
import { addWidget, defaultStackLayout, mergePageConfig, removeWidget } from '@prox4u/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { pctOption, rateOption, timeLabel, downloadCsvFile } from '../../../lib/monitor-charts';
import { fetchVmDiskio, fetchVmMetrics, fetchVmFs, fetchVmNet } from '../../../core/api/apiClient';
import { formatBps, formatBytes } from '../../../lib/utils';
import { useUserConfig } from '../../../store/user-config';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { ExportCsvButton } from '../../../core/widgets/export-csv-button';
import { widgetIdFrom, layoutsEqual, type CoreWidgetDef } from '../../../core/widgets/types';

const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];
/** Auto-refresh pendant que l'onglet est ouvert (données pushées toutes les 5 s côté serveur). */
const REFRESH_MS = 60_000;

interface Props {
  endpointId: string;
  vmid: number;
  /** Nom de la VM — sous-titre de chaque carte de la grille + noms de fichiers CSV. */
  vmName: string;
  /** RAM allouée (octets) — ligne pointillée d'allocation du graphe mémoire. */
  maxmemBytes: number | null;
  /** Espace disque alloué à la VM (octets, maxdisk) — info, les graphs d'occupation sont par partition. */
  maxdiskBytes: number | null;
}

/**
 * Onglet Monitor d'une VM (v3) — GRILLE PERSONNALISABLE PAR UTILISATEUR :
 * drag/resize des cartes, retrait → bibliothèque, réinsertion, réinitialisation ;
 * persistance par compte et par VM (scope « endpoint/vmid » — le vmid est stable
 * au renommage de la VM).
 *
 * Catalogue de widgets (ordre = ordre visuel v2) :
 *  - cpu / mem / disk / net : historiques agrégés (vm_metrics) ;
 *  - diskio-<label> : I/O PAR DISQUE de la VM (agent hôte + mapping dm-N → LV) ;
 *  - fs-<mountpoint> : occupation PAR FILESYSTEM (agent invité QEMU / rootfs LXC) ;
 *  - net-<iface> : trafic PAR CARTE (agent hôte, joint MAC → tap).
 * Les widgets dynamiques (diskio/fs/net) apparaissent au catalogue quand les
 * séries arrivent : le merge les insère dans le layout, et les retire dans la
 * bibliothèque si le disque / le fs / la carte disparaît.
 *
 * Occupation disque : un graphe PAR FILESYSTEM (point de montage / partition).
 * Sous-titre de chaque carte = nom de la VM (choix utilisateur — le nom de VM
 * est visible sur chaque graphique).
 */

/** Données du monitor (4 sources) — garde les anciennes données pendant un re-fetch. */
function useVmMonitorData(endpointId: string, vmid: number) {
  const [tf, setTf] = useState<MetricsTimeframe>('day');
  const [data, setData] = useState<VmMetricsResponse | null>(null);
  const [fsData, setFsData] = useState<VmFsResponse | null>(null);
  const [diskioData, setDiskioData] = useState<VmDiskioResponse | null>(null);
  const [netData, setNetData] = useState<VmNetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // vm-diskio et vm-net isolés (.catch → null) : leur échec ne doit pas casser le reste.
    // Les anciennes données restent affichées (opacité 50 %) pendant le re-fetch —
    // le catalogue de widgets (ids dynamiques) reste donc stable entre deux ticks.
    Promise.all([
      fetchVmMetrics(endpointId, vmid, tf),
      fetchVmFs(endpointId, vmid, tf),
      fetchVmDiskio(endpointId, vmid, tf).catch((err) => {
        console.warn('chargement vm-diskio en échec', err);
        return null;
      }),
      fetchVmNet(endpointId, vmid, tf).catch((err) => {
        console.warn('chargement vm-net en échec', err);
        return null;
      }),
    ]).then(([d, fs, dio, net]) => {
      if (!cancelled) {
        setData(d);
        setFsData(fs);
        setDiskioData(dio);
        setNetData(net);
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

  const hasData = !!data && data.points.length > 0;
  return { tf, setTf, data, fsData, diskioData, netData, loading, hasData };
}

/** Colonnes CSV (général) : cpu/mem/io/réseau. L'occupation par partition est exportée par son propre graphe. */
const ALL_COLS: { label: string; get: (p: VmMetricsPoint) => number | null }[] = [
  { label: 'cpu_pct', get: (p) => p.cpuPct },
  { label: 'mem_bytes', get: (p) => p.memBytes },
  { label: 'disk_read_bps', get: (p) => p.diskReadBps },
  { label: 'disk_write_bps', get: (p) => p.diskWriteBps },
  { label: 'net_in_bps', get: (p) => p.netInBps },
  { label: 'net_out_bps', get: (p) => p.netOutBps },
];

/** Export CSV d'un sous-ensemble des colonnes générales (on exporte ce qu'on voit). */
function exportStaticCsv(
  data: VmMetricsResponse | null,
  vmName: string,
  tf: MetricsTimeframe,
  scope: string,
  cols: typeof ALL_COLS,
): void {
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
}

/** Export CSV d'UN filesystem (occupation). */
function exportFsCsv(series: VmFsSeries, vmName: string, tf: MetricsTimeframe): void {
  if (series.points.length === 0) return;
  const header = ['timestamp', 'used_bytes', 'total_bytes'];
  const rows = series.points.map((p) => [
    new Date(p.time * 1000).toISOString(),
    p.usedBytes != null ? String(p.usedBytes) : '',
    p.totalBytes != null ? String(p.totalBytes) : '',
  ]);
  const mp = (series.mountpoint || 'root').replace(/[^a-zA-Z0-9_-]/g, '_');
  downloadCsvFile(`vm-fs-${vmName}-${mp}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

/** Export CSV d'UN disque de la VM (I/O hôte). */
function exportPerDeviceCsv(series: VmDiskioSeries, vmName: string, tf: MetricsTimeframe): void {
  if (series.points.length === 0) return;
  const header = ['timestamp', 'read_bps', 'write_bps', 'iops', 'busy_pct', 'await_ms'];
  const rows = series.points.map((p) => [
    new Date(p.t * 1000).toISOString(),
    p.readBps != null ? String(p.readBps) : '',
    p.writeBps != null ? String(p.writeBps) : '',
    p.iops != null ? String(p.iops) : '',
    p.busyPct != null ? String(p.busyPct) : '',
    p.awaitMs != null ? String(p.awaitMs) : '',
  ]);
  const dev = series.label.replace(/[^a-zA-Z0-9_-]/g, '_');
  downloadCsvFile(`vm-diskio-${vmName}-${dev}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

/** Export CSV d'UNE carte réseau de la VM. */
function exportPerIfaceCsv(series: VmNetSeries, vmName: string, tf: MetricsTimeframe): void {
  if (series.points.length === 0) return;
  const header = ['timestamp', 'in_bps', 'out_bps'];
  const rows = series.points.map((p) => [
    new Date(p.t * 1000).toISOString(),
    p.inBps != null ? String(p.inBps) : '',
    p.outBps != null ? String(p.outBps) : '',
  ]);
  const dev = series.iface.replace(/[^a-zA-Z0-9_-]/g, '_');
  downloadCsvFile(`vm-net-${vmName}-${dev}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

/** Corps de carte graphe générique (CPU/RAM/disk/réseau agrégés). */
function StaticChartBody({ option, loading, hasData }: { option: EChartsOption | null; loading: boolean; hasData: boolean }) {
  const ref = useEChart(option);
  return (
    <div className="flex h-full flex-col">
      {loading && !hasData ? (
        <Skeleton className="min-h-[260px] w-full flex-1" />
      ) : (
        <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

/**
 * CORPS du graphe d'occupation d'UN filesystem (partition) : utilisé + taille
 * (allocation, ligne pointillée). L'export CSV est porté par le slot extra.
 */
function FsUsageBody({ series, tf, loading, hasData }: { series: VmFsSeries; tf: MetricsTimeframe; loading: boolean; hasData: boolean }) {
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

  return (
    <div className="flex h-full flex-col">
      {loading && !hasData ? (
        <Skeleton className="min-h-[260px] w-full flex-1" />
      ) : (
        <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

/**
 * CORPS d'UN disque de la VM : débits (lecture/écriture) + saturation
 * (busy % + IOPS), deux graphiques liés. L'export CSV est porté par le slot extra.
 */
function PerDeviceBody({ series, tf, loading }: { series: VmDiskioSeries; tf: MetricsTimeframe; loading: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const times = useMemo(() => series.points.map((p) => p.t), [series]);

  /** Débits : lecture (trait plein) + écriture (pointillé), octets/s. */
  const rwOption = useMemo<EChartsOption | null>(() => {
    if (times.length === 0) return null;
    return {
      animation: false,
      grid: { top: 32, right: 16, bottom: 20, left: 56 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? formatBps(v) : String(v)),
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 12,
        itemHeight: 3,
        textStyle: { color: ct.legend, fontSize: 11 },
        data: [t('vm.mon.disk.read'), t('vm.mon.disk.write')],
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
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: number) => formatBps(v) },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series: [
        {
          name: t('vm.mon.disk.read'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: series.points.map((p) => p.readBps),
          lineStyle: { width: 2, color: ct.diskRead },
          itemStyle: { color: ct.diskRead },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${ct.diskRead}44` },
                { offset: 1, color: `${ct.diskRead}00` },
              ],
            },
          },
        },
        {
          name: t('vm.mon.disk.write'),
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: series.points.map((p) => p.writeBps),
          lineStyle: { width: 2, type: 'dashed', color: ct.diskWrite },
          itemStyle: { color: ct.diskWrite },
        },
      ],
    };
  }, [series, times, tf, ct, t]);

  /** Saturation : busy % (Δ io_time, 0–100, convention iostat) + IOPS (2ᵉ axe). */
  const busyOption = useMemo<EChartsOption | null>(() => {
    if (times.length === 0) return null;
    return {
      animation: false,
      grid: { top: 32, right: 40, bottom: 20, left: 36 },
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
            const unit = p.seriesName === t('vm.mon.busy') ? ' %' : '';
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
        textStyle: { color: ct.legend, fontSize: 11 },
        data: [t('vm.mon.busy'), t('vm.mon.iops')],
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: times,
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: string) => timeLabel(Number(v), tf) },
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
          position: 'right',
          axisLabel: { color: ct.axisLabel, fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: t('vm.mon.busy'),
          type: 'line',
          yAxisIndex: 0,
          smooth: true,
          symbol: 'none',
          data: series.points.map((p) => p.busyPct),
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
          name: t('vm.mon.iops'),
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: series.points.map((p) => p.iops),
          lineStyle: { width: 1.5, type: 'dashed', color: ct.cpu },
          itemStyle: { color: ct.cpu },
        },
      ],
    };
  }, [series, times, tf, ct, t]);

  const rwRef = useEChart(rwOption);
  const busyRef = useEChart(busyOption);

  return (
    <div className="flex h-full flex-col gap-2">
      {loading && times.length === 0 ? (
        <Skeleton className="min-h-[160px] w-full" />
      ) : times.length === 0 ? (
        <div className="rounded-lg border px-3 py-4 text-center text-xs text-muted-foreground">{t('vm.mon.perDevice.noData')}</div>
      ) : (
        <>
          <div ref={rwRef} className={`h-[170px] w-full ${loading ? 'opacity-50' : ''}`} />
          <div ref={busyRef} className={`h-[170px] w-full ${loading ? 'opacity-50' : ''}`} />
        </>
      )}
    </div>
  );
}

/**
 * CORPS du graphe de débit d'UNE carte de la VM : RX (plein) + TX (pointillé).
 * Note d'état dégradé : tap non trouvé (MAC) ou aucune mesure sur la fenêtre.
 */
function PerIfaceBody({ series, tf, loading }: { series: VmNetSeries; tf: MetricsTimeframe; loading: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const times = useMemo(() => series.points.map((p) => p.t), [series]);

  const option = useMemo(() => {
    if (times.length === 0) return null;
    return rateOption(ct, tf, times, [
      { name: t('network.rx'), data: series.points.map((p) => p.inBps), color: ct.netIn },
      { name: t('network.tx'), data: series.points.map((p) => p.outBps), color: ct.netOut },
    ]);
  }, [series, times, tf, ct, t]);

  const ref = useEChart(option);

  const note = !series.hostIface
    ? series.mac
      ? t('vm.mon.netPerIface.noMac', { mac: series.mac })
      : t('vm.mon.netPerIface.noData')
    : series.points.length === 0
      ? t('vm.mon.netPerIface.noData')
      : null;

  return (
    <div className="flex h-full flex-col gap-2">
      {loading && times.length === 0 ? (
        <Skeleton className="min-h-[160px] w-full" />
      ) : note ? (
        <div className="rounded-lg border px-3 py-4 text-center text-xs text-muted-foreground">{note}</div>
      ) : (
        <div ref={ref} className={`h-[170px] w-full ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

export function VmMonitor({ endpointId, vmid, vmName, maxmemBytes, maxdiskBytes }: Props) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const config = useOvercommitConfig();
  const { tf, setTf, data, fsData, diskioData, netData, loading, hasData } = useVmMonitorData(endpointId, vmid);

  // Personnalisation par utilisateur : scope = « endpoint/vmid » (vmid stable
  // au renommage de la VM — le nom n'entre jamais dans la clé).
  const scope = `${endpointId}/${vmid}`;
  const stored = useUserConfig((s) => s.config?.pages.vmView?.[scope] ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const ct = chartTheme(theme);
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

  // Catalogue de widgets — ORDRE VISUEL v2 : cpu, mem, disk, [diskio-*], [fs-*],
  // net, [net-*]. Le nom de la VM est le SOUS-TITRE de chaque carte.
  const catalog = useMemo<CoreWidgetDef[]>(() => {
    const defs: CoreWidgetDef[] = [];
    const subtitle = vmName;
    defs.push(
      {
        id: 'cpu',
        title: t('vm.mon.cpu'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <span className="flex items-center gap-1.5">
            {data && hasData && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  data.source === 'influx' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
                }`}
              >
                {t(`metrics.source.${data.source}`)}
              </span>
            )}
            <ExportCsvButton disabled={!hasData} onClick={() => exportStaticCsv(data, vmName, tf, 'cpu', ALL_COLS.slice(0, 1))} />
          </span>
        ),
        render: () => <StaticChartBody option={cpuOption} loading={loading} hasData={hasData} />,
      },
      {
        id: 'mem',
        title: t('vm.mon.mem'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportStaticCsv(data, vmName, tf, 'mem', ALL_COLS.slice(1, 2))} />,
        render: () => <StaticChartBody option={memOption} loading={loading} hasData={hasData} />,
      },
      {
        id: 'disk',
        title: t('metrics.disk'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportStaticCsv(data, vmName, tf, 'disk', ALL_COLS.slice(2, 4))} />,
        render: () => <StaticChartBody option={diskOption} loading={loading} hasData={hasData} />,
      },
    );
    // I/O PAR DISQUE de la VM (agent hôte + mapping device-mapper) — UN WIDGET PAR DISQUE.
    for (const s of diskioData?.series ?? []) {
      defs.push({
        id: `diskio-${widgetIdFrom(s.label)}`,
        title: `${t('vm.mon.perDevice')} — ${s.label}`,
        subtitle,
        default: { w: 12, h: 5 },
        minH: 4,
        extra: () => <ExportCsvButton disabled={s.points.length === 0} onClick={() => exportPerDeviceCsv(s, vmName, tf)} />,
        render: () => <PerDeviceBody series={s} tf={tf} loading={loading} />,
      });
    }
    // Occupation disque PAR FILESYSTEM (agent invité QEMU / rootfs LXC) — UN WIDGET PAR FS.
    for (const s of fsData?.series ?? []) {
      defs.push({
        id: `fs-${widgetIdFrom(s.mountpoint)}`,
        title: `${t('vm.mon.diskUsage')} — ${s.mountpoint}`,
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={s.points.length === 0} onClick={() => exportFsCsv(s, vmName, tf)} />,
        render: () => <FsUsageBody series={s} tf={tf} loading={loading} hasData={hasData} />,
      });
    }
    defs.push({
      id: 'net',
      title: t('vm.mon.net'),
      subtitle,
      default: { w: 12, h: 4 },
      minH: 3,
      extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportStaticCsv(data, vmName, tf, 'net', ALL_COLS.slice(4))} />,
      render: () => <StaticChartBody option={netOption} loading={loading} hasData={hasData} />,
    });
    // Réseau PAR CARTE de la VM (agent hôte, joint MAC → tap) — UN WIDGET PAR CARTE.
    for (const s of netData?.series ?? []) {
      defs.push({
        id: `net-${widgetIdFrom(s.iface)}`,
        title: `${t('vm.mon.netPerIface')} — ${s.label}`,
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={s.points.length === 0} onClick={() => exportPerIfaceCsv(s, vmName, tf)} />,
        render: () => <PerIfaceBody series={s} tf={tf} loading={loading} />,
      });
    }
    return defs;
  }, [data, hasData, fsData, diskioData, netData, loading, tf, vmName, cpuOption, memOption, diskOption, netOption, t]);

  // Clé du catalogue (ids) — stable tant que le parc disques/fs/cartes ne change pas.
  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);

  // La grille ne se monte qu'après le PREMIER chargement : avant, les ids
  // dynamiques (diskio-*/fs-*/net-*) sont inconnus et le merge ferait orphelins
  // des positions stockées. Les re-fetchs suivants gardent les données
  // précédentes → le catalogue reste stable.
  const ready = !!(data || fsData || diskioData || netData);

  const defaultLayout = useMemo(
    () => (ready ? defaultStackLayout(catalog) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogKey, ready],
  );

  // FUSION « utilisateurs présents et futurs » : positions stockées priment ;
  // disque/cartes nouveaux → ajoutés en fin de grille ; disparus → bibliothèque.
  const merged = useMemo(() => {
    if (!ready) return null;
    return mergePageConfig(stored, catalog, defaultLayout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, catalogKey, ready, defaultLayout]);

  const onLayoutChange = (layout: WidgetItem[]) => {
    if (!merged) return;
    // Garde : RGL rappelle onLayoutChange sur les compactations parent-driven
    // (retrait d'un widget) — on n'enregistre que les vrais changements.
    if (layoutsEqual(layout, merged.layout)) return;
    updatePage('vmView', scope, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => {
    if (!merged) return;
    updatePage('vmView', scope, removeWidget(merged, widgetId));
  };
  const onAdd = (widgetId: string) => {
    if (!merged) return;
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('vmView', scope, addWidget(merged, def));
  };
  const onReset = () => clearPage('vmView', scope);

  return (
    <div className="flex flex-col gap-3">
      {/* Barre d'outils : timeframes + personnalisation (bibliothèque/reset) + export CSV. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
          <WidgetToolbar
            libraryOpen={libraryOpen}
            onToggleLibrary={() => setLibraryOpen((o) => !o)}
            onReset={onReset}
            libraryCount={merged?.library.length ?? 0}
          />
        </div>
        <button
          onClick={() => exportStaticCsv(data, vmName, tf, 'all', ALL_COLS)}
          disabled={!hasData}
          title={t('vm.mon.export')}
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          {t('vm.mon.export')}
        </button>
      </div>

      {!ready ? (
        /* Premier chargement : squelette (catalogue dynamique encore inconnu). */
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[280px] w-full" />
          <Skeleton className="h-[280px] w-full" />
          <Skeleton className="h-[280px] w-full" />
        </div>
      ) : (
        <>
          {/* Pas de série : InfluxDB indisponible, ou VM arrêtée / trop récente. */}
          {data && data.source === 'insufficientData' && (
            <div className="rounded-lg border px-3 py-6 text-center text-xs text-muted-foreground">{t('vm.mon.insufficient')}</div>
          )}
          {/* États dégradés des sections sans série (info conservée de la v2). */}
          <div className="flex flex-col gap-0.5">
            {diskioData && diskioData.series.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t('vm.mon.perDevice')} : {diskioData.source === 'noMapping' ? t('vm.mon.perDevice.noMapping') : t('vm.mon.perDevice.none')}
              </p>
            )}
            {fsData && fsData.series.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t('vm.mon.diskUsage')} : {t('vm.mon.fsNone')}
              </p>
            )}
            {fsData && fsData.series.length > 0 && maxdiskBytes != null && maxdiskBytes > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t('vm.mon.fsTotal')} {formatBytes(maxdiskBytes)}
              </p>
            )}
            {netData && netData.series.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t('vm.mon.netPerIface')} : {netData.source === 'noMapping' ? t('vm.mon.netPerIface.noMapping') : t('vm.mon.netPerIface.none')}
              </p>
            )}
          </div>

          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              {merged && (
                <WidgetGridLayout
                  catalog={catalog}
                  config={merged}
                  ctx={{ endpointId, vmName }}
                  onLayoutChange={onLayoutChange}
                  onRemove={onRemove}
                />
              )}
            </div>
            {libraryOpen && merged && (
              <WidgetLibraryPanel
                catalog={catalog}
                config={merged}
                onAdd={onAdd}
                onRemove={onRemove}
                onClose={() => setLibraryOpen(false)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
