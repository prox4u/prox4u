import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type {
  MetricsPoint,
  MetricsResponse,
  MetricsTimeframe,
  NodeDiskioResponse,
  NodeHostHistoryResponse,
  NodeNetIface,
  NodeNetResponse,
  NodeNetRow,
  NodeSensorsResponse,
  NodeSystemRow,
  NodeTempsResponse,
  SmartDevice,
  SmartTempsResponse,
  VmNetPoint,
  WidgetItem,
  ZfsArcResponse,
} from '@prox4u/shared';
import { addWidget, defaultStackLayout, mergePageConfig, removeWidget, smartHealthTone, smartTempDisplay, swapPct } from '@prox4u/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useTheme } from '../../../store/theme';
import { chartTheme, type ChartTheme } from '../../../lib/chart-theme';
import { pctOption, rateOption, downloadCsvFile, timeLabel } from '../../../lib/monitor-charts';
import {
  fetchMetrics,
  fetchNodeDiskio,
  fetchNodeNet,
  fetchNodeSensors,
  fetchNodeSystem,
  fetchNodeSystemHistory,
  fetchNodeTemps,
  fetchSmartTemps,
  fetchZfsArc,
} from '../../../core/api/apiClient';
import { formatBps, formatBytes } from '../../../lib/utils';
import { FwDecodeBlock } from './node-net-card';
import { CpuCoresBody } from './cpu-cores-card';
import { NodeSystemStatsGrid } from './node-system-card';
import { useUserConfig } from '../../../store/user-config';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { ExportCsvButton } from '../../../core/widgets/export-csv-button';
import { widgetIdFrom, layoutsEqual, type CoreWidgetDef } from '../../../core/widgets/types';

export const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];
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
 * Onglet Monitor d'un nœud Proxmox (v4) — GRILLE PERSONNALISABLE PAR UTILISATEUR :
 * drag/resize des cartes, retrait → bibliothèque, réinsertion, réinitialisation ;
 * persistance par compte et par nœud (scope « endpoint/nomDuNœud » — le hostname
 * PVE est le seul identifiant stable du nœud ; un renommage remet le layout à zéro).
 *
 * Catalogue de widgets (ordre = ordre visuel v4) :
 *  - system : état courant (load/iowait/swap/uptime — agent hôte Telegraf) ;
 *  - cpu / ram / rootfs / net : historiques PVE (node_metrics via /api/metrics?node=) ;
 *  - cpubars : CPU par cœur (point courant agent hôte) ;
 *  - diskio : I/O disques PAR DEVICE PHYSIQUE (1 carte, tous devices, 2 graphiques) ;
 *  - NOUVEAUTÉ v4 (bibliothèque complétée, référence ProxMenux) :
 *    - temp-cpu : températures CPU & chips (série par chip, /api/node-temps) ;
 *    - smart-temps : températures disques SMART (série par disque, /api/smart-temps) ;
 *    - smart-health : santé disques (état courant, /api/node-sensors) ;
 *    - zfs-arc : ZFS ARC (taille + max + hit rate, /api/zfs-arc) ;
 *    - load : charge moyenne 1/5/15 (/api/node-system-history) ;
 *    - swap : swap utilisé (/api/node-system-history) ;
 *  - netif-<iface> : trafic PAR INTERFACE hôte (dynamiques — une carte par interface).
 *
 * Le nom du nœud est le SOUS-TITRE de chaque carte (choix utilisateur — le nom
 * de nœud est visible sur chaque graphique).
 */

/** I/O disques du nœud (Telegraf) — fetch hoisté au niveau monitor (le catalogue
 *  a besoin des données pour le slot « export CSV » du widget `diskio`). */
export function useNodeDiskio(node: string, timeframe: MetricsTimeframe) {
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
export function useNodeNet(node: string, timeframe: MetricsTimeframe) {
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

/** Températures par chip (Telegraf sensors) — fetch hoisté (catalogue v4). */
export function useNodeTemps(node: string, timeframe: MetricsTimeframe) {
  const [data, setData] = useState<NodeTempsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchNodeTemps(node, timeframe)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement node-temps en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node, timeframe, tick]);

  return { data, loading };
}

