import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import { AlertTriangle, ArrowLeft, Download, Loader2 } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { MetricsTimeframe, MetricsResponse, NodeHardwareRow, NodeSystemRow, WidgetItem } from '@prox4u/shared';
import { addWidget, mergePageConfig, removeWidget, overcommitTone } from '@prox4u/shared';
import { useDashboard } from '../../../core/data/dashboard';
import { useEndpoint, useOvercommitConfig } from '../../../core/data/use-endpoint';
import { fetchMetrics, fetchNodeHardware, fetchNodeSystem } from '../../../core/api/apiClient';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';
import { formatBytes, formatUptime } from '../../../lib/utils';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { pctOption, rateOption } from '../../../lib/monitor-charts';
import { useUserConfig } from '../../../store/user-config';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { ExportCsvButton } from '../../../core/widgets/export-csv-button';
import { layoutsEqual, widgetIdFrom, type CoreWidgetDef } from '../../../core/widgets/types';
// Réemploi cross-plugin (vm-view_v4) — composants du Monitor nœud (import statique,
// bundlé au build : fonctionne quel que soit l'état du plugin vm-view).
import {
  TIMEFRAMES,
  ALL_COLS,
  useNodeDiskio,
  useNodeNet,
  useNodeTemps,
  useSmartTemps,
  useZfsArc,
  useNodeHostHistory,
  useNodeSensorsLive,
  StaticChartBody,
  HostTempsBody,
  SmartTempsBody,
  ZfsArcBody,
  LoadBody,
  SwapBody,
  SmartHealthBody,
  NodeSystemBody,
  NodeDiskioBody,
  NodeNetIfaceBody,
  exportNodeCsv,
  exportCpuCoresCsv,
  exportNodeDiskioCsv,
  exportNodeNetIfaceCsv,
  exportNodeTempsCsv,
  exportSmartTempsCsv,
  exportZfsArcCsv,
  exportHostHistoryCsv,
  exportSmartHealthCsv,
} from '../../vm-view_v4/components/node-monitor';
import { CpuCoresBody } from '../../vm-view_v4/components/cpu-cores-card';
import { FwDecodeBlock } from '../../vm-view_v4/components/node-net-card';
import { CapacityBody, HostDetailsBody, StatBody, VmTableBody, nodeDefaultLayout } from '../components/node-widgets';

/** Tick de rafraîchissement des graphiques (identique au Monitor nœud vm-view_v4). */
const REFRESH_MS = 60_000;

/**
 * Page NŒUD v4 — grille unifiée personnalisable par utilisateur :
 * les 4 KPIs d'état courant + la table VMs + TOUS les graphiques du Monitor nœud
 * (système, CPU par cœur, I/O par disque, réseau par interface, températures,
 * SMART, ZFS ARC, charge, swap — réemployés depuis vm-view_v4) sont
 * déplaçables/retraitables. Persistance par compte, scope « nodePage »
 * (un layout par « endpointId/nomDuNœud »).
 *
 * Le nom du NŒUD est le sous-titre de chaque carte de graphique.
 *
 * Règle des hooks : TOUS les hooks (useState/useEffect/useMemo) sont appelés
 * AVANT les early returns — les valeurs dérivées du snapshot sont calculées
 * avec guards optionnels (`ep?.snapshot?.…`) pour rester inconditionnelles.
 */
