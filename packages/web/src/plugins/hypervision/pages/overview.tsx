import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, OctagonAlert } from 'lucide-react';
import { ResponsiveGridLayout, useContainerWidth, type Breakpoints, type Layout } from 'react-grid-layout';
import type {
  EndpointSnapshot,
  KpiSummary,
  OvercommitConfig,
  OvercommitMetric,
  OvercommitRiskResponse,
  SeverityOrNa,
} from '@prox4u/shared';
import { computeOvercommit, usageSeverity } from '@prox4u/shared';
import { useMulti, useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useDashboard } from '../../../core/data/dashboard';
import { ResourceChart } from '../components/resource-chart';
import { useLayout } from '../../../store/layout';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '../../../components/ui/table';
import { KpiCpuRamCard, KpiNodesCard, KpiStorageCard, KpiVmsCard } from '../components/kpi-row';

const BREAKPOINTS: Breakpoints = { lg: 1200, md: 800, sm: 400 };
const BREAKPOINT_COLS: Breakpoints = { lg: 12, md: 8, sm: 4 };

/**
 * Layout par défaut de la vue d'ensemble : graphes ressources en tête, rangée de KPIs,
 * cartes endpoints (3/rangée), puis alertes + table. Les positions persistées
 * (drag/resize utilisateur) priment ; les nouveaux endpoints reprennent leur emplacement
 * calculé ici.
 */
function overviewDefaultLayout(eps: EndpointSnapshot[]): Layout {
  const epItems = eps.map((ep, i) => ({
    i: `ep-${ep.id}`,
    x: (i % 3) * 4,
    y: 5 + Math.floor(i / 3) * 3,
    w: 4,
    h: 3,
  }));
  const bottomY = 5 + Math.ceil(eps.length / 3) * 3;
  return [
    { i: 'res-cpu', x: 0, y: 0, w: 4, h: 3 },
    { i: 'res-ram', x: 4, y: 0, w: 4, h: 3 },
    { i: 'res-storage', x: 8, y: 0, w: 4, h: 3 },
    { i: 'kpi-nodes', x: 0, y: 3, w: 3, h: 2 },
    { i: 'kpi-cpu', x: 3, y: 3, w: 3, h: 2 },
    { i: 'kpi-storage', x: 6, y: 3, w: 3, h: 2 },
    { i: 'kpi-vms', x: 9, y: 3, w: 3, h: 2 },
    ...epItems,
    { i: 'alerts', x: 0, y: bottomY, w: 5, h: 3 },
    { i: 'table', x: 5, y: bottomY, w: 7, h: 3 },
  ];
}

/** Sévérité globale d'un endpoint = la plus sévère (cpu/ram/storage), « na » ignorée. */
function overallRisk(sevs: SeverityOrNa[]): SeverityOrNa {
  const list = sevs.filter((s) => s !== 'na');
  if (list.length === 0) return 'na';
  if (list.includes('crit')) return 'crit';
  if (list.includes('warn')) return 'warn';
  return 'ok';
}