/** Températures disques SMART (Telegraf smart_device) — fetch hoisté (catalogue v4). */
export function useSmartTemps(node: string, timeframe: MetricsTimeframe) {
  const [data, setData] = useState<SmartTempsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSmartTemps(node, timeframe)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement smart-temps en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node, timeframe, tick]);

  return { data, loading };
}

/** ZFS ARC (taille + max + hit rate) — fetch hoisté (catalogue v4). */
export function useZfsArc(node: string, timeframe: MetricsTimeframe) {
  const [data, setData] = useState<ZfsArcResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchZfsArc(node, timeframe)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement zfs-arc en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node, timeframe, tick]);

  return { data, loading };
}

/** Charge 1/5/15 + swap (Telegraf system + mem) — un fetch pour les deux widgets
 *  (widgets « Charge moyenne » et « Swap », catalogue v4). */
export function useNodeHostHistory(node: string, timeframe: MetricsTimeframe) {
  const [data, setData] = useState<NodeHostHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchNodeSystemHistory(node, timeframe)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.warn('chargement node-system-history en échec', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node, timeframe, tick]);

  return { data, loading };
}

/** Métriques locales Telegraf LIVE (SMART, capteurs, ZFS, unités) — sans timeframe
 *  (état courant, 1 min de cache serveur) : le widget « Santé disques (SMART) ». */
export function useNodeSensorsLive() {
  const [data, setData] = useState<NodeSensorsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchNodeSensors()
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch((err) => console.warn('chargement node-sensors (monitor nœud) en échec', err))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { data, loading };
}

/** Colonnes CSV par point — l'export général couvre les 5 champs, chaque graphe les siens. */
export const ALL_COLS: { label: string; get: (p: MetricsPoint) => number | null }[] = [
  { label: 'cpu_pct', get: (p) => p.cpuPct },
  { label: 'ram_pct', get: (p) => p.ramPct },
  { label: 'disk_rootfs_pct', get: (p) => p.storagePct },
  { label: 'net_in_bps', get: (p) => p.netInBps },
  { label: 'net_out_bps', get: (p) => p.netOutBps },
];

