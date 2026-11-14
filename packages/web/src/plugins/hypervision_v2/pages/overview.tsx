import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, OctagonAlert } from 'lucide-react';
import type {
  EndpointSnapshot,
  KpiSummary,
  NodeSystemRow,
  OvercommitConfig,
  OvercommitMetric,
  OvercommitRiskResponse,
  SeverityOrNa,
  WidgetItem,
} from '@prox4u/shared';
import { addWidget, computeOvercommit, mergePageConfig, removeWidget, usageSeverity } from '@prox4u/shared';
import { useMulti, useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useDashboard } from '../../../core/data/dashboard';
import { fetchNodeSystem } from '../../../core/api/apiClient';
import { ResourceChartBody, resourceCurrent } from '../components/resource-chart';
import { SystemNodesBody } from '../components/system-nodes-card';
import { Badge } from '../../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '../../../components/ui/table';
import { KpiCpuRamBody, KpiNodesBody, KpiStorageBody, KpiVmsBody } from '../components/kpi-row';
import { useUserConfig } from '../../../store/user-config';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { layoutsEqual, type CoreWidgetDef } from '../../../core/widgets/types';

/**
 * Vue d'ensemble v2 — grilles personnalisables par utilisateur :
 * drag/resize des cartes, retrait → bibliothèque, réinsertion, reset ;
 * persistance par user (GET/PUT/DELETE /api/user-config, page « overview »).
 *
 * Catalogue de widgets :
 *  - res-cpu / res-ram / res-storage : graphes ressources 7 j (agrégat) ;
 *  - kpi-nodes / kpi-cpu / kpi-storage / kpi-vms : cartes KPI ;
 *  - sys-nodes : tableau Système cross-node (agent hôte Telegraf) ;
 *  - ep-<endpointId> : cartes endpoints (dynamiques — un nouveau endpoint est
 *    ajouté au layout par le merge, un endpoint retiré va en bibliothèque) ;
 *  - alerts / table : alertes + inventaire endpoints.
 *
 * Les positions persistées priment ; le layout par défaut est le « design
 * validé » v1 (overviewDefaultLayout).
 */

/**
 * Layout par défaut de la vue d'ensemble : graphes ressources en tête, rangée de KPIs,
 * rangée système (Système par nœud — tableau cross-node agent hôte, pleine largeur, h=5),
 * cartes endpoints (3/rangée), puis alertes + table. I/O disques par device et CPU par
 * cœur vivent dans le Monitor du nœud (Vue VM) — drill-down d'un nœud.
 */