/** Agrège les KPIs de tous les endpoints (pondération par capacité). */
function aggregateKpis(eps: EndpointSnapshot[]): KpiSummary {
  const snaps = eps.filter((e) => e.snapshot).map((e) => e.snapshot!.kpis);
  const sum = (f: (k: KpiSummary) => number) => snaps.reduce((s, k) => s + f(k), 0);
  const cpuTotal = sum((k) => k.cpuTotalCores);
  const ramTotal = sum((k) => k.ramTotalBytes);
  const diskTotal = sum((k) => k.storageTotalBytes);
  const days = snaps.map((k) => k.storageDaysToFull).filter((d): d is number => d !== null);
    return {
    nodes: { online: sum((k) => k.nodes.online), total: sum((k) => k.nodes.total) },
    cpuTotalCores: cpuTotal,
    cpuUsedCores: sum((k) => k.cpuUsedCores),
    cpuPct: cpuTotal ? Math.round((sum((k) => k.cpuUsedCores) / cpuTotal) * 1000) / 10 : 0,
    cpuAllocatedCores: sum((k) => k.cpuAllocatedCores),
    ramUsedBytes: sum((k) => k.ramUsedBytes),
    ramTotalBytes: ramTotal,
    ramPct: ramTotal ? Math.round((sum((k) => k.ramUsedBytes) / ramTotal) * 1000) / 10 : 0,
    ramAllocatedBytes: sum((k) => k.ramAllocatedBytes),
    diskAllocatedBytes: sum((k) => k.diskAllocatedBytes),
    diskThinAllocatedBytes: sum((k) => k.diskThinAllocatedBytes),
    diskThinTotalBytes: sum((k) => k.diskThinTotalBytes),
    storageUsedBytes: sum((k) => k.storageUsedBytes),
    storageTotalBytes: diskTotal,
    storagePct: diskTotal ? Math.round((sum((k) => k.storageUsedBytes) / diskTotal) * 1000) / 10 : 0,
    storageDaysToFull: days.length ? Math.min(...days) : null,
    vmsRunning: sum((k) => k.vmsRunning),
    vmsStopped: sum((k) => k.vmsStopped),
    vmsTotal: sum((k) => k.vmsTotal),
    vmsAgentDown: sum((k) => k.vmsAgentDown ?? 0),
  };
}

function healthTone(label: 'nominal' | 'degraded' | 'critical'): 'ok' | 'warn' | 'crit' {
  return label === 'nominal' ? 'ok' : label === 'degraded' ? 'warn' : 'crit';
}

