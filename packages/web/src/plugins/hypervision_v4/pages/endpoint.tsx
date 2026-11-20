import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { WidgetItem } from '@prox4u/shared';
import { addWidget, mergePageConfig, removeWidget, usageSeverity } from '@prox4u/shared';
import { useDashboard } from '../../../core/data/dashboard';
import { useEndpoint, useOvercommitConfig } from '../../../core/data/use-endpoint';
import { Badge } from '../../../components/ui/badge';
import { useUserConfig } from '../../../store/user-config';
import { DEFAULT_LAYOUT } from '../../../store/layout';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { layoutsEqual, type CoreWidgetDef } from '../../../core/widgets/types';
import { ResourceChartBody, resourceCurrent } from '../components/resource-chart';
import { KpiNodesBody, KpiCpuRamBody, KpiStorageBody, KpiVmsBody } from '../components/kpi-row';
import { MetricsPanelBody } from '../components/metrics-panel';
import { HealthGaugeBody } from '../components/health-gauge';
import { PraPanelBody } from '../components/pra-panel';
import { CapacityChartBody } from '../components/capacity-chart';
import { StorageCardBody } from '../components/storage-card';
import { NetworkCardBody } from '../components/network-card';
import { AlertsListBody } from '../components/alerts-list';
import { TopConsumersBody } from '../components/top-consumers';
import { NodesTableBody } from '../components/nodes-table';
import { OvercommitCardBody } from '../components/overcommit-card';

/** Teintes des badges de sévérité (PRA) — mêmes valeurs que pra-panel. */
const SEV_TONE = { ok: 'ok', warn: 'warn', crit: 'crit', na: 'default' } as const;

/**
 * Layout par défaut de la page cluster = design validé v1 (store/layout
 * DEFAULT_LAYOUT — les 17 blocs, `i` → `widgetId`). Les positions persistées
 * priment ; un widget ajouté au catalogue s'ajoute en bas par le merge.
 */
const ENDPOINT_DEFAULT_LAYOUT: WidgetItem[] = DEFAULT_LAYOUT.map((it) => ({
  widgetId: it.i,
  x: it.x,
  y: it.y,
  w: it.w,
  h: it.h,
}));

/**
 * Page CLUSTER v4 — dashboard personnalisable par utilisateur :
 * les 17 blocs du dashboard (graphes ressources, KPIs, métriques, health, PRA,
 * capacité, stockage, réseau, alertes, top consommateurs, nœuds, surallocation)
 * sont des widgets déplaçables/retraitables. Persistance par compte, scope
 * « endpointView » (un layout par cluster).
 *
 * Données inchangées : snapshot WS (5 s) + loadHeavy/loadRisk (5 min).
 *
 * Règle des hooks : TOUS les hooks sont appelés AVANT les early returns — le
 * snapshot est lu avec guard optionnel (`ep?.snapshot`) pour rester inconditionnel.
 */