function overviewDefaultLayout(eps: EndpointSnapshot[]): WidgetItem[] {
  const SYS_ROW_Y = 5;
  const SYS_ROW_H = 5;
  const epY = SYS_ROW_Y + SYS_ROW_H;
  const epItems = eps.map((ep, i) => ({
    widgetId: `ep-${ep.id}`,
    x: (i % 3) * 4,
    y: epY + Math.floor(i / 3) * 3,
    w: 4,
    h: 3,
  }));
  const bottomY = epY + Math.ceil(eps.length / 3) * 3;
  return [
    { widgetId: 'res-cpu', x: 0, y: 0, w: 4, h: 3 },
    { widgetId: 'res-ram', x: 4, y: 0, w: 4, h: 3 },
    { widgetId: 'res-storage', x: 8, y: 0, w: 4, h: 3 },
    { widgetId: 'kpi-nodes', x: 0, y: 3, w: 3, h: 2 },
    { widgetId: 'kpi-cpu', x: 3, y: 3, w: 3, h: 2 },
    { widgetId: 'kpi-storage', x: 6, y: 3, w: 3, h: 2 },
    { widgetId: 'kpi-vms', x: 9, y: 3, w: 3, h: 2 },
    { widgetId: 'sys-nodes', x: 0, y: SYS_ROW_Y, w: 12, h: SYS_ROW_H },
    ...epItems,
    { widgetId: 'alerts', x: 0, y: bottomY, w: 5, h: 3 },
    { widgetId: 'table', x: 5, y: bottomY, w: 7, h: 3 },
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

/**
 * CORPS de la carte endpoint (score / erreur) — l'en-tête (nom + badge santé)
 * est porté par la frame du widget ; le badge de santé est rendu dans le slot
 * « extra » de l'en-tête (voir le catalogue).
 */
function EndpointHealthBody({ ep }: { ep: EndpointSnapshot }) {
  const { t } = useTranslation();
  const snap = ep.snapshot;
  return (
    <div className="flex h-full items-end justify-between gap-3">
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
    </div>
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

/** CORPS du tableau endpoints (l'en-tête est porté par la frame du widget). */
function EndpointsTableBody({ eps }: { eps: EndpointSnapshot[] }) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const risk = useDashboard((s) => s.risk);
  return (
    <div className="h-full overflow-x-auto">
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
    </div>
  );
}

/** CORPS de la carte alertes (l'en-tête est porté par la frame du widget). */
function OverviewAlertsBody({ eps }: { eps: EndpointSnapshot[] }) {
  const { t } = useTranslation();
  const all = useMemo(
    () =>
      eps.flatMap((ep) => (ep.snapshot?.alerts ?? []).map((a) => ({ ep, a }))).sort((x, y) => {
        const rank = (s: string) => (s === 'crit' ? 0 : 1);
        return rank(x.a.severity) - rank(y.a.severity);
      }),
    [eps],
  );

  if (all.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-ok/10 p-3 text-sm text-ok">
        <CheckCircle2 className="h-4 w-4" /> {t('alerts.none')}
      </div>
    );
  }
  return (
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
  );
}

/**
 * Dernier point système par nœud (Telegraf) — alimente la carte « Système » cross-node
 * (tick 60 s, cache serveur 60 s). La même route sert aussi le Monitor du nœud (Vue VM
 * : sections Système / CPU par cœur) avec un fetch indépendant de chaque vue.
 */
function useNodeSystem(): { rows: NodeSystemRow[]; loading: boolean } {
  const [rows, setRows] = useState<NodeSystemRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchNodeSystem()
        .then((r) => {
          if (!cancelled) setRows(r.nodes);
        })
        .catch((err) => console.warn('chargement node-system en échec', err))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return { rows, loading };
}

export function OverviewPage() {
  const { t } = useTranslation();
  const multi = useMulti();
  const { rows: sysRows, loading: sysLoading } = useNodeSystem();
  const config = useOvercommitConfig();

  // Personnalisation par utilisateur : config stockée (null = jamais personnalisé)
  // + actions sur la page « overview » (un seul layout, pas de scope).
  const stored = useUserConfig((s) => s.config?.pages.overview ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const eps = multi?.endpoints ?? [];
  // Clés stables pour les memo (pas l'identité des tableaux — les pushes WS
  // reconstruisent les arrays à chaque seconde).
  const epIdsKey = eps.map((e) => e.id).join(',');

  // KPIs agrégés : recalculés à chaque push WS (référence eps) — le set d'ids
  // seul (epIdsKey) laisserait des valeurs figées tant que les endpoints ne changent pas.
  const kpis = useMemo(() => aggregateKpis(eps), [eps]);

  // Catalogue de widgets (statiques + ep-<id> dynamiques) — les closures de
  // rendu capturent les données courantes ; l'IDENTITÉ du catalogue change à
  // chaque push, d'où la clé (ids) pour les memo de merge / de grille.
  const catalog = useMemo<CoreWidgetDef[]>(() => {
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
        render: () => <ResourceChartBody metric={metric} kpis={kpis} />,
      });
    }
    defs.push(
      { id: 'kpi-nodes', title: t('kpi.nodes'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiNodesBody kpis={kpis} /> },
      { id: 'kpi-cpu', title: t('kpi.cpuRam'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiCpuRamBody kpis={kpis} spark={[]} /> },
      { id: 'kpi-storage', title: t('kpi.storage'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiStorageBody kpis={kpis} spark={[]} /> },
      { id: 'kpi-vms', title: t('kpi.vms'), default: { w: 3, h: 2 }, minW: 2, minH: 2, render: () => <KpiVmsBody kpis={kpis} spark={[]} /> },
      {
        id: 'sys-nodes',
        title: t('overview.system'),
        default: { w: 12, h: 5 },
        minW: 6,
        minH: 3,
        render: () => <SystemNodesBody rows={sysRows} loading={sysLoading} />,
      },
    );
    for (const ep of eps) {
      defs.push({
        id: `ep-${ep.id}`,
        title: ep.name,
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        extra: () =>
          ep.ok && ep.snapshot ? (
            <Badge tone={healthTone(ep.snapshot.health.label)}>{t(`health.${ep.snapshot.health.label}`)}</Badge>
          ) : (
            <Badge tone="crit">{t('common.error')}</Badge>
          ),
        render: () => <EndpointHealthBody ep={ep} />,
      });
    }
    defs.push(
      { id: 'alerts', title: t('overview.alerts'), default: { w: 5, h: 3 }, minW: 4, minH: 2, render: () => <OverviewAlertsBody eps={eps} /> },
      { id: 'table', title: t('overview.endpoints'), default: { w: 7, h: 3 }, minW: 6, minH: 2, render: () => <EndpointsTableBody eps={eps} /> },
    );
    return defs;
  }, [eps, kpis, sysRows, sysLoading, t, config]);

  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);
  const defaultLayout = useMemo(() => overviewDefaultLayout(epIdsKey ? eps : []), [epIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // FUSION « utilisateurs présents et futurs » : positions stockées priment ;
  // endpoint retiré → bibliothèque ; endpoint ajouté → layout (taille par défaut).
  const merged = useMemo(
    () => mergePageConfig(stored, catalog, defaultLayout),
    [stored, catalogKey, defaultLayout],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  );

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

  const onLayoutChange = (layout: WidgetItem[]) => {
    // Garde : RGL rappelle onLayoutChange sur les compactations parent-driven
    // (retrait d'un widget, changement de breakpoint) — on n'enregistre que les
    // vrais changements (drag/resize utilisateur).
    if (layoutsEqual(layout, merged.layout)) return;
    updatePage('overview', undefined, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => updatePage('overview', undefined, removeWidget(merged, widgetId));
  const onAdd = (widgetId: string) => {
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('overview', undefined, addWidget(merged, def));
  };
  const onReset = () => clearPage('overview', undefined);

  if (!multi) {
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        {t('topbar.reconnecting')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Titre de page à gauche, barre d'outils de personnalisation à droite. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t('nav.overview')}</h1>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('overview.hint')}</p>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground/80">{t('widgets.customize.hint')}</p>
        </div>
        <WidgetToolbar
          libraryOpen={libraryOpen}
          onToggleLibrary={() => setLibraryOpen((o) => !o)}
          onReset={onReset}
          libraryCount={merged.library.length}
        />
      </div>

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <WidgetGridLayout
            catalog={catalog}
            config={merged}
            ctx={{ endpointId: 'all' }}
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