function EndpointHealthCard({ ep }: { ep: EndpointSnapshot }) {
  const { t } = useTranslation();
  const snap = ep.snapshot;
  return (
    <Card>
      {/* drag par l'en-tête ; le titre reste cliquable (navigation) */}
      <CardHeader draggable className="flex-row items-center justify-between gap-2">
        <CardTitle className="truncate">
          <Link to={`/e/${encodeURIComponent(ep.id)}`} className="hover:text-primary hover:underline">
            {ep.name}
          </Link>
        </CardTitle>
        {ep.ok ? (
          snap && <Badge tone={healthTone(snap.health.label)}>{t(`health.${snap.health.label}`)}</Badge>
        ) : (
          <Badge tone="crit">{t('common.error')}</Badge>
        )}
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-3">
        {ep.ok && snap ? (
          <>
            <div>
              <div className="text-3xl font-bold tabular-nums">{Math.round(snap.health.score)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {snap.cluster.nodesOnline}/{snap.cluster.nodesTotal} {t('topbar.nodes')} · {snap.kpis.vmsRunning}/
                {snap.kpis.vmsTotal} VMs
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </>
        ) : (
          <div className="flex items-start gap-2 text-xs text-crit">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="line-clamp-2">{ep.error ?? t('endpoint.noData')}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function pctCell(pct: number | null, config: OvercommitConfig) {
  if (pct === null) return <span className="text-muted-foreground">—</span>;
  const tone = usageSeverity(pct, config);
  const color = tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'text-ok';
  return <span className={`tabular-nums ${color}`}>{pct.toFixed(0)} %</span>;
}

/** Cellule de ratio de surallocation (×N.N) — teinte selon l'échelle de la ressource. */
function ratioCell(metric: OvercommitMetric) {
  if (metric.ratio === null) return <span className="text-muted-foreground">—</span>;
  const color = metric.tone === 'crit' ? 'text-crit' : metric.tone === 'warn' ? 'text-warn' : 'text-foreground';
  return <span className={`tabular-nums ${color}`}>×{metric.ratio.toFixed(1)}</span>;
}

/** Cellule de risque dynamique (pire cas p95 7 j) — la sévérité la plus forte gagne. */
function riskCell(r: OvercommitRiskResponse | undefined) {
  const { t } = useTranslation();
  if (!r) return <span className="text-muted-foreground">—</span>;
  const sev = overallRisk([r.cpu.severity, r.ram.severity, r.storage.severity]);
  if (sev === 'na') return <span className="text-muted-foreground" title={t('overcommit.insufficientData')}>—</span>;
  return <Badge tone={sev}>{t(`risk.${sev}`)}</Badge>;
}

function EndpointsTable({ eps }: { eps: EndpointSnapshot[] }) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const risk = useDashboard((s) => s.risk);
  return (
    <Card>
      <CardHeader draggable>
        <CardTitle>{t('overview.endpoints')}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0 pt-2">
        <Table>
          <TableHeader>
            <tr>
              <TableHead>{t('overview.col.endpoint')}</TableHead>
              <TableHead>{t('common.state')}</TableHead>
              <TableHead>{t('topbar.nodes')}</TableHead>
              <TableHead>VMs</TableHead>
              <TableHead>CPU</TableHead>
              <TableHead>RAM</TableHead>
              <TableHead>{t('metrics.disk')}</TableHead>
              <TableHead title={t('overcommit.hint')}>{t('overview.col.overcommitCpu')}</TableHead>
              <TableHead title={t('overcommit.hint')}>{t('overview.col.overcommitRam')}</TableHead>
              <TableHead title={t('overcommit.hint')}>{t('overview.col.overcommitDisk')}</TableHead>
              <TableHead title={t('overcommit.riskHint')}>{t('overview.col.risk')}</TableHead>
              <TableHead>{t('health.score')}</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {eps.map((ep) => {
              const k = ep.snapshot?.kpis;
              const report = k ? computeOvercommit(k, config) : null;
              return (
                <tr key={ep.id}>
                  <TableCell>
                    <Link to={`/e/${encodeURIComponent(ep.id)}`} className="font-medium hover:text-primary hover:underline">
                      {ep.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {ep.ok ? (
                      ep.snapshot ? (
                        <Badge tone={healthTone(ep.snapshot.health.label)}>{t(`health.${ep.snapshot.health.label}`)}</Badge>
                      ) : (
                        <Badge>{t('common.noData')}</Badge>
                      )
                    ) : (
                      <Badge tone="crit">{t('common.error')}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {ep.snapshot ? `${ep.snapshot.cluster.nodesOnline}/${ep.snapshot.cluster.nodesTotal}` : '—'}
                  </TableCell>
                  <TableCell className="tabular-nums">{k ? `${k.vmsRunning}/${k.vmsTotal}` : '—'}</TableCell>
                  <TableCell>{pctCell(k?.cpuPct ?? null, config)}</TableCell>
                  <TableCell>{pctCell(k?.ramPct ?? null, config)}</TableCell>
                  <TableCell>{pctCell(k?.storagePct ?? null, config)}</TableCell>
                  <TableCell>{report ? ratioCell(report.cpu) : '—'}</TableCell>
                  <TableCell>{report ? ratioCell(report.ram) : '—'}</TableCell>
                  <TableCell>{report ? ratioCell(report.disk) : '—'}</TableCell>
                  <TableCell>{riskCell(risk[ep.id])}</TableCell>
                  <TableCell className="tabular-nums">{ep.snapshot ? Math.round(ep.snapshot.health.score) : '—'}</TableCell>
                </tr>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OverviewAlerts({ eps }: { eps: EndpointSnapshot[] }) {
  const { t } = useTranslation();
  const all = useMemo(
    () =>
      eps.flatMap((ep) => (ep.snapshot?.alerts ?? []).map((a) => ({ ep, a }))).sort((x, y) => {
        const rank = (s: string) => (s === 'crit' ? 0 : 1);
        return rank(x.a.severity) - rank(y.a.severity);
      }),
    [eps],
  );

  return (
    <Card>
      <CardHeader draggable>
        <CardTitle>{t('overview.alerts')}</CardTitle>
      </CardHeader>
      <CardContent>
        {all.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg bg-ok/10 p-3 text-sm text-ok">
            <CheckCircle2 className="h-4 w-4" /> {t('alerts.none')}
          </div>
        ) : (
          <ul className="space-y-2">
            {all.map(({ ep, a }) => (
              <li
                key={`${ep.id}-${a.id}`}
                className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm ${
                  a.severity === 'crit' ? 'border-crit/30 bg-crit/10 text-crit' : 'border-warn/30 bg-warn/10 text-warn'
                }`}
              >
                {a.severity === 'crit' ? (
                  <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>
                  {t(a.messageKey, a.params)}
                  <span className="ml-1.5 rounded bg-secondary px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {ep.name}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const { t } = useTranslation();
  const multi = useMulti();
  const overviewLayout = useLayout((s) => s.overviewLayout);
  const setOverviewLayouts = useLayout((s) => s.setOverviewLayouts);
  const gridVersion = useLayout((s) => s.version);
  const { width, containerRef } = useContainerWidth({ initialWidth: 1280 });

  const eps = multi?.endpoints ?? [];
  // Layout effectif : positions persistées (drag/resize) + défauts calculés pour les
  // nouveaux endpoints. Clé de memo = ids des endpoints → stable entre deux pushes WS.
  const epIdsKey = eps.map((e) => e.id).join(',');
  const layout = useMemo<Layout>(() => {
    const base = overviewDefaultLayout(epIdsKey ? eps : []);
    const saved = overviewLayout.lg ?? [];
    return base.map((item) => saved.find((s) => s.i === item.i) ?? item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epIdsKey, overviewLayout]);
  const layouts = useMemo(() => ({ lg: layout }), [layout]);

  // risque dynamique par endpoint (colonne de la table) : au montage puis toutes les 5 min
  const loadRisk = useDashboard((s) => s.loadRisk);
  useEffect(() => {
    if (!epIdsKey) return;
    const ids = epIdsKey.split(',');
    for (const id of ids) void loadRisk(id);
    const timer = setInterval(() => {
      for (const id of ids) void loadRisk(id);
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [epIdsKey, loadRisk]);

  if (!multi) {
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        {t('topbar.reconnecting')}
      </div>
    );
  }

  const kpis = aggregateKpis(multi.endpoints);

  return (
    <div className="space-y-4">
      {/* Titre de page à gauche, même style que les autres modules (topo/storage/pxinv…). */}
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{t('nav.overview')}</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('overview.hint')}</p>
      </div>

      <ResponsiveGridLayout
        key={gridVersion}
        className="layout"
        innerRef={containerRef as React.RefObject<HTMLDivElement>}
        width={width}
        breakpoints={BREAKPOINTS}
        cols={BREAKPOINT_COLS}
        layouts={layouts}
        rowHeight={90}
        margin={[16, 16]}
        dragConfig={{ handle: '.drag-handle', cancel: 'button, a, input, select, textarea' }}
        resizeConfig={{ handles: ['se'] }}
        onLayoutChange={(_current, all) => setOverviewLayouts(all as Record<string, Layout>)}
      >
        {/* graphes ressources en tête (agrégat de tous les endpoints) */}
        <div key="res-cpu" className="h-full">
          <ResourceChart metric="cpu" kpis={kpis} />
        </div>
        <div key="res-ram" className="h-full">
          <ResourceChart metric="ram" kpis={kpis} />
        </div>
        <div key="res-storage" className="h-full">
          <ResourceChart metric="storage" kpis={kpis} />
        </div>

        <div key="kpi-nodes" className="h-full">
          <KpiNodesCard kpis={kpis} spark={[]} />
        </div>
        <div key="kpi-cpu" className="h-full">
          <KpiCpuRamCard kpis={kpis} spark={[]} />
        </div>
        <div key="kpi-storage" className="h-full">
          <KpiStorageCard kpis={kpis} spark={[]} />
        </div>
        <div key="kpi-vms" className="h-full">
          <KpiVmsCard kpis={kpis} spark={[]} />
        </div>

        {multi.endpoints.map((ep) => (
          <div key={`ep-${ep.id}`} className="h-full">
            <EndpointHealthCard ep={ep} />
          </div>
        ))}

        <div key="alerts" className="h-full">
          <OverviewAlerts eps={multi.endpoints} />
        </div>
        <div key="table" className="h-full">
          <EndpointsTable eps={multi.endpoints} />
        </div>
      </ResponsiveGridLayout>
    </div>
  );
}