export function EndpointPage() {
  const { t } = useTranslation();
  const { endpointId } = useParams<{ endpointId: string }>();
  const ep = useEndpoint(endpointId);
  const config = useOvercommitConfig();
  const multiLoaded = useDashboard((s) => s.multi !== null);
  const capacity = useDashboard((s) => (endpointId ? s.capacity[endpointId] : undefined));
  const spark = useDashboard((s) => (endpointId ? s.spark[endpointId] : []));
  const risk = useDashboard((s) => (endpointId ? s.risk[endpointId] : undefined));
  const loadHeavy = useDashboard((s) => s.loadHeavy);
  const loadRisk = useDashboard((s) => s.loadRisk);

  // Personnalisation par utilisateur : scope « endpointId » (un layout par cluster).
  const scope = endpointId ?? '';
  const stored = useUserConfig((s) => s.config?.pages.endpointView?.[scope] ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

  // données lourdes (capacity, trends, risque dynamique) : au montage puis toutes les 5 min
  useEffect(() => {
    if (!endpointId) return;
    void loadHeavy(endpointId);
    void loadRisk(endpointId);
    const id = setInterval(() => {
      void loadHeavy(endpointId);
      void loadRisk(endpointId);
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [endpointId, loadHeavy, loadRisk]);

  // Snapshot (guard optionnel — AVANT les early returns, Rules of Hooks).
  const snapshot = ep?.snapshot;

  // Catalogue de 17 widgets — les closures de rendu capturent les données courantes.
  const catalog = useMemo<CoreWidgetDef[]>(() => {
    if (!snapshot || !ep) return [];
    const kpis = snapshot.kpis;
    const defs: CoreWidgetDef[] = [];
    const metricLabel = (m: 'cpu' | 'ram' | 'storage') => t(`metrics.${m === 'storage' ? 'disk' : m}`);
    for (const metric of ['cpu', 'ram', 'storage'] as const) {
      defs.push({
        id: `res-${metric}`,
        title: `${metricLabel(metric)} — ${t('res.window')}`,
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        extra: () => {
          const current = resourceCurrent(metric, kpis);
          const sev = usageSeverity(current, config);
          return (
            <span className={`text-sm font-semibold tabular-nums ${sev === 'crit' ? 'text-crit' : sev === 'warn' ? 'text-warn' : 'text-ok'}`}>
              {current.toFixed(0)} %
            </span>
          );
        },
        render: () => <ResourceChartBody metric={metric} endpointId={ep.id} kpis={kpis} />,
      });
    }
    defs.push(
      { id: 'kpi-nodes', title: t('kpi.nodes'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiNodesBody kpis={kpis} /> },
      { id: 'kpi-cpu', title: t('kpi.cpuRam'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiCpuRamBody kpis={kpis} spark={spark} /> },
      { id: 'kpi-storage', title: t('kpi.storage'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiStorageBody kpis={kpis} spark={spark} /> },
      { id: 'kpi-vms', title: t('kpi.vms'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiVmsBody kpis={kpis} spark={spark} /> },
      { id: 'metrics', title: t('metrics.title'), default: { w: 8, h: 3 }, minW: 4, minH: 2, render: () => <MetricsPanelBody endpointId={ep.id} /> },
      { id: 'metrics-cpu', title: t('metrics.titleCpu'), default: { w: 4, h: 3 }, minW: 3, minH: 2, render: () => <MetricsPanelBody endpointId={ep.id} metric="cpu" /> },
      { id: 'metrics-ram', title: t('metrics.titleRam'), default: { w: 4, h: 3 }, minW: 3, minH: 2, render: () => <MetricsPanelBody endpointId={ep.id} metric="ram" /> },
      { id: 'metrics-net', title: t('metrics.titleNet'), default: { w: 4, h: 3 }, minW: 3, minH: 2, render: () => <MetricsPanelBody endpointId={ep.id} metric="net" /> },
      {
        id: 'health',
        title: t('health.score'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        extra: () => (
          <Badge tone={snapshot.health.label === 'nominal' ? 'ok' : snapshot.health.label === 'degraded' ? 'warn' : 'crit'}>
            {t(`health.${snapshot.health.label}`)}
          </Badge>
        ),
        render: () => <HealthGaugeBody health={snapshot.health} />,
      },
      {
        id: 'pra',
        title: t('pra.title'),
        default: { w: 6, h: 3 },
        minW: 3,
        minH: 2,
        extra: () =>
          snapshot.pra.globalSeverity !== 'na' ? (
            <Badge tone={SEV_TONE[snapshot.pra.globalSeverity]}>
              {snapshot.pra.globalSeverity === 'ok' ? t('pra.ok') : t('pra.alert')}
            </Badge>
          ) : null,
        render: () => <PraPanelBody pra={snapshot.pra} />,
      },
      { id: 'capacity', title: t('capacity.title'), default: { w: 6, h: 3 }, minW: 3, minH: 2, render: () => <CapacityChartBody capacity={capacity ?? null} /> },
      // Capacity planning par élément (1 série + 1 projection + 1 badge) — pas dans
      // DEFAULT_LAYOUT : nouvel user → bibliothèque ; user existant → bas par le merge.
      { id: 'capacity-cpu', title: t('capacity.titleCpu'), default: { w: 4, h: 3 }, minW: 3, minH: 2, render: () => <CapacityChartBody capacity={capacity ?? null} metric="cpu" /> },
      { id: 'capacity-ram', title: t('capacity.titleRam'), default: { w: 4, h: 3 }, minW: 3, minH: 2, render: () => <CapacityChartBody capacity={capacity ?? null} metric="ram" /> },
      { id: 'capacity-disk', title: t('capacity.titleDisk'), default: { w: 4, h: 3 }, minW: 3, minH: 2, render: () => <CapacityChartBody capacity={capacity ?? null} metric="disk" /> },
      {
        id: 'storage',
        title: t('storageCard.title'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        extra: () => <span className="text-xs text-muted-foreground">{snapshot.storages.length}</span>,
        render: () => <StorageCardBody storages={snapshot.storages} />,
      },
      {
        id: 'network',
        title: t('network.title'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        extra: () => <span className="text-[10px] uppercase tracking-wider text-muted-foreground">5 min</span>,
        render: () => <NetworkCardBody network={snapshot.network} spark={spark} />,
      },
      { id: 'alerts', title: t('alerts.title'), default: { w: 4, h: 3 }, minW: 3, minH: 2, render: () => <AlertsListBody alerts={snapshot.alerts} /> },
      { id: 'top', title: t('top.title'), default: { w: 7, h: 3 }, minW: 4, minH: 2, render: () => <TopConsumersBody topVms={snapshot.topVms} topPools={snapshot.topPools} /> },
      { id: 'nodes', title: t('nodes.title'), default: { w: 5, h: 3 }, minW: 4, minH: 2, render: () => <NodesTableBody nodes={snapshot.nodes} sites={snapshot.sites} /> },
      {
        id: 'overcommit',
        title: t('overcommit.title'),
        default: { w: 12, h: 2 },
        minW: 6,
        minH: 2,
        extra: () =>
          risk?.insufficientData ? <span className="text-[11px] text-muted-foreground">{t('overcommit.insufficientData')}</span> : null,
        render: () => <OvercommitCardBody kpis={kpis} endpointId={ep.id} />,
      },
    );
    return defs;
  }, [snapshot, ep, spark, capacity, risk, t, config]);

  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);
  const defaultLayout = ENDPOINT_DEFAULT_LAYOUT;
  const merged = useMemo(
    () => mergePageConfig(stored, catalog, defaultLayout),
    [stored, catalogKey, defaultLayout],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  );

  const onLayoutChange = (layout: WidgetItem[]) => {
    if (layoutsEqual(layout, merged.layout)) return;
    updatePage('endpointView', scope, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => updatePage('endpointView', scope, removeWidget(merged, widgetId));
  const onAdd = (widgetId: string) => {
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('endpointView', scope, addWidget(merged, def));
  };
  const onReset = () => clearPage('endpointView', scope);

  if (!multiLoaded) {
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        {t('topbar.reconnecting')}
      </div>
    );
  }

  if (!ep) return <Navigate to="/" replace />;

  if (!snapshot) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
        <AlertTriangle className="h-6 w-6 text-crit" />
        <div className="text-sm font-medium text-foreground">{t('endpoint.noData')}</div>
        {ep.error && <div className="max-w-md text-center text-xs">{ep.error}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Titre de page + bouton retour + barre d'outils de personnalisation. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/"
              className="flex h-8 w-8 items-center justify-center rounded-lg border bg-card text-muted-foreground transition-colors hover:text-foreground"
              title={t('nav.overview')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-lg font-semibold tracking-tight">{ep.name}</h1>
            {snapshot?.cluster.quorumState === 'lost' ? (
              <Badge tone="crit">{t('cluster.quorumLost')}</Badge>
            ) : snapshot?.cluster.quorumState === 'ok' ? (
              <Badge tone="ok">{t('cluster.quorumOk', { online: snapshot.cluster.nodesOnline, total: snapshot.cluster.nodesTotal })}</Badge>
            ) : null}
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('endpoint.hint')}</p>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground/80">{t('widgets.customize.hint')}</p>
        </div>
        <WidgetToolbar
          libraryOpen={libraryOpen}
          onToggleLibrary={() => setLibraryOpen((o) => !o)}
          onReset={onReset}
          libraryCount={merged.library.length}
        />
      </div>

      {!ep.ok && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('endpoint.stale', { error: ep.error ?? '' })}
        </div>
      )}

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <WidgetGridLayout
            catalog={catalog}
            config={merged}
            ctx={{ endpointId: ep.id }}
            onLayoutChange={onLayoutChange}
            onRemove={onRemove}
          />
        </div>
        {libraryOpen && (
          <WidgetLibraryPanel
            catalog={catalog}
            config={merged}
            onAdd={onAdd}
            onRemove={onRemove}
            onClose={() => setLibraryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
