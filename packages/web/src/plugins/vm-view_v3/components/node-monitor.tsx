import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type {
  MetricsPoint,
  MetricsResponse,
  MetricsTimeframe,
  NodeDiskioResponse,
  NodeNetIface,
  NodeNetResponse,
  NodeNetRow,
  NodeSystemRow,
  VmNetPoint,
  WidgetItem,
} from '@prox4u/shared';
import { addWidget, defaultStackLayout, mergePageConfig, removeWidget } from '@prox4u/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { pctOption, rateOption, downloadCsvFile, timeLabel } from '../../../lib/monitor-charts';
import { fetchMetrics, fetchNodeDiskio, fetchNodeNet, fetchNodeSystem } from '../../../core/api/apiClient';
import { formatBps } from '../../../lib/utils';
import { FwDecodeBlock } from './node-net-card';
import { CpuCoresBody } from './cpu-cores-card';
import { NodeSystemStatsGrid } from './node-system-card';
import { useUserConfig } from '../../../store/user-config';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { ExportCsvButton } from '../../../core/widgets/export-csv-button';
import { widgetIdFrom, layoutsEqual, type CoreWidgetDef } from '../../../core/widgets/types';

const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];
/** Auto-refresh pendant que l'onglet est ouvert (données pushées toutes les 5 s côté serveur). */
const REFRESH_MS = 60_000;
/** Hauteur d'un graphe I/O disques dans la carte (2 graphiques liés par widget). */
const CHART_H = 240;

interface Props {
  endpointId: string;
  /** Nom du nœud PVE — filtre `node` de /api/metrics, clef du scope et SOUS-TITRE de chaque carte. */
  node: string;
}

/**
 * Onglet Monitor d'un nœud Proxmox (v3) — GRILLE PERSONNALISABLE PAR UTILISATEUR :
 * drag/resize des cartes, retrait → bibliothèque, réinsertion, réinitialisation ;
 * persistance par compte et par nœud (scope « endpoint/nomDuNœud » — le hostname
 * PVE est le seul identifiant stable du nœud ; un renommage remet le layout à zéro).
 *
 * Catalogue de widgets (ordre = ordre visuel v2) :
 *  - system : état courant (load/iowait/swap/uptime — agent hôte Telegraf) ;
 *  - cpu / ram / rootfs / net : historiques PVE (node_metrics via /api/metrics?node=) ;
 *  - cpubars : CPU par cœur (point courant agent hôte) ;
 *  - diskio : I/O disques PAR DEVICE PHYSIQUE (1 carte, tous devices, 2 graphiques) ;
 *  - netif-<iface> : trafic PAR INTERFACE hôte (dynamiques — une carte par interface).
 *
 * Le nom du nœud est le SOUS-TITRE de chaque carte (choix utilisateur — le nom
 * de nœud est visible sur chaque graphique).
 */

/** I/O disques du nœud (Telegraf) — fetch hoisté au niveau monitor (le catalogue
 *  a besoin des données pour le slot « export CSV » du widget `diskio`). */
function useNodeDiskio(node: string, timeframe: MetricsTimeframe) {
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

  return { data, loading };
}

/** Réseau par interface du nœud (Telegraf + PVE) — fetch hoisté au niveau monitor
 *  (le catalogue a besoin de la LISTE DES INTERFACES pour les widgets dynamiques
 *  `netif-<iface>`). `done` = premier chargement terminé (la grille se monte alors). */
function useNodeNet(node: string, timeframe: MetricsTimeframe) {
  const [data, setData] = useState<NodeNetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchNodeNet(node, timeframe)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement node-net en échec', err))
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setDone(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [node, timeframe, tick]);

  return { data, loading, done };
}

/** Colonnes CSV par point — l'export général couvre les 5 champs, chaque graphe les siens. */
const ALL_COLS: { label: string; get: (p: MetricsPoint) => number | null }[] = [
  { label: 'cpu_pct', get: (p) => p.cpuPct },
  { label: 'ram_pct', get: (p) => p.ramPct },
  { label: 'disk_rootfs_pct', get: (p) => p.storagePct },
  { label: 'net_in_bps', get: (p) => p.netInBps },
  { label: 'net_out_bps', get: (p) => p.netOutBps },
];

