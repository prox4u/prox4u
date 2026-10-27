import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ResponsiveGridLayout, useContainerWidth, type Breakpoints, type Layout } from 'react-grid-layout';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Navigate, useParams } from 'react-router-dom';
import { useDashboard } from '../../../core/data/dashboard';
import { useEndpoint } from '../../../core/data/use-endpoint';
import { DEFAULT_LAYOUT, useLayout } from '../../../store/layout';
import { HealthGauge } from '../components/health-gauge';
import { KpiNodesCard, KpiCpuRamCard, KpiStorageCard, KpiVmsCard } from '../components/kpi-row';
import { PraPanel } from '../components/pra-panel';
import { CapacityChart } from '../components/capacity-chart';
import { TopConsumers } from '../components/top-consumers';
import { NodesTable } from '../components/nodes-table';
import { AlertsList } from '../components/alerts-list';
import { MetricsPanel } from '../components/metrics-panel';
import { ResourceChart } from '../components/resource-chart';
import { StorageCard } from '../components/storage-card';
import { NetworkCard } from '../components/network-card';
import { OvercommitCard } from '../components/overcommit-card';

const BREAKPOINTS: Breakpoints = { lg: 1200, md: 800, sm: 400 };
const BREAKPOINT_COLS: Breakpoints = { lg: 12, md: 8, sm: 4 };

export function EndpointPage() {
  const { t } = useTranslation();
  const { endpointId } = useParams<{ endpointId: string }>();
  const ep = useEndpoint(endpointId);
  const multiLoaded = useDashboard((s) => s.multi !== null);
  const capacity = useDashboard((s) => (endpointId ? s.capacity[endpointId] : undefined));
  const spark = useDashboard((s) => (endpointId ? s.spark[endpointId] : []));
  const loadHeavy = useDashboard((s) => s.loadHeavy);
  const loadRisk = useDashboard((s) => s.loadRisk);
  const layout = useLayout((s) => s.layout);
  const setLayouts = useLayout((s) => s.setLayouts);
  const gridVersion = useLayout((s) => s.version);
  const { width, containerRef } = useContainerWidth({ initialWidth: 1280 });

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

  if (!multiLoaded) {
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        {t('topbar.reconnecting')}
      </div>
    );
  }

  if (!ep) return <Navigate to="/" replace />;

  const snapshot = ep.snapshot;
  if (!snapshot) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
        <AlertTriangle className="h-6 w-6 text-crit" />
        <div className="text-sm font-medium text-foreground">{t('endpoint.noData')}</div>
        {ep.error && <div className="max-w-md text-center text-xs">{ep.error}</div>}
      </div>
    );
  }

  const kpiProps = { kpis: snapshot.kpis, spark };

  return (
    <div className="space-y-4">
      {!ep.ok && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('endpoint.stale', { error: ep.error ?? '' })}
        </div>
      )}
      <ResponsiveGridLayout
        key={gridVersion}
        className="layout"
        innerRef={containerRef as React.RefObject<HTMLDivElement>}
        width={width}
        breakpoints={BREAKPOINTS}
        cols={BREAKPOINT_COLS}
        layouts={{ lg: layout.lg ?? DEFAULT_LAYOUT }}
        rowHeight={90}
        margin={[16, 16]}
        dragConfig={{ handle: '.drag-handle', cancel: 'button, a, input, select, textarea' }}
        resizeConfig={{ handles: ['se'] }}
        onLayoutChange={(_current, all) => setLayouts(all as Record<string, Layout>)}
      >
        {/* graphes ressources en tête (7 jours, usage réel vs allocation) */}
        <div key="res-cpu" className="h-full">
          <ResourceChart metric="cpu" endpointId={ep.id} kpis={snapshot.kpis} />
        </div>
        <div key="res-ram" className="h-full">
          <ResourceChart metric="ram" endpointId={ep.id} kpis={snapshot.kpis} />
        </div>
        <div key="res-storage" className="h-full">
          <ResourceChart metric="storage" endpointId={ep.id} kpis={snapshot.kpis} />
        </div>

        <div key="kpi-nodes" className="h-full">
          <KpiNodesCard {...kpiProps} />
        </div>
        <div key="kpi-cpu" className="h-full">
          <KpiCpuRamCard {...kpiProps} />
        </div>
        <div key="kpi-storage" className="h-full">
          <KpiStorageCard {...kpiProps} />
        </div>
        <div key="kpi-vms" className="h-full">
          <KpiVmsCard {...kpiProps} />
        </div>

        <div key="metrics" className="h-full">
          <MetricsPanel endpointId={ep.id} />
        </div>
        <div key="health" className="h-full">
          <HealthGauge health={snapshot.health} />
        </div>

        <div key="pra" className="h-full">
          <PraPanel pra={snapshot.pra} />
        </div>
        <div key="capacity" className="h-full">
          <CapacityChart capacity={capacity ?? null} />
        </div>

        <div key="storage" className="h-full">
          <StorageCard storages={snapshot.storages} />
        </div>
        <div key="network" className="h-full">
          <NetworkCard network={snapshot.network} spark={spark ?? []} />
        </div>
        <div key="alerts" className="h-full">
          <AlertsList alerts={snapshot.alerts} />
        </div>

        <div key="top" className="h-full">
          <TopConsumers topVms={snapshot.topVms} topPools={snapshot.topPools} />
        </div>
        <div key="nodes" className="h-full">
          <NodesTable nodes={snapshot.nodes} sites={snapshot.sites} />
        </div>

        <div key="overcommit" className="h-full">
          <OvercommitCard kpis={snapshot.kpis} endpointId={ep.id} />
        </div>
      </ResponsiveGridLayout>
    </div>
  );
}
