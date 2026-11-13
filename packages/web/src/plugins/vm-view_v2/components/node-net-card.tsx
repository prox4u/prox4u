import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MetricsTimeframe, NodeNetIface, NodeNetResponse, NodeNetRow, VmNetPoint } from '@prox4u/shared';
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
 * Monitor nœud (Vue VM v2) — section « Réseau — par interface » : UNE CARTE
 * GRAPHIQUE PAR INTERFACE DU NŒUD — même liste que la page Réseau de Proxmox
 * (API PVE : ponts + cartes physiques, nom PVE dans le titre ; le joint avec
 * les mesures se fait sur le nom noyau `altnames`). Le trafic des tap des VMs
 * (vnet* / tap* / veth*) est exclu (montré dans le Monitor de chaque VM,
 * double-comptage sinon). Source des mesures : agent Telegraf (table net,
 * 10 s) — pas l'agrégat Proxmox du graphe « Réseau » ci-dessus. La LISTE des
 * interfaces est dispo même avant le (re)déploiement de l'agent (état vide par
 * carte). Nœud fixe (celui affiché), timeframe piloté par la barre d'outils.
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

  const ifaces = data?.interfaces ?? [];
  const hasAnyPoints = (data?.rows.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="px-1 text-[11px] text-muted-foreground">{t('overview.netif.hint')}</p>
      {loading && ifaces.length === 0 ? (
        <Skeleton className="w-full" style={{ height: CHART_H }} />
      ) : (
        <>
          {ifaces.map((iface) => (
            <NodeNetIfaceCard
              key={iface.name}
              iface={iface}
              rows={(data?.rows ?? []).filter((r) => iface.kernels.includes(r.iface))}
              hasAnyPoints={hasAnyPoints}
              node={node}
              timeframe={timeframe}
            />
          ))}
          {!loading && ifaces.length === 0 && (
            <div className="py-6 text-center text-[11px] text-muted-foreground">{t('overview.netif.none')}</div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Carte graphique d'UNE interface du nœud : nom PVE (titre) + type/état
 * actif, trafic RX (trait plein) / TX (pointillé) en octets/s, export CSV.
 * État vide par carte : aucune mesure sur la fenêtre (agent hôte pas encore
 * (re)déployé, interface inactive, ou nom noyau inconnu).
 */
function NodeNetIfaceCard({
  iface,
  rows,
  hasAnyPoints,
  node,
  timeframe,
}: {
  iface: NodeNetIface;
  rows: NodeNetRow[];
  hasAnyPoints: boolean;
  node: string;
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
  }, [times, pts, timeframe, ct, t]);

  const ref = useEChart(option);

  const kind = t(`overview.netif.kind.${iface.kind}`);
  const up = iface.active == null ? null : t(iface.active ? 'overview.netif.active' : 'overview.netif.inactive');
  const subtitle = [kind, up].filter(Boolean).join(' \u00b7 ');

  /** Export CSV de cette interface sur le timeframe affiché. */
  const exportCsv = () => {
    const header = ['timestamp', 'in_bps', 'out_bps'];
    const body = [...rows]
      .sort((a, b) => a.t - b.t)
      .map((r) => [
        new Date(r.t * 1000).toISOString(),
        r.inBps != null ? String(r.inBps) : '',
        r.outBps != null ? String(r.outBps) : '',
      ]);
    downloadCsvFile(`node-net-${node}-${iface.name}-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv`, header, body);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle title={t('overview.netif.hint')}>
          {iface.name}
          {subtitle ? <span className="ml-2 text-[11px] font-normal text-muted-foreground">{subtitle}</span> : null}
        </CardTitle>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          title={t('vm.mon.export')}
          className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground">
            {hasAnyPoints ? t('overview.netif.ifaceNone') : t('overview.netif.none')}
          </div>
        ) : (
          <div ref={ref} style={{ height: CHART_H }} className="w-full" />
        )}
      </CardContent>
    </Card>
  );
}