/** Export CSV d'un sous-ensemble des colonnes générales (on exporte ce qu'on voit). */
function exportNodeCsv(
  data: MetricsResponse | null,
  node: string,
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
  downloadCsvFile(`node-metrics-${node}-${scope}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

/** Export CSV du CPU par cœur — une ligne par cœur. */
function exportCpuCoresCsv(row: NodeSystemRow): void {
  const cores = row.cores ?? [];
  if (cores.length === 0) return;
  const header = ['core', 'usage_pct', 'user_pct', 'system_pct', 'iowait_pct'];
  const rows = cores.map((c) => [c.core, c.usagePct.toFixed(1), c.userPct.toFixed(1), c.systemPct.toFixed(1), c.iowaitPct.toFixed(1)]);
  downloadCsvFile(`node-cpu-cores-${row.node}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

/** Export CSV de l'I/O disques du nœud (tous devices). */
function exportNodeDiskioCsv(data: NodeDiskioResponse | null, node: string, timeframe: MetricsTimeframe): void {
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
}

/** Export CSV du trafic d'UNE interface hôte sur le timeframe affiché. */
function exportNodeNetIfaceCsv(iface: NodeNetIface, rows: NodeNetRow[], node: string, timeframe: MetricsTimeframe): void {
  const header = ['timestamp', 'in_bps', 'out_bps'];
  const body = [...rows]
    .sort((a, b) => a.t - b.t)
    .map((r) => [new Date(r.t * 1000).toISOString(), r.inBps != null ? String(r.inBps) : '', r.outBps != null ? String(r.outBps) : '']);
  downloadCsvFile(`node-net-${node}-${iface.name}-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv`, header, body);
}

/** Corps de carte graphe générique (CPU/RAM/rootfs/réseau PVE). */
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

/** Corps « Système (nœud) » : état courant — load 1/5/15, iowait, swap, uptime. */
function NodeSystemBody({ row, loading }: { row: NodeSystemRow | undefined; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      {loading && !row ? (
        <Skeleton className="h-12 w-full" />
      ) : !row ? (
        <div className="px-1 py-2 text-xs text-muted-foreground">{t('overview.system.none')}</div>
      ) : (
        <NodeSystemStatsGrid row={row} />
      )}
    </div>
  );
}

/**
 * Corps « I/O disques (nœud) » : débits + saturation PAR DEVICE PHYSIQUE (2
 * graphiques liés, tous devices de la carte). Données fetchées au niveau monitor.
 */
interface DevicePoint {
  rb: number | null;
  wb: number | null;
  io: number | null;
  bp: number | null;
}
const PALETTE = ['diskRead', 'diskWrite', 'cpu', 'ram', 'netIn', 'disk'] as const;

function NodeDiskioBody({
  data,
  loading,
  timeframe,
}: {
  data: NodeDiskioResponse | null;
  loading: boolean;
  timeframe: MetricsTimeframe;
}) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

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

  return (
    <div className="flex h-full flex-col gap-2">
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
    </div>
  );
}

/**
 * Corps d'UNE interface du nœud : type/état (ligne discrète, conservé du titre v2)
 * + trafic RX/TX en octets/s. État vide : aucune mesure sur la fenêtre.
 */
function NodeNetIfaceBody({
  iface,
  rows,
  hasAnyPoints,
  loading,
  timeframe,
}: {
  iface: NodeNetIface;
  rows: NodeNetRow[];
  hasAnyPoints: boolean;
  loading: boolean;
  timeframe: MetricsTimeframe;
}) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const pts = useMemo(
    () => new Map<number, VmNetPoint>(rows.map((r) => [r.t, { t: r.t, inBps: r.inBps, outBps: r.outBps }])),
    [rows],
  );
  const times = useMemo(() => [...pts.keys()].sort((a, b) => a - b), [pts]);

  const option = useMemo(() => {
    if (times.length === 0) return null;
    return rateOption(ct, timeframe, times, [
      { name: t('network.rx'), data: times.map((x) => pts.get(x)?.inBps ?? null), color: ct.netIn },
      { name: t('network.tx'), data: times.map((x) => pts.get(x)?.outBps ?? null), color: ct.netOut },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, pts, ct, t, timeframe]);

  const ref = useEChart(option);

  /** fw\* (pare-feu PVE) : libellé explicite (machine · netN · rôle) ; sinon type + état. */
  const fw = iface.kind === 'firewall' ? iface.firewall : null;
  const tooltip = fw != null ? t('overview.netif.fw.tooltip', { vmid: fw.vmid, n: fw.ifIndex }) : t('overview.netif.hint');
  const parts: string[] =
    fw != null
      ? [t('overview.netif.kind.firewall'), t('overview.netif.fw.machine', { id: fw.vmid }), `net${fw.ifIndex}`, t(`overview.netif.fw.role.${fw.role}`)]
      : [t(`overview.netif.kind.${iface.kind}`)];
  if (iface.active != null) parts.push(t(iface.active ? 'overview.netif.active' : 'overview.netif.inactive'));
  const sub = parts.join(' · ');

  return (
    <div className="flex h-full flex-col gap-2">
      <p className="px-1 text-[11px] text-muted-foreground" title={tooltip}>
        {sub}
      </p>
      {loading && rows.length === 0 ? (
        <Skeleton className="min-h-[240px] w-full flex-1" />
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-muted-foreground">
          {hasAnyPoints ? t('overview.netif.ifaceNone') : t('overview.netif.none')}
        </div>
      ) : (
        <div ref={ref} className="min-h-[240px] w-full flex-1" />
      )}
    </div>
  );
}

export function NodeMonitor({ endpointId, node }: Props) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const config = useOvercommitConfig();
  const [tf, setTf] = useState<MetricsTimeframe>('day');
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [sysRows, setSysRows] = useState<NodeSystemRow[]>([]);
  const [sysLoading, setSysLoading] = useState(true);
  const { data: diskioData, loading: diskioLoading } = useNodeDiskio(node, tf);
  const { data: netData, loading: netLoading, done: netDone } = useNodeNet(node, tf);

  // Personnalisation par utilisateur : scope = « endpoint/nomDuNœud » (le
  // hostname PVE est le seul identifiant stable du nœud — renommage = nouveau scope).
  const scope = `${endpointId}/${node}`;
  const stored = useUserConfig((s) => s.config?.pages.nodeView?.[scope] ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchMetrics(tf, endpointId, node)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement métriques nœud en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpointId, node, tf, tick]);

  /** Système hôte (Telegraf 10 s) — source indépendante de node_metrics : dernier point
   *  du nœud affiché, partagé par les sections « Système » et « CPU par cœur ». */
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchNodeSystem()
        .then((r) => {
          if (!cancelled) setSysRows(r.nodes);
        })
        .catch((err) => console.warn('chargement node-system (monitor nœud) en échec', err))
        .finally(() => {
          if (!cancelled) setSysLoading(false);
        });
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  const sysRow = sysRows.find((r) => r.node === node);

  const ct = chartTheme(theme);
  const hasData = !!data && data.points.length > 0;
  const times = useMemo(() => (hasData && data ? data.points.map((p) => p.time) : []), [hasData, data]);
  const bands = { warnPct: config.usage.warnPct, critPct: config.usage.critPct };

  /** CPU : % de la capacité du nœud (0–100) + bandes de seuils overcommit.json. */
  const cpuOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return pctOption(ct, tf, times, [
      { name: t('metrics.cpu'), data: data.points.map((p) => p.cpuPct), color: ct.cpu },
    ], bands);
  }, [hasData, data, times, tf, ct, t, config]);

  /** RAM : % de la mémoire du nœud (0–100) + bandes de seuils. */
  const ramOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return pctOption(ct, tf, times, [
      { name: t('metrics.ram'), data: data.points.map((p) => p.ramPct), color: ct.ram },
    ], bands);
  }, [hasData, data, times, tf, ct, t, config]);

  /** Disque système (rootfs) : % d'occupation. */
  const diskOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return pctOption(ct, tf, times, [
      { name: t('node.kpi.rootfs'), data: data.points.map((p) => p.storagePct), color: ct.disk },
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

  const ifaces = netData?.interfaces ?? [];
  const hasAnyPoints = (netData?.rows.length ?? 0) > 0;

  /** Machines concernées par les interfaces fw\* (pare-feu PVE) — bloc « Décryptage ». */
  const fwMachines = useMemo(() => {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const i of ifaces) {
      if (i.kind !== 'firewall' || !i.firewall) continue;
      const k = `${i.firewall.vmid}/${i.firewall.ifIndex}`;
      if (seen.has(k)) continue;
      seen.add(k);
      parts.push(`${t('overview.netif.fw.machine', { id: i.firewall.vmid })} (net${i.firewall.ifIndex})`);
    }
    return parts.join(' · ');
  }, [ifaces, t]);

  // Catalogue de widgets — ORDRE VISUEL v2 : system, cpu, cpubars, ram, rootfs,
  // diskio, net, [netif-*]. Le nom du NŒUD est le SOUS-TITRE de chaque carte.
  const catalog = useMemo<CoreWidgetDef[]>(() => {
    const defs: CoreWidgetDef[] = [];
    const subtitle = node;
    defs.push(
      {
        id: 'system',
        title: t('vm.node.system'),
        subtitle,
        default: { w: 12, h: 2 },
        minH: 2,
        render: () => <NodeSystemBody row={sysRow} loading={sysLoading} />,
      },
      {
        id: 'cpu',
        title: t('metrics.cpu'),
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
            <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node, tf, 'cpu', ALL_COLS.slice(0, 1))} />
          </span>
        ),
        render: () => <StaticChartBody option={cpuOption} loading={loading} hasData={hasData} />,
      },
      {
        id: 'cpubars',
        title: t('overview.cpubars'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton
            disabled={!sysRow || (sysRow.cores?.length ?? 0) === 0}
            onClick={() => {
              if (sysRow) exportCpuCoresCsv(sysRow);
            }}
          />
        ),
        render: () => <CpuCoresBody row={sysRow} loading={sysLoading} />,
      },
      {
        id: 'ram',
        title: t('metrics.ram'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node, tf, 'ram', ALL_COLS.slice(1, 2))} />,
        render: () => <StaticChartBody option={ramOption} loading={loading} hasData={hasData} />,
      },
      {
        id: 'rootfs',
        title: t('node.kpi.rootfs'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node, tf, 'disk', ALL_COLS.slice(2, 3))} />,
        render: () => <StaticChartBody option={diskOption} loading={loading} hasData={hasData} />,
      },
      {
        id: 'diskio',
        title: t('overview.diskio'),
        subtitle,
        default: { w: 12, h: 6 },
        minH: 5,
        extra: () => (
          <ExportCsvButton
            disabled={!diskioData || diskioData.devices.length === 0}
            onClick={() => exportNodeDiskioCsv(diskioData, node, tf)}
          />
        ),
        render: () => <NodeDiskioBody data={diskioData} loading={diskioLoading} timeframe={tf} />,
      },
      {
        id: 'net',
        title: t('vm.mon.net'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node, tf, 'net', ALL_COLS.slice(3))} />,
        render: () => <StaticChartBody option={netOption} loading={loading} hasData={hasData} />,
      },
    );
    // Réseau PAR INTERFACE hôte (agent Telegraf) — UN WIDGET PAR INTERFACE.
    for (const iface of ifaces) {
      const rows = (netData?.rows ?? []).filter((r) => iface.kernels.includes(r.iface));
      defs.push({
        id: `netif-${widgetIdFrom(iface.name)}`,
        title: iface.name,
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={rows.length === 0} onClick={() => exportNodeNetIfaceCsv(iface, rows, node, tf)} />,
        render: () => (
          <NodeNetIfaceBody iface={iface} rows={rows} hasAnyPoints={hasAnyPoints} loading={netLoading} timeframe={tf} />
        ),
      });
    }
    return defs;
  }, [sysRow, sysLoading, data, hasData, diskioData, diskioLoading, netData, netLoading, ifaces, hasAnyPoints, node, tf, cpuOption, ramOption, diskOption, netOption, loading, t]);

  // Clé du catalogue (ids) — stable tant que le parc d'interfaces ne change pas.
  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);

  // La grille ne se monte qu'après le PREMIER chargement node-net : avant, les
  // ids dynamiques (netif-*) sont inconnus et le merge ferait orphelins des
  // positions stockées. (`done` passe aussi à true si le fetch a échoué — la
  // grille se monte alors sans les widgets réseau, qui reviennent au prochain tick.)
  const ready = netDone;

  const defaultLayout = useMemo(
    () => (ready ? defaultStackLayout(catalog) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogKey, ready],
  );

  // FUSION « utilisateurs présentes et futures » : positions stockées priment ;
  // interface nouvelle → ajoutée en fin de grille ; disparue → bibliothèque.
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
    updatePage('nodeView', scope, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => {
    if (!merged) return;
    updatePage('nodeView', scope, removeWidget(merged, widgetId));
  };
  const onAdd = (widgetId: string) => {
    if (!merged) return;
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('nodeView', scope, addWidget(merged, def));
  };
  const onReset = () => clearPage('nodeView', scope);

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
          onClick={() => exportNodeCsv(data, node, tf, 'all', ALL_COLS)}
          disabled={!hasData}
          title={t('vm.mon.export')}
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          {t('vm.mon.export')}
        </button>
      </div>

      {!ready ? (
        /* Premier chargement : squelette (interfaces encore inconnues). */
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[280px] w-full" />
          <Skeleton className="h-[280px] w-full" />
        </div>
      ) : (
        <>
          {/* Pas de série PVE : InfluxDB indisponible (sans repli RRD) ou nœud trop
           * récent / hors ligne. Les widgets agent hôte ont une source indépendante. */}
          {!loading && (!data || !hasData) && (
            <div className="rounded-lg border px-3 py-6 text-center text-xs text-muted-foreground">{t('vm.node.insufficient')}</div>
          )}
          {/* Réseau par interface : aide-mémoire + décryptage fw\* (si présent). */}
          {ifaces.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="px-1 text-[11px] text-muted-foreground">{t('overview.netif.hint')}</p>
              {fwMachines.length > 0 && <FwDecodeBlock list={fwMachines} />}
            </div>
          )}
          {ifaces.length === 0 && !netLoading && (
            <p className="px-1 text-[11px] text-muted-foreground">{t('overview.netif.none')}</p>
          )}

          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              {merged && (
                <WidgetGridLayout
                  catalog={catalog}
                  config={merged}
                  ctx={{ endpointId, nodeName: node }}
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
