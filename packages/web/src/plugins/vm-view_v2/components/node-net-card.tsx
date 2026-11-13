import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MetricsTimeframe, NodeNetResponse, VmNetPoint } from '@prox4u/shared';
import { fetchNodeNet } from '../../../core/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { downloadCsvFile, rateOption } from '../../../lib/monitor-charts';

/** Trous = null (jamais d'interpolation) ; le graphe se met à jour à chaque tick 60 s. */
const REFRESH_MS = 60_000;
/** Hauteur d'un graphe par interface (pleine largeur dans l'onglet Monitor). */
const CHART_H = 240;

/**
 * Monitor nœud (Vue VM v2) — section « Réseau — par interface » : UN GRAPHIQUE
 * PAR INTERFACE HÔTE (NICs physiques + ponts vmbr*) — le trafic des tap des
 * VMs (vnet* / tap* / veth*) est exclu (montré dans le Monitor de chaque VM,
 * double-comptage sinon). Source : agent Telegraf (table net, 10 s) — pas
 * l'agrégat Proxmox du graphe « Réseau » ci-dessus. Nœud fixe (celui affiché),
 * timeframe piloté par la barre d'outils de l'onglet.
 */
export function NodeNetCard({ node, timeframe }: { node: string; timeframe: MetricsTimeframe }) {
  const { t } = useTranslation();
  const [data, setData] = useState<NodeNetResponse | null>(null);
  const [loading, setLoading] = useState(true);
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
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node, timeframe, tick]);

  /** Base de temps commune (union des buckets) — trous = null dans chaque série. */
  const times = useMemo(() => {
    const s = new Set<number>();
    for (const r of data?.rows ?? []) s.add(r.t);
    return [...s].sort((a, b) => a - b);
  }, [data]);

  const ifaces = useMemo(() => {
    const m = new Map<string, Map<number, VmNetPoint>>();
    for (const r of data?.rows ?? []) {
      const pts = m.get(r.iface) ?? new Map<number, VmNetPoint>();
      pts.set(r.t, { t: r.t, inBps: r.inBps, outBps: r.outBps });
      m.set(r.iface, pts);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [data]);

  /** Export CSV du timeframe affiché — mêmes conventions que le reste de l'onglet Monitor. */
  const exportCsv = () => {
    if (!data || data.rows.length === 0) return;
    const header = ['timestamp', 'iface', 'in_bps', 'out_bps'];
    const rows = [...data.rows]
      .sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }) || a.t - b.t)
      .map((r) => [
        new Date(r.t * 1000).toISOString(),
        r.iface,
        r.inBps != null ? String(r.inBps) : '',
        r.outBps != null ? String(r.outBps) : '',
      ]);
    downloadCsvFile(`node-net-${node}-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle title={t('overview.netif.hint')}>{t('overview.netif')}</CardTitle>
        <button
          onClick={exportCsv}
          disabled={!data || data.rows.length === 0}
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
            {ifaces.map(([iface, pts]) => (
              <NodeNetIfaceChart key={iface} iface={iface} times={times} pts={pts} timeframe={timeframe} />
            ))}
            {data && !loading && times.length === 0 && (
              <div className="pb-1 text-center text-[11px] text-muted-foreground">{t('overview.netif.none')}</div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Graphe de débit d'UNE interface hôte : RX (trait plein) + TX (pointillé), octets/s. */
function NodeNetIfaceChart({
  iface,
  times,
  pts,
  timeframe,
}: {
  iface: string;
  times: number[];
  pts: Map<number, VmNetPoint>;
  timeframe: MetricsTimeframe;
}) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const option = useMemo(() => {
    if (times.length === 0) return null;
    return rateOption(ct, timeframe, times, [
      { name: t('network.rx'), data: times.map((x) => pts.get(x)?.inBps ?? null), color: ct.netIn },
      { name: t('network.tx'), data: times.map((x) => pts.get(x)?.outBps ?? null), color: ct.netOut },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, pts, timeframe, ct, t]);

  const ref = useEChart(option);

  return (
    <div>
      <div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{iface}</div>
      <div ref={ref} style={{ height: CHART_H }} className="w-full" />
    </div>
  );
}