export function NodePage() {
  const { t } = useTranslation();
  const { endpointId, nodeId } = useParams<{ endpointId: string; nodeId: string }>();
  const ep = useEndpoint(endpointId);
  const config = useOvercommitConfig();
  const multiLoaded = useDashboard((s) => s.multi !== null);
  const theme = useTheme((s) => s.theme);

  // ── Timeframe (piloté par la barre d'outils) + données PVE (cpu/ram/rootfs/net) ──
  const [tf, setTf] = useState<MetricsTimeframe>('day');
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // ── Système hôte (Telegraf) — dernier point du nœud (widgets « Système » + « CPU par cœur ») ──
  const [sysRows, setSysRows] = useState<NodeSystemRow[]>([]);
  const [sysLoading, setSysLoading] = useState(true);

  // ── Graphiques agent hôte (hooks auto-contenus, tick 60 s) — réemployés depuis vm-view_v4 ──
  const { data: diskioData, loading: diskioLoading } = useNodeDiskio(nodeId ?? '', tf);
  const { data: netData, loading: netLoading, done: netDone } = useNodeNet(nodeId ?? '', tf);
  const { data: tempsData, loading: tempsLoading } = useNodeTemps(nodeId ?? '', tf);
  const { data: smartTempsData, loading: smartTempsLoading } = useSmartTemps(nodeId ?? '', tf);
  const { data: zfsArcData, loading: zfsArcLoading } = useZfsArc(nodeId ?? '', tf);
  const { data: hostHistData, loading: hostHistLoading } = useNodeHostHistory(nodeId ?? '', tf);
  const { data: sensorsData, loading: sensorsLoading } = useNodeSensorsLive();
  const smartDevices = sensorsData?.smart ?? [];

  // Personnalisation par utilisateur : scope « endpointId/nomDuNœud ».
  const scope = `${endpointId}/${nodeId}`;
  const stored = useUserConfig((s) => s.config?.pages.nodePage?.[scope] ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!endpointId || !nodeId) return;
    let cancelled = false;
    setLoading(true);
    fetchMetrics(tf, endpointId, nodeId)
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
  }, [endpointId, nodeId, tf, tick]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchNodeSystem()
        .then((r) => {
          if (!cancelled) setSysRows(r.nodes);
        })
        .catch((err) => console.warn('chargement node-system en échec', err))
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
  const sysRow = sysRows.find((r) => r.node === nodeId);

  // ── Empreinte matérielle (modèle CPU + DMI) — quasi-statique, widget « Détails hôte » ──
  const [hwRows, setHwRows] = useState<NodeHardwareRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchNodeHardware()
        .then((r) => {
          if (!cancelled) setHwRows(r.nodes);
        })
        .catch((err) => console.warn('chargement node-hardware en échec', err));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  const hwRow = hwRows.find((r) => r.node === nodeId);

  // ── Dérivés du snapshot (guards optionnels — AVANT les early returns) ──
  const node = ep?.snapshot?.nodes.find((n) => n.node === nodeId);
  const vms = node && ep?.snapshot ? ep.snapshot.vms.filter((v) => v.node === node.node) : [];
  const runningCount = vms.filter((v) => v.status === 'running').length;
  const usedCores = node && node.cpus ? (node.cpuPct / 100) * node.cpus : null;
  const cpuRatio = node && node.cpus ? node.cpuAllocCores / node.cpus : null;
  const ramRatio =
    node && node.memTotalBytes
      ? (node.ramAllocBytes + (config.hostRamProvisionPct / 100) * node.memTotalBytes) / node.memTotalBytes
      : null;

  // ── Options des graphiques PVE (cpu/ram/rootfs/net) — mêmes helpers que le Monitor nœud ──
  const ct = chartTheme(theme);
  const hasData = !!data && data.points.length > 0;
  const times = useMemo(() => (hasData && data ? data.points.map((p) => p.time) : []), [hasData, data]);
  const bands = { warnPct: config.usage.warnPct, critPct: config.usage.critPct };

  const cpuOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return pctOption(ct, tf, times, [{ name: t('metrics.cpu'), data: data.points.map((p) => p.cpuPct), color: ct.cpu }], bands);
  }, [hasData, data, times, tf, ct, t, config]);
  const ramOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return pctOption(ct, tf, times, [{ name: t('metrics.ram'), data: data.points.map((p) => p.ramPct), color: ct.ram }], bands);
  }, [hasData, data, times, tf, ct, t, config]);
  const diskOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return pctOption(ct, tf, times, [{ name: t('node.kpi.rootfs'), data: data.points.map((p) => p.storagePct), color: ct.disk }]);
  }, [hasData, data, times, tf, ct, t]);
  const netOption = useMemo<EChartsOption | null>(() => {
    if (!hasData || !data) return null;
    return rateOption(ct, tf, times, [
      { name: t('network.rx'), data: data.points.map((p) => p.netInBps), color: ct.netIn },
      { name: t('network.tx'), data: data.points.map((p) => p.netOutBps), color: ct.netOut },
    ]);
  }, [hasData, data, times, tf, ct, t]);

  const ifaces = netData?.interfaces ?? [];
  const hasAnyPoints = (netData?.rows.length ?? 0) > 0;
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

  // ── Catalogue unifié : KPIs + table VMs + graphiques (ordre = layout par défaut) ──
  const catalog = useMemo<CoreWidgetDef[]>(() => {
    if (!node) return [];
    const defs: CoreWidgetDef[] = [];
    const subtitle = node.node;
    // KPIs d'état courant (pas de sous-titre).
    defs.push(
      {
        id: 'kpi-cpu',
        title: t('node.kpi.cpuLive'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <StatBody
            value={node.online ? `${node.cpuPct.toFixed(0)} %` : '—'}
            sub={node.online && usedCores !== null && node.cpus ? t('node.kpi.cores', { used: usedCores.toFixed(1), total: node.cpus }) : '—'}
            pct={node.online ? node.cpuPct : undefined}
          />
        ),
      },
      {
        id: 'kpi-ram',
        title: t('node.kpi.ramLive'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <StatBody
            value={node.online ? `${node.ramPct.toFixed(0)} %` : '—'}
            sub={node.online && node.memTotalBytes ? `${formatBytes(node.memUsedBytes)} / ${formatBytes(node.memTotalBytes)}` : '—'}
            pct={node.online ? node.ramPct : undefined}
          />
        ),
      },
      {
        id: 'kpi-rootfs',
        title: t('node.kpi.diskLive'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <StatBody value={node.online ? `${node.diskPct.toFixed(0)} %` : '—'} sub={t('node.kpi.rootfs')} pct={node.online ? node.diskPct : undefined} />
        ),
      },
      {
        id: 'kpi-load',
        title: t('node.kpi.loadLive'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <StatBody
            value={node.online && node.loadavg ? node.loadavg[0].toFixed(2) : '—'}
            sub={node.online && node.loadavg ? `${node.loadavg.map((v) => v.toFixed(2)).join(' / ')} ${t('node.kpi.loadSub')}` : '—'}
          />
        ),
      },
      {
        id: 'host-details',
        title: t('node.hostDetails.title'),
        default: { w: 6, h: 4 },
        minW: 4,
        minH: 3,
        render: () => (
          <HostDetailsBody
            version={node.version}
            ip={node.ip}
            online={node.online}
            uptimeSec={node.uptimeSec}
            cpus={node.cpus}
            nicCount={ifaces.length}
            vmCount={vms.length}
            cpuModel={hwRow?.cpuModel ?? null}
            product={hwRow?.product ?? null}
            vendor={hwRow?.vendor ?? null}
            board={hwRow?.board ?? null}
          />
        ),
      },
      {
        id: 'capacity',
        title: t('node.capacity.title'),
        default: { w: 6, h: 4 },
        minW: 4,
        minH: 3,
        render: () => (
          <CapacityBody
            cpuPct={node.cpuPct}
            cpus={node.cpus}
            memUsedBytes={node.memUsedBytes}
            memTotalBytes={node.memTotalBytes}
            rootfsUsedBytes={node.rootfsUsedBytes}
            rootfsTotalBytes={node.rootfsTotalBytes}
          />
        ),
      },
      {
        id: 'vms',
        title: t('node.vms.title'),
        default: { w: 12, h: 4 },
        minW: 6,
        minH: 3,
        extra: () =>
          vms.length > 0 ? (
            <span className="text-xs text-muted-foreground">{t('node.vms.running', { n: runningCount, total: vms.length })}</span>
          ) : null,
        render: () => <VmTableBody vms={vms} />,
      },
    );
    // Graphiques (sous-titre = nom du nœud) — mêmes corps/exports que le Monitor nœud vm-view_v4.
    defs.push(
      { id: 'system', title: t('vm.node.system'), subtitle, default: { w: 12, h: 2 }, minH: 2, render: () => <NodeSystemBody row={sysRow} loading={sysLoading} /> },
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
            <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node.node, tf, 'cpu', ALL_COLS.slice(0, 1))} />
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
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node.node, tf, 'ram', ALL_COLS.slice(1, 2))} />,
        render: () => <StaticChartBody option={ramOption} loading={loading} hasData={hasData} />,
      },
      {
        id: 'rootfs',
        title: t('node.kpi.rootfs'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node.node, tf, 'disk', ALL_COLS.slice(2, 3))} />,
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
            onClick={() => exportNodeDiskioCsv(diskioData, node.node, tf)}
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
        extra: () => <ExportCsvButton disabled={!hasData} onClick={() => exportNodeCsv(data, node.node, tf, 'net', ALL_COLS.slice(3))} />,
        render: () => <StaticChartBody option={netOption} loading={loading} hasData={hasData} />,
      },
      {
        id: 'temp-cpu',
        title: t('vm.node.temps'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton disabled={!tempsData || tempsData.series.length === 0} onClick={() => exportNodeTempsCsv(tempsData, node.node, tf)} />
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
          <ExportCsvButton
            disabled={!smartTempsData || smartTempsData.series.length === 0}
            onClick={() => exportSmartTempsCsv(smartTempsData, node.node, tf)}
          />
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
            disabled={smartDevices.filter((d) => d.node === node.node).length === 0}
            onClick={() => exportSmartHealthCsv(smartDevices.filter((d) => d.node === node.node), node.node)}
          />
        ),
        render: () => <SmartHealthBody devices={smartDevices} loading={sensorsLoading} node={node.node} />,
      },
      {
        id: 'zfs-arc',
        title: t('vm.node.zfsArc'),
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => (
          <ExportCsvButton disabled={!zfsArcData || zfsArcData.points.length === 0} onClick={() => exportZfsArcCsv(zfsArcData, node.node, tf)} />
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
            onClick={() => exportHostHistoryCsv(hostHistData, node.node, tf, 'load')}
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
            onClick={() => exportHostHistoryCsv(hostHistData, node.node, tf, 'swap')}
          />
        ),
        render: () => <SwapBody data={hostHistData} loading={hostHistLoading} timeframe={tf} />,
      },
    );
    // Réseau PAR INTERFACE hôte — UN WIDGET PAR INTERFACE (dynamiques, en fin de catalogue).
    for (const iface of ifaces) {
      const rows = (netData?.rows ?? []).filter((r) => iface.kernels.includes(r.iface));
      defs.push({
        id: `netif-${widgetIdFrom(iface.name)}`,
        title: iface.name,
        subtitle,
        default: { w: 12, h: 4 },
        minH: 3,
        extra: () => <ExportCsvButton disabled={rows.length === 0} onClick={() => exportNodeNetIfaceCsv(iface, rows, node.node, tf)} />,
        render: () => <NodeNetIfaceBody iface={iface} rows={rows} hasAnyPoints={hasAnyPoints} loading={netLoading} timeframe={tf} />,
      });
    }
    return defs;
  }, [
    node,
    vms,
    runningCount,
    usedCores,
    sysRow,
    sysLoading,
    hwRow,
    data,
    hasData,
    diskioData,
    diskioLoading,
    netData,
    netLoading,
    ifaces,
    hasAnyPoints,
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

  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);

  // La grille ne se monte qu'après le PREMIER chargement node-net (ids dynamiques netif-*).
  const ready = netDone;
  const defaultLayout = useMemo(() => (ready ? nodeDefaultLayout(catalog) : []), [catalogKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const merged = useMemo(() => (ready ? mergePageConfig(stored, catalog, defaultLayout) : null), [stored, catalogKey, ready, defaultLayout]); // eslint-disable-line react-hooks/exhaustive-deps

  const onLayoutChange = (layout: WidgetItem[]) => {
    if (!merged) return;
    if (layoutsEqual(layout, merged.layout)) return;
    updatePage('nodePage', scope, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => {
    if (!merged) return;
    updatePage('nodePage', scope, removeWidget(merged, widgetId));
  };
  const onAdd = (widgetId: string) => {
    if (!merged) return;
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('nodePage', scope, addWidget(merged, def));
  };
  const onReset = () => clearPage('nodePage', scope);

  // ── Early returns (APRÈS tous les hooks) ──
  if (!multiLoaded) {
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        {t('topbar.reconnecting')}
      </div>
    );
  }

  if (!ep) return <Navigate to="/" replace />;

  if (!ep.snapshot) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
        <AlertTriangle className="h-6 w-6 text-crit" />
        <div className="text-sm font-medium text-foreground">{t('endpoint.noData')}</div>
        {ep.error && <div className="max-w-md text-center text-xs">{ep.error}</div>}
      </div>
    );
  }

  if (!node) return <Navigate to={`/e/${encodeURIComponent(ep.id)}`} replace />;

  return (
    <div className="space-y-4">
      {/* En-tête : retour + titre + badges (inchangé vs v3). */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to={`/e/${encodeURIComponent(ep.id)}`}
          className="flex h-8 w-8 items-center justify-center rounded-lg border bg-card text-muted-foreground transition-colors hover:text-foreground"
          title={ep.name}
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold tracking-tight">{node.node}</h1>
        {node.online ? (
          <Badge tone={node.severity === 'ok' ? 'ok' : node.severity === 'warn' ? 'warn' : 'crit'}>● {t('nodes.online')}</Badge>
        ) : (
          <Badge tone="crit">{t('nodes.offline')}</Badge>
        )}
        {cpuRatio !== null && (
          <Badge tone={overcommitTone(cpuRatio, config.cpu)} title={t('overcommit.hint')}>
            {t('metrics.cpu')} ×{cpuRatio.toFixed(1)}
          </Badge>
        )}
        {ramRatio !== null && (
          <Badge tone={overcommitTone(ramRatio, config.ram)} title={t('overcommit.hint')}>
            {t('metrics.ram')} ×{ramRatio.toFixed(1)}
          </Badge>
        )}
        <div className="text-xs text-muted-foreground">
          {node.ip && <span>{node.ip}</span>}
          {node.ip && node.version && <span> · </span>}
          {node.version && <span>PVE {node.version}</span>}
          {(node.ip || node.version) && node.uptimeSec !== null && <span> · </span>}
          {node.uptimeSec !== null && <span>{t('common.uptime')} {formatUptime(node.uptimeSec)}</span>}
        </div>
      </div>

      {!ep.ok && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('endpoint.stale', { error: ep.error ?? '' })}
        </div>
      )}

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
          onClick={() => exportNodeCsv(data, node.node, tf, 'all', ALL_COLS)}
          disabled={!hasData}
          title={t('vm.mon.export')}
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          {t('vm.mon.export')}
        </button>
      </div>

      {!ready ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[120px] w-full" />
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[280px] w-full" />
        </div>
      ) : (
        <>
          {!loading && (!data || !hasData) && (
            <div className="rounded-lg border px-3 py-6 text-center text-xs text-muted-foreground">{t('vm.node.insufficient')}</div>
          )}
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
                  ctx={{ endpointId: ep.id, nodeName: node.node }}
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