/** Export CSV d'un sous-ensemble des colonnes générales (on exporte ce qu'on voit). */
export function exportNodeCsv(
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
export function exportCpuCoresCsv(row: NodeSystemRow): void {
  const cores = row.cores ?? [];
  if (cores.length === 0) return;
  const header = ['core', 'usage_pct', 'user_pct', 'system_pct', 'iowait_pct'];
  const rows = cores.map((c) => [c.core, c.usagePct.toFixed(1), c.userPct.toFixed(1), c.systemPct.toFixed(1), c.iowaitPct.toFixed(1)]);
  downloadCsvFile(`node-cpu-cores-${row.node}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

/** Export CSV de l'I/O disques du nœud (tous devices). */
export function exportNodeDiskioCsv(data: NodeDiskioResponse | null, node: string, timeframe: MetricsTimeframe): void {
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
export function exportNodeNetIfaceCsv(iface: NodeNetIface, rows: NodeNetRow[], node: string, timeframe: MetricsTimeframe): void {
  const header = ['timestamp', 'in_bps', 'out_bps'];
  const body = [...rows]
    .sort((a, b) => a.t - b.t)
    .map((r) => [new Date(r.t * 1000).toISOString(), r.inBps != null ? String(r.inBps) : '', r.outBps != null ? String(r.outBps) : '']);
  downloadCsvFile(`node-net-${node}-${iface.name}-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv`, header, body);
}

/** Export CSV des températures par chip (une ligne par (chip, bucket)). */
export function exportNodeTempsCsv(data: NodeTempsResponse | null, node: string, tf: MetricsTimeframe): void {
  if (!data || data.series.length === 0) return;
  const rows: string[][] = [];
  for (const s of data.series) for (const p of s.points) rows.push([new Date(p.t * 1000).toISOString(), s.chip, String(p.temp)]);
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  downloadCsvFile(`node-temps-${node}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, ['timestamp', 'chip', 'temp_c'], rows);
}

/** Export CSV des températures disques SMART (une ligne par (device, bucket)). */
export function exportSmartTempsCsv(data: SmartTempsResponse | null, node: string, tf: MetricsTimeframe): void {
  if (!data || data.series.length === 0) return;
  const rows: string[][] = [];
  for (const s of data.series)
    for (const p of s.points) rows.push([new Date(p.t * 1000).toISOString(), s.device, s.model ?? '', String(p.temp)]);
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  downloadCsvFile(`node-smart-temps-${node}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, ['timestamp', 'device', 'model', 'temp_c'], rows);
}

/** Export CSV ZFS ARC (taille en octets + hit rate % — null = série masquée). */
export function exportZfsArcCsv(data: ZfsArcResponse | null, node: string, tf: MetricsTimeframe): void {
  if (!data || data.points.length === 0) return;
  const rows = data.points.map((p) => [
    new Date(p.t * 1000).toISOString(),
    p.sizeBytes != null ? String(p.sizeBytes) : '',
    p.maxBytes != null ? String(p.maxBytes) : '',
    p.hitRatePct != null ? p.hitRatePct.toFixed(2) : '',
  ]);
  downloadCsvFile(`node-zfs-arc-${node}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, ['timestamp', 'arc_size_bytes', 'arc_max_bytes', 'hit_rate_pct'], rows);
}

/** Export CSV charge + swap — `scope` = colonnes (load et/ou swap). */
export function exportHostHistoryCsv(data: NodeHostHistoryResponse | null, node: string, tf: MetricsTimeframe, scope: 'load' | 'swap'): void {
  if (!data || data.points.length === 0) return;
  const cols: string[] = scope === 'load' ? ['load1', 'load5', 'load15', 'n_cpus'] : ['swap_used_bytes', 'swap_total_bytes'];
  const get = (p: NodeHostHistoryResponse['points'][number], c: string): string => {
    if (scope === 'load') {
      const v = c === 'n_cpus' ? p.nCpus : c === 'load1' ? p.load1 : c === 'load5' ? p.load5 : p.load15;
      return v != null ? String(v) : '';
    }
    const v = c === 'swap_used_bytes' ? p.swapUsedBytes : p.swapTotalBytes;
    return v != null ? String(v) : '';
  };
  const rows = data.points.map((p) => [new Date(p.t * 1000).toISOString(), ...cols.map((c) => get(p, c))]);
  downloadCsvFile(`node-${scope === 'load' ? 'load' : 'swap'}-${node}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, ['timestamp', ...cols], rows);
}

/** Export CSV santé disques SMART (état courant — une ligne par disque). */
export function exportSmartHealthCsv(devices: SmartDevice[], node: string): void {
  if (devices.length === 0) return;
  const rows = devices.map((d) => [
    d.node,
    d.device,
    d.model ?? '',
    d.healthOk === null ? 'unknown' : d.healthOk ? 'healthy' : 'unhealthy',
    String(d.tempC),
    d.powerOnHours != null ? String(d.powerOnHours) : '',
    d.percentageUsed != null ? String(d.percentageUsed) : '',
    d.reallocatedSectors != null ? String(d.reallocatedSectors) : '',
    d.pendingSectors != null ? String(d.pendingSectors) : '',
    d.uncorrectableSectors != null ? String(d.uncorrectableSectors) : '',
  ]);
  downloadCsvFile(`node-smart-health-${node}-${new Date().toISOString().slice(0, 10)}.csv`, ['node', 'device', 'model', 'health', 'temp_c', 'power_on_hours', 'percentage_used', 'reallocated_sectors', 'pending_sectors', 'uncorrectable_sectors'], rows);
}

/** Corps de carte graphe générique (CPU/RAM/rootfs/réseau PVE). */
export function StaticChartBody({ option, loading, hasData }: { option: EChartsOption | null; loading: boolean; hasData: boolean }) {
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
 * Graphe multi-séries linéaire générique (catalogue v4 — températures capteurs,
 * températures SMART, ZFS ARC, charge, swap). Axe gauche (valeur, format
 * libre) + axe DROIT optionnel en % (séries `yAxisIndex: 1`) + ligne de
 * référence optionnelle (`markLine` — ex. ARC max, seuil critique 80 °C).
 */
function multiLineOption(
  ct: ChartTheme,
  tf: MetricsTimeframe,
  times: number[],
  series: Array<{ name: string; data: Array<number | null>; color: string; dashed?: boolean; area?: boolean; yAxisIndex?: 0 | 1 }>,
  opts: {
    leftFormat?: (v: number) => string;
    rightFormat?: (v: number) => string;
    rightRange?: [number, number];
    /** Tooltip custom (nécessaire quand les axes ont des unités différentes). */
    tooltipFormatter?: (params: unknown) => string;
    markLine?: { y: number; label: string };
  } = {},
): EChartsOption {
  const hasRight = series.some((s) => s.yAxisIndex === 1);
  return {
    animation: false,
    grid: { top: 32, right: hasRight ? 44 : 16, bottom: 20, left: 52 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: ct.tooltipBg,
      borderColor: ct.tooltipBorder,
      textStyle: { color: ct.tooltipText, fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
      ...(opts.tooltipFormatter
        ? { formatter: opts.tooltipFormatter }
        : { valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(1) : String(v)) }),
    },
    legend:
      series.length > 1
        ? { top: 0, right: 0, itemWidth: 12, itemHeight: 3, textStyle: { color: ct.legend, fontSize: 10 }, data: series.map((s) => s.name) }
        : undefined,
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: times,
      axisLine: { lineStyle: { color: ct.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: (v: string) => timeLabel(Number(v), tf) },
    },
    yAxis: hasRight
      ? [
          {
            type: 'value',
            axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: opts.leftFormat ?? undefined },
            splitLine: { lineStyle: { color: ct.splitLine } },
          },
          {
            type: 'value',
            position: 'right',
            min: opts.rightRange?.[0] ?? 0,
            max: opts.rightRange?.[1],
            axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: opts.rightFormat ?? undefined },
            splitLine: { show: false },
          },
        ]
      : {
          type: 'value',
          axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: opts.leftFormat ?? undefined },
          splitLine: { lineStyle: { color: ct.splitLine } },
        },
    series: series.map((s) => ({
      name: s.name,
      type: 'line' as const,
      smooth: true,
      symbol: 'none',
      ...(s.yAxisIndex === 1 ? { yAxisIndex: 1 as const } : {}),
      data: s.data,
      lineStyle: { width: 2, ...(s.dashed ? { type: 'dashed' as const } : {}), color: s.color },
      itemStyle: { color: s.color },
      ...(s.area
        ? {
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: `${s.color}44` },
                  { offset: 1, color: `${s.color}00` },
                ],
              },
            },
          }
        : {}),
      // Ligne de référence horizontale (ARC max / seuil critique) — portée par la 1re série.
      ...(opts.markLine && s === series[0]
        ? {
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { type: 'dashed' as const, color: ct.axisLine },
              label: { color: ct.legend, fontSize: 9, formatter: opts.markLine.label },
              data: [{ yAxis: opts.markLine.y }],
            },
          }
        : {}),
    })),
  };
}

/** Palette multi-courbes (jusqu'à 6 chips / disques distincts). */
function multiPalette(ct: ChartTheme): string[] {
  return [ct.temp, ct.cpu, ct.ram, ct.disk, ct.netIn, ct.netOut];
}

/** Tooltip de température : valeur en °C par série + libellé de temps. */
function fmtTempTooltip(tf: MetricsTimeframe) {
  return (params: unknown) => {
    const arr = params as Array<{ axisValue: string | number; seriesName: string; value: number | null; marker: string }>;
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const head = timeLabel(Number(arr[0].axisValue), tf);
    const lines = arr.map((p) => `${p.marker} ${p.seriesName} : ${typeof p.value === 'number' ? `${p.value.toFixed(1)} °C` : '—'}`);
    return `${head}<br/>${lines.join('<br/>')}`;
  };
}

/**
 * Corps « Températures CPU & chips » (v4) — une courbe par chip (la plus haute
 * température du chip par bucket, lm-sensors). État vide : aucun capteur.
 */
export function HostTempsBody({ data, loading, timeframe }: { data: NodeTempsResponse | null; loading: boolean; timeframe: MetricsTimeframe }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const times = useMemo(() => {
    const s = new Set<number>();
    for (const ser of data?.series ?? []) for (const p of ser.points) s.add(p.t);
    return [...s].sort((a, b) => a - b);
  }, [data]);

  const byChip = useMemo(
    () => new Map((data?.series ?? []).map((ser) => [ser.chip, new Map(ser.points.map((p) => [p.t, p.temp]))])),
    [data],
  );

  const option = useMemo(() => {
    if (times.length === 0 || !data || data.series.length === 0) return null;
    const palette = multiPalette(ct);
    return multiLineOption(
      ct,
      timeframe,
      times,
      data.series.map((ser, i) => ({
        name: ser.chip,
        data: times.map((x) => byChip.get(ser.chip)?.get(x) ?? null),
        color: palette[i % palette.length],
      })),
      { leftFormat: (v) => `${v} °C`, tooltipFormatter: fmtTempTooltip(timeframe) },
    );
  }, [times, data, byChip, ct, timeframe]);

  const ref = useEChart(option);
  const empty = !!data && data.series.length === 0;
  return (
    <div className="flex h-full flex-col">
      {loading && times.length === 0 ? (
        <Skeleton className="min-h-[260px] w-full flex-1" />
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">{t('vm.node.temps.none')}</div>
      ) : (
        <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

/**
 * Corps « Températures disques (SMART) » (v4) — une courbe par disque avec
 * capteur (les disques à 0 °C sont exclus côté requête) + ligne de référence
 * au seuil critique 80 °C (convention page Capteurs nœuds).
 */
export function SmartTempsBody({ data, loading, timeframe }: { data: SmartTempsResponse | null; loading: boolean; timeframe: MetricsTimeframe }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const times = useMemo(() => {
    const s = new Set<number>();
    for (const ser of data?.series ?? []) for (const p of ser.points) s.add(p.t);
    return [...s].sort((a, b) => a - b);
  }, [data]);

  const byDev = useMemo(
    () => new Map((data?.series ?? []).map((ser) => [ser.device, new Map(ser.points.map((p) => [p.t, p.temp]))])),
    [data],
  );

  const option = useMemo(() => {
    if (times.length === 0 || !data || data.series.length === 0) return null;
    const palette = multiPalette(ct);
    return multiLineOption(
      ct,
      timeframe,
      times,
      data.series.map((ser, i) => ({
        name: ser.model ? `${ser.device} · ${ser.model}` : ser.device,
        data: times.map((x) => byDev.get(ser.device)?.get(x) ?? null),
        color: palette[i % palette.length],
      })),
      { leftFormat: (v) => `${v} °C`, markLine: { y: 80, label: t('nodeSensors.history.smartThreshold') }, tooltipFormatter: fmtTempTooltip(timeframe) },
    );
  }, [times, data, byDev, ct, timeframe, t]);

  const ref = useEChart(option);
  const empty = !!data && data.series.length === 0;
  return (
    <div className="flex h-full flex-col">
      {loading && times.length === 0 ? (
        <Skeleton className="min-h-[260px] w-full flex-1" />
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">{t('vm.node.smartTemps.none')}</div>
      ) : (
        <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

/**
 * Corps « ZFS ARC » (v4) — taille ARC courante (GiB, aire) + ARC max en ligne
 * de référence + hit rate % (axe droit, MASQUÉ si tous les compteurs sont à 0 —
 * pattern ProxMenux : pas de série inventée sur un node sans pool ZFS actif).
 */
export function ZfsArcBody({ data, loading, timeframe }: { data: ZfsArcResponse | null; loading: boolean; timeframe: MetricsTimeframe }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const points = data?.points ?? [];
  const times = useMemo(() => points.map((p) => p.t), [points]);
  const hasHitRate = useMemo(() => points.some((p) => p.hitRatePct != null), [points]);
  const maxGiB = useMemo(() => {
    const mb = points.find((p) => p.maxBytes != null)?.maxBytes;
    return mb != null ? mb / 2 ** 30 : null;
  }, [points]);

  const sizeLabel = t('vm.node.zfsArc.size');
  const hitLabel = t('vm.node.zfsArc.hitRate');
  const option = useMemo(() => {
    if (times.length === 0) return null;
    return multiLineOption(
      ct,
      timeframe,
      times,
      [
        { name: sizeLabel, data: points.map((p) => (p.sizeBytes != null ? p.sizeBytes / 2 ** 30 : null)), color: ct.disk, area: true },
        ...(hasHitRate
          ? [{ name: hitLabel, data: points.map((p) => p.hitRatePct), color: ct.netIn, dashed: true, yAxisIndex: 1 as const }]
          : []),
      ],
      {
        leftFormat: (v) => `${v.toFixed(1)} GiB`,
        rightFormat: (v) => `${v.toFixed(0)} %`,
        rightRange: [0, 100],
        markLine: maxGiB != null ? { y: maxGiB, label: t('vm.node.zfsArc.max') } : undefined,
        tooltipFormatter: (params) => {
          const arr = params as Array<{ axisValue: string | number; seriesName: string; value: number | null; marker: string }>;
          if (!Array.isArray(arr) || arr.length === 0) return '';
          const head = timeLabel(Number(arr[0].axisValue), timeframe);
          const lines = arr.map((p) => {
            const v =
              typeof p.value === 'number'
                ? p.seriesName === hitLabel
                  ? `${p.value.toFixed(1)} %`
                  : `${p.value.toFixed(2)} GiB`
                : '—';
            return `${p.marker} ${p.seriesName} : ${v}`;
          });
          return `${head}<br/>${lines.join('<br/>')}`;
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, points, hasHitRate, maxGiB, ct, timeframe, sizeLabel, hitLabel, t]);

  const ref = useEChart(option);
  const empty = !!data && data.points.length === 0;
  return (
    <div className="flex h-full flex-col">
      {loading && times.length === 0 ? (
        <Skeleton className="min-h-[260px] w-full flex-1" />
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">{t('vm.node.zfsArc.none')}</div>
      ) : (
        <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

/**
 * Corps « Charge moyenne » (v4) — load 1/5/15 (pic par bucket, table `system`).
 * Le nombre de cœurs est rappelé sous le titre : la charge se lit par rapport
 * à la capacité (load = nCœurs ≈ saturation).
 */
export function LoadBody({ data, loading, timeframe }: { data: NodeHostHistoryResponse | null; loading: boolean; timeframe: MetricsTimeframe }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const points = data?.points ?? [];
  const times = useMemo(() => points.map((p) => p.t), [points]);
  const hasLoad = useMemo(() => points.some((p) => p.load1 != null || p.load5 != null || p.load15 != null), [points]);
  const nCpus = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].nCpus != null) return points[i].nCpus;
    }
    return null;
  }, [points]);

  const option = useMemo(() => {
    if (!hasLoad || times.length === 0) return null;
    return multiLineOption(ct, timeframe, times, [
      { name: t('vm.node.load.l1'), data: points.map((p) => p.load1), color: ct.cpu },
      { name: t('vm.node.load.l5'), data: points.map((p) => p.load5), color: ct.ram },
      { name: t('vm.node.load.l15'), data: points.map((p) => p.load15), color: ct.disk },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLoad, times, points, ct, timeframe, t]);

  const ref = useEChart(option);
  const empty = !!data && data.points.length > 0 && !hasLoad;
  return (
    <div className="flex h-full flex-col gap-1">
      {nCpus != null && (
        <p className="px-1 text-[11px] text-muted-foreground">
          {t('overview.system.cores')} : {nCpus}
        </p>
      )}
      {loading && times.length === 0 ? (
        <Skeleton className="min-h-[240px] w-full flex-1" />
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">{t('vm.node.load.none')}</div>
      ) : (
        <div ref={ref} className={`min-h-[240px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

/**
 * Corps « Swap » (v4) — swap utilisé (MiB, aire) + % utilisé (axe droit).
 * Deux états vides distincts : aucune mesure (agent inactif) vs swap TOTAL = 0
 * (pas de swap configuré — normal sur beaucoup de nœuds PVE).
 */
export function SwapBody({ data, loading, timeframe }: { data: NodeHostHistoryResponse | null; loading: boolean; timeframe: MetricsTimeframe }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const points = data?.points ?? [];
  const times = useMemo(() => points.map((p) => p.t), [points]);
  const hasSwap = useMemo(() => points.some((p) => p.swapTotalBytes != null && p.swapTotalBytes > 0), [points]);

  const usedLabel = t('vm.node.swap.used');
  const pctLabel = t('vm.node.swap.pct');
  const option = useMemo(() => {
    if (!hasSwap || times.length === 0) return null;
    return multiLineOption(
      ct,
      timeframe,
      times,
      [
        { name: usedLabel, data: points.map((p) => (p.swapUsedBytes != null ? p.swapUsedBytes / 2 ** 20 : null)), color: ct.diskRead, area: true },
        { name: pctLabel, data: points.map((p) => swapPct(p.swapUsedBytes, p.swapTotalBytes)), color: ct.diskWrite, dashed: true, yAxisIndex: 1 },
      ],
      {
        leftFormat: (v) => formatBytes(v * 2 ** 20),
        rightFormat: (v) => `${v.toFixed(0)} %`,
        rightRange: [0, 100],
        tooltipFormatter: (params) => {
          const arr = params as Array<{ axisValue: string | number; seriesName: string; value: number | null; marker: string }>;
          if (!Array.isArray(arr) || arr.length === 0) return '';
          const head = timeLabel(Number(arr[0].axisValue), timeframe);
          const lines = arr.map((p) => {
            const v =
              typeof p.value === 'number'
                ? p.seriesName === pctLabel
                  ? `${p.value.toFixed(1)} %`
                  : formatBytes(p.value * 2 ** 20)
                : '—';
            return `${p.marker} ${p.seriesName} : ${v}`;
          });
          return `${head}<br/>${lines.join('<br/>')}`;
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSwap, times, points, ct, timeframe, usedLabel, pctLabel]);

  const ref = useEChart(option);
  const empty = !!data && data.points.length > 0 && !hasSwap;
  return (
    <div className="flex h-full flex-col">
      {loading && times.length === 0 ? (
        <Skeleton className="min-h-[260px] w-full flex-1" />
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">{t('vm.node.swap.noSwap')}</div>
      ) : (
        <div ref={ref} className={`min-h-[260px] w-full flex-1 ${loading ? 'opacity-50' : ''}`} />
      )}
    </div>
  );
}

/**
 * Corps « Santé disques (SMART) » (v4) — état COURANT par disque (live, sans
 * timeframe) : badge santé tri-state, température (0 °C = pas de capteur → « — »),
 * usure NVMe / secteurs défectueux (rouge si > 0), heures de fonctionnement.
 */
export function SmartHealthBody({ devices, loading, node }: { devices: SmartDevice[]; loading: boolean; node: string }) {
  const { t } = useTranslation();
  const rows = useMemo(
    () => devices.filter((d) => d.node === node).sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true })),
    [devices, node],
  );

  if (loading && rows.length === 0) return <Skeleton className="h-24 w-full" />;
  if (rows.length === 0) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">{t('nodeSensors.noSmart')}</div>;
  }

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto">
      {rows.map((d) => {
        const temp = smartTempDisplay(d.tempC).value; // 0 °C = pas de lecture → « — »
        const tone = smartHealthTone(d.healthOk);
        const badge = tone === 'crit' ? 'bg-crit/15 text-crit' : tone === 'unknown' ? 'bg-muted text-muted-foreground' : 'bg-ok/15 text-ok';
        const label = tone === 'unknown' ? t('nodeSensors.unknown') : d.healthOk ? t('nodeSensors.healthy') : t('nodeSensors.unhealthy');
        const tempCls = temp === null ? 'text-muted-foreground' : temp >= 80 ? 'text-crit' : temp >= 60 ? 'text-warn' : 'text-foreground';
        const badSectors = [
          { v: d.reallocatedSectors, key: 'vm.node.smartHealth.reallocated' },
          { v: d.pendingSectors, key: 'vm.node.smartHealth.pending' },
          { v: d.uncorrectableSectors, key: 'vm.node.smartHealth.uncorrectable' },
        ].filter((x) => x.v != null && x.v > 0);
        const sectorsTitle = badSectors.map((x) => `${t(x.key)} : ${x.v}`).join(' · ');
        const wearText =
          d.percentageUsed != null
            ? `${t('nodeSensors.wear')} ${d.percentageUsed}%`
            : badSectors.length > 0
              ? `${badSectors.reduce((acc, x) => acc + (x.v ?? 0), 0)} ${t('vm.node.smartHealth.sectors')}`
              : '—';
        return (
          <div key={`${d.node}/${d.device}`} className="flex items-center gap-2 text-xs" title={sectorsTitle || undefined}>
            <span className="w-20 shrink-0 font-mono font-medium">{d.device}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.model ?? '—'}</span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge}`}>{label}</span>
            <span className={`w-14 shrink-0 text-right tabular-nums ${tempCls}`}>{temp !== null ? `${temp} °C` : '—'}</span>
            <span className={`w-24 shrink-0 text-right tabular-nums ${badSectors.length > 0 ? 'font-medium text-crit' : 'text-muted-foreground'}`}>{wearText}</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{d.powerOnHours != null ? `${d.powerOnHours} h` : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Corps « Système (nœud) » : état courant — load 1/5/15, iowait, swap, uptime. */
export function NodeSystemBody({ row, loading }: { row: NodeSystemRow | undefined; loading: boolean }) {
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

export function NodeDiskioBody({
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
export function NodeNetIfaceBody({
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
  // v4 — historiques de jauges hôte (tables Telegraf raw) + état courant SMART.
  const { data: tempsData, loading: tempsLoading } = useNodeTemps(node, tf);
  const { data: smartTempsData, loading: smartTempsLoading } = useSmartTemps(node, tf);
  const { data: zfsArcData, loading: zfsArcLoading } = useZfsArc(node, tf);
  const { data: hostHistData, loading: hostHistLoading } = useNodeHostHistory(node, tf);
  const { data: sensorsData, loading: sensorsLoading } = useNodeSensorsLive();
  const smartDevices = sensorsData?.smart ?? [];

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

  // Catalogue de widgets — ORDRE VISUEL v4 : system, cpu, cpubars, ram, rootfs,
  // diskio, net, [v4 : temp-cpu, smart-temps, smart-health, zfs-arc, load, swap],
  // [netif-*]. Le nom du NŒUD est le SOUS-TITRE de chaque carte.
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
      // ── v4 : bibliothèque complétée (référence ProxMenux) — jauges hôte Telegraf ──
      {
        id: 'temp-cpu',
        title: t('vm.node.temps'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton disabled={!tempsData || tempsData.series.length === 0} onClick={() => exportNodeTempsCsv(tempsData, node, tf)} />
        ),
        render: () => <HostTempsBody data={tempsData} loading={tempsLoading} timeframe={tf} />,
      },
      {
        id: 'smart-temps',
        title: t('vm.node.smartTemps'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton disabled={!smartTempsData || smartTempsData.series.length === 0} onClick={() => exportSmartTempsCsv(smartTempsData, node, tf)} />
        ),
        render: () => <SmartTempsBody data={smartTempsData} loading={smartTempsLoading} timeframe={tf} />,
      },
      {
        id: 'smart-health',
        title: t('nodeSensors.smart'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton
            disabled={smartDevices.filter((d) => d.node === node).length === 0}
            onClick={() => exportSmartHealthCsv(smartDevices.filter((d) => d.node === node), node)}
          />
        ),
        render: () => <SmartHealthBody devices={smartDevices} loading={sensorsLoading} node={node} />,
      },
      {
        id: 'zfs-arc',
        title: t('vm.node.zfsArc'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton disabled={!zfsArcData || zfsArcData.points.length === 0} onClick={() => exportZfsArcCsv(zfsArcData, node, tf)} />
        ),
        render: () => <ZfsArcBody data={zfsArcData} loading={zfsArcLoading} timeframe={tf} />,
      },
      {
        id: 'load',
        title: t('vm.node.load'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton
            disabled={!hostHistData || hostHistData.points.length === 0}
            onClick={() => exportHostHistoryCsv(hostHistData, node, tf, 'load')}
          />
        ),
        render: () => <LoadBody data={hostHistData} loading={hostHistLoading} timeframe={tf} />,
      },
      {
        id: 'swap',
        title: t('vm.node.swap'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton
            disabled={!hostHistData || hostHistData.points.length === 0}
            onClick={() => exportHostHistoryCsv(hostHistData, node, tf, 'swap')}
          />
        ),
        render: () => <SwapBody data={hostHistData} loading={hostHistLoading} timeframe={tf} />,
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
  }, [
    sysRow,
    sysLoading,
    data,
    hasData,
    diskioData,
    diskioLoading,
    netData,
    netLoading,
    ifaces,
    hasAnyPoints,
    node,
    tf,
    cpuOption,
    ramOption,
    diskOption,
    netOption,
    loading,
    tempsData,
    tempsLoading,
    smartTempsData,
    smartTempsLoading,
    smartDevices,
    sensorsLoading,
    zfsArcData,
    zfsArcLoading,
    hostHistData,
    hostHistLoading,
    t,
  ]);

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
