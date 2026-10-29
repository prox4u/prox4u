import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { MetricsPoint, MetricsResponse, MetricsTimeframe } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { pctOption, rateOption, downloadCsvFile } from '../../../lib/monitor-charts';
import { fetchMetrics } from '../../../core/api/apiClient';

const TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];
/** Auto-refresh pendant que l'onglet est ouvert (données pushées toutes les 5 s côté serveur). */
const REFRESH_MS = 60_000;

interface Props {
  endpointId: string;
  /** Nom du nœud PVE — filtre `node` de /api/metrics + nom du fichier CSV exporté. */
  node: string;
}

/**
 * Onglet Monitor d'un nœud Proxmox (v2) : historiques CPU / RAM / Disque rootfs / Réseau
 * depuis InfluxDB (node_metrics via /api/metrics?node=). Même expérience que le Monitor VM :
 * un graphe par ligne, timeframes 1 h / 24 h / 7 j / 30 j, auto-refresh 60 s, export CSV
 * du timeframe affiché (général + par graphe).
 */
export function NodeMonitor({ endpointId, node }: Props) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const config = useOvercommitConfig();
  const [tf, setTf] = useState<MetricsTimeframe>('day');
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

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

  const cpuRef = useEChart(cpuOption);
  const ramRef = useEChart(ramOption);
  const diskRef = useEChart(diskOption);
  const netRef = useEChart(netOption);

  /** Colonnes CSV par point — l'export général couvre les 5 champs, chaque graphe les siens. */
  const ALL_COLS: { label: string; get: (p: MetricsPoint) => number | null }[] = [
    { label: 'cpu_pct', get: (p) => p.cpuPct },
    { label: 'ram_pct', get: (p) => p.ramPct },
    { label: 'disk_rootfs_pct', get: (p) => p.storagePct },
    { label: 'net_in_bps', get: (p) => p.netInBps },
    { label: 'net_out_bps', get: (p) => p.netOutBps },
  ];

  /**
   * Export CSV du timeframe affiché (on exporte ce qu'on voit) — BOM UTF-8 + échappement.
   * `scope` = all (général) / cpu / ram / disk / net → nom de fichier + colonnes.
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
    downloadCsvFile(`node-metrics-${node}-${scope}-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
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

      {/* Pas de série : InfluxDB indisponible (sans repli RRD) ou nœud trop récent / hors ligne. */}
      {!loading && data && !hasData ? (
        <div className="rounded-lg border px-3 py-6 text-center text-xs text-muted-foreground">
          {t('vm.node.insufficient')}
        </div>
      ) : (
        /* Un graphe par ligne (pleine largeur, plus de profondeur) + export CSV par graphe. */
        <div className="flex flex-col gap-3">
          {chartCard(t('metrics.cpu'), cpuRef, true, () => downloadCsv('cpu', ALL_COLS.slice(0, 1)))}
          {chartCard(t('metrics.ram'), ramRef, false, () => downloadCsv('ram', ALL_COLS.slice(1, 2)))}
          {chartCard(t('node.kpi.rootfs'), diskRef, false, () => downloadCsv('disk', ALL_COLS.slice(2, 3)))}
          {chartCard(t('vm.mon.net'), netRef, false, () => downloadCsv('net', ALL_COLS.slice(3)))}
        </div>
      )}
    </div>
  );
}
