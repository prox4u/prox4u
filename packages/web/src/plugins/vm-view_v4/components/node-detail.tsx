import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NodeHealth, VmSortDir, VmSortKey, VmSummary, WidgetItem } from '@prox4u/shared';
import { addWidget, mergePageConfig, overcommitTone, removeWidget, usageSeverity } from '@prox4u/shared';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/progress';
import { fetchNodeCapacity } from '../../../core/api/apiClient';
import type { CapacityResponse } from '../../../core/api/types';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import type { CoreWidgetDef } from '../../../core/widgets/types';
import { layoutsEqual } from '../../../core/widgets/types';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { useUserConfig } from '../../../store/user-config';
import { CapacityChartBody } from '../../hypervision_v4/components/capacity-chart';
import { NodeMonitor } from './node-monitor';
import { VmTable, type VmRow } from './vm-table';
import { cn, formatBytes, formatUptime } from '../../../lib/utils';

interface Props {
  endpointId: string;
  /** Nom affiché de l'endpoint (cluster). */
  endpointName: string;
  /** Nœud PVE détaillé (snapshot live WS). */
  node: NodeHealth;
  /** VMs du nœud (snapshot live WS). */
  vms: VmSummary[];
  onClose: () => void;
  /** Onglet VMs : ouverture du détail d'une VM. */
  onOpenVm: (vmid: number) => void;
}

type Tab = 'summary' | 'monitor' | 'vms';

// Cache module de la capacity planning par NŒUD (TTL 5 min) — la capacity est au
// niveau NŒUD (disk = rootfs du nœud) → pas de re-fetch en changeant d'onglet.
// Donnée secondaire : un échec ne casse pas la grille.
const NODE_CAPACITY_TTL_MS = 5 * 60 * 1000;
const nodeCapacityCache = new Map<string, { at: number; value: CapacityResponse }>();

/** Capacity planning du NŒUD (disk = rootfs) — pour la section « Capacité du nœud » du Résumé. */
function useNodeCapacity(endpointId: string, nodeName: string): CapacityResponse | null {
  const [capacity, setCapacity] = useState<CapacityResponse | null>(null);
  useEffect(() => {
    const key = `${endpointId}/${nodeName}`;
    const cached = nodeCapacityCache.get(key);
    if (cached && Date.now() - cached.at < NODE_CAPACITY_TTL_MS) {
      setCapacity(cached.value);
      return;
    }
    let alive = true;
    setCapacity(null); // nœud changé → reset pendant le fetch
    fetchNodeCapacity(endpointId, nodeName)
      .then((c) => {
        nodeCapacityCache.set(key, { at: Date.now(), value: c });
        if (alive) setCapacity(c);
      })
      .catch((e) => console.warn('chargement node-capacity (détail nœud) en échec', e));
    return () => {
      alive = false;
    };
  }, [endpointId, nodeName]);
  return capacity;
}

/**
 * Corps d'une carte KPI dans la grille Résumé — le frame de widget fournit la
 * carte + le titre + le handle de drag + le bouton « retirer ». Ici : grand
 * chiffre + sous-texte + barre de progression (teinte overcommit).
 */
function KpiBody({ value, sub, pct }: { value: string; sub: string; pct?: number }) {
  const config = useOvercommitConfig();
  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
      {pct !== undefined && <Progress value={pct} tone={usageSeverity(pct, config)} className="h-1.5" />}
    </div>
  );
}

/**
 * Page détail d'un nœud Proxmox — approche vCenter (v2) : le nœud est sélectionnable dans
 * l'arborescence comme une VM, et sa page détail plein écran remplace le tableau.
 * Onglets Résumé / Monitor / VMs. Le Résumé est une grille personnalisable
 * (4 KPIs + 3 capacity planning niveau nœud, drag/resize/bibliothèque, persistance
 * /api/user-config par compte). Données : live (snapshot WS 5 s) + InfluxDB (Monitor).
 */
export function NodeDetail({ endpointId, endpointName, node, vms, onClose, onOpenVm }: Props) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const [tab, setTab] = useState<Tab>('summary');
  // Capacity planning du NŒUD (disk = rootfs) — section « Capacité du nœud » du Résumé.
  const capacity = useNodeCapacity(endpointId, node.node);

  // Personnalisation de la grille Résumé par utilisateur : scope = « endpoint/nomDuNœud »
  // (⚠️ le hostname est le seul identifiant nœud PVE — un renommage de nœud remet le
  // layout à zéro, même arbitrage que le Monitor nœud `nodeView`). Persistance
  // /api/user-config (serveur = source de vérité, suit le compte → survit à la reconnexion).
  const scope = `${endpointId}/${node.node}`;
  const stored = useUserConfig((s) => s.config?.pages.nodeSummary?.[scope] ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

  // Ratios de surallocation du nœud (RAM : avec provision hôte, idem dashboard).
  const usedCores = node.cpus ? (node.cpuPct / 100) * node.cpus : null;
  const cpuRatio = node.cpus ? node.cpuAllocCores / node.cpus : null;
  const ramRatio = node.memTotalBytes
    ? (node.ramAllocBytes + (config.hostRamProvisionPct / 100) * node.memTotalBytes) / node.memTotalBytes
    : null;

  // Filtres du tableau VMs (locaux — le deep-link porte sur le nœud, pas sur ce tableau).
  const [query, setQuery] = useState('');
  const [statusSel, setStatusSel] = useState('');
  const [typeSel, setTypeSel] = useState('');
  const [sort, setSort] = useState<{ key: VmSortKey; dir: VmSortDir }>({ key: 'name', dir: 'asc' });

  const rows: VmRow[] = vms.map((vm) => ({ vm, endpointId }));
  const runningCount = vms.filter((v) => v.status === 'running').length;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'summary', label: t('vm.tab.summary') },
    { id: 'monitor', label: t('vm.tab.monitor') },
    { id: 'vms', label: t('vm.tab.vms') },
  ];

  // Catalogue des widgets du Résumé — 4 cartes KPI (live WS) + 3 graphiques
  // capacity planning NIVEAU NŒUD (par élément). Les corps capturent les valeurs
  // dérivées (node live, capacity) — le catalogue est reconstruit quand elles
  // changent. Les ids sont STATIQUES → la clé du catalogue est stable.
  const catalog = useMemo<CoreWidgetDef[]>(() => {
    return [
      {
        id: 'kpi-cpu',
        title: t('metrics.cpu'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <KpiBody
            value={node.online ? `${node.cpuPct.toFixed(0)} %` : '—'}
            sub={
              node.online && usedCores !== null && node.cpus
                ? t('node.kpi.cores', { used: usedCores.toFixed(1), total: node.cpus })
                : '—'
            }
            pct={node.online ? node.cpuPct : undefined}
          />
        ),
      },
      {
        id: 'kpi-ram',
        title: t('metrics.ram'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <KpiBody
            value={node.online ? `${node.ramPct.toFixed(0)} %` : '—'}
            sub={node.online && node.memTotalBytes ? `${formatBytes(node.memUsedBytes)} / ${formatBytes(node.memTotalBytes)}` : '—'}
            pct={node.online ? node.ramPct : undefined}
          />
        ),
      },
      {
        id: 'kpi-disk',
        title: t('nodes.disk'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <KpiBody
            value={node.online ? `${node.diskPct.toFixed(0)} %` : '—'}
            sub={t('node.kpi.rootfs')}
            pct={node.online ? node.diskPct : undefined}
          />
        ),
      },
      {
        id: 'kpi-load',
        title: t('node.kpi.load'),
        default: { w: 3, h: 2 },
        minW: 2,
        minH: 2,
        render: () => (
          <KpiBody
            value={node.online && node.loadavg ? node.loadavg[0].toFixed(2) : '—'}
            sub={
              node.online && node.loadavg
                ? `${node.loadavg.map((v) => v.toFixed(2)).join(' / ')} ${t('node.kpi.loadSub')}`
                : '—'
            }
          />
        ),
      },
      {
        id: 'capacity-cpu',
        title: t('capacity.titleCpu'),
        default: { w: 4, h: 4 },
        minW: 3,
        minH: 3,
        render: () => <CapacityChartBody capacity={capacity} metric="cpu" />,
      },
      {
        id: 'capacity-ram',
        title: t('capacity.titleRam'),
        default: { w: 4, h: 4 },
        minW: 3,
        minH: 3,
        render: () => <CapacityChartBody capacity={capacity} metric="ram" />,
      },
      {
        id: 'capacity-disk',
        title: t('capacity.titleDisk'),
        default: { w: 4, h: 4 },
        minW: 3,
        minH: 3,
        render: () => <CapacityChartBody capacity={capacity} metric="disk" />,
      },
    ];
  }, [t, node, usedCores, capacity]);

  // Clé du catalogue (ids) — stable (widgets statiques).
  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);

  // Layout par défaut « design validé » : rangée de 4 KPIs + rangée de 3 capacity.
  const defaultLayout = useMemo<WidgetItem[]>(
    () => [
      { widgetId: 'kpi-cpu', x: 0, y: 0, w: 3, h: 2 },
      { widgetId: 'kpi-ram', x: 3, y: 0, w: 3, h: 2 },
      { widgetId: 'kpi-disk', x: 6, y: 0, w: 3, h: 2 },
      { widgetId: 'kpi-load', x: 9, y: 0, w: 3, h: 2 },
      { widgetId: 'capacity-cpu', x: 0, y: 2, w: 4, h: 4 },
      { widgetId: 'capacity-ram', x: 4, y: 2, w: 4, h: 4 },
      { widgetId: 'capacity-disk', x: 8, y: 2, w: 4, h: 4 },
    ],
    [],
  );

  // FUSION « utilisateurs présents et futurs » : positions stockées priment ;
  // widget nouveau du code → ajouté en fin de grille ; disparu → bibliothèque.
  const merged = useMemo(
    () => mergePageConfig(stored, catalog, defaultLayout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, catalogKey, defaultLayout],
  );

  const onLayoutChange = (layout: WidgetItem[]) => {
    // Garde : RGL rappelle onLayoutChange sur les compactations parent-driven.
    if (layoutsEqual(layout, merged.layout)) return;
    updatePage('nodeSummary', scope, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => {
    updatePage('nodeSummary', scope, removeWidget(merged, widgetId));
  };
  const onAdd = (widgetId: string) => {
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('nodeSummary', scope, addWidget(merged, def));
  };
  const onReset = () => clearPage('nodeSummary', scope);

  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card">
      {/* En-tête : retour, icône, nom, état, ratios de surallocation, méta. */}
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <button
          onClick={onClose}
          title={t('vm.back')}
          aria-label={t('vm.back')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Server className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{node.node}</div>
          <div className="text-[11px] tabular-nums text-muted-foreground">
            {endpointName} / {node.node}
          </div>
        </div>
        {node.online ? (
          <Badge tone={node.severity === 'ok' ? 'ok' : node.severity === 'warn' ? 'warn' : 'crit'}>
            ● {t('nodes.online')}
          </Badge>
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
          {node.ip && node.uptimeSec !== null && <span> · </span>}
          {node.uptimeSec !== null && <span>{t('common.uptime')} {formatUptime(node.uptimeSec)}</span>}
        </div>
      </div>

      {/* Onglets (Résumé en premier, comme vSphere). */}
      <div className="flex gap-1 border-b px-3 pt-2">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={cn(
              'rounded-t-md border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors',
              tab === tb.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tb.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'summary' && (
          <div className="flex flex-col gap-3">
            {/* Barre d'outils : bibliothèque + réinitialiser + indicateur de sauvegarde. */}
            <div className="flex items-center justify-end">
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
                  ctx={{ endpointId, nodeName: node.node }}
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
        )}

        {/* Montage lazy : le Monitor (et ses requêtes InfluxDB) n'existe que quand l'onglet est ouvert. */}
        {tab === 'monitor' && <NodeMonitor endpointId={endpointId} node={node.node} />}

        {tab === 'vms' && (
          vms.length === 0 ? (
            <div className="rounded-lg border px-3 py-6 text-center text-xs text-muted-foreground">
              {t('node.vms.none')}
            </div>
          ) : (
            <>
              <div className="mb-2 text-xs text-muted-foreground">
                {t('node.vms.running', { n: runningCount, total: vms.length })}
              </div>
              <VmTable
                rows={rows}
                query={query}
                onQueryChange={setQuery}
                statusSel={statusSel}
                onStatusChange={setStatusSel}
                typeSel={typeSel}
                onTypeChange={setTypeSel}
                sortKey={sort.key}
                sortDir={sort.dir}
                onSortChange={(key, dir) => setSort({ key, dir })}
                selectedVmid={null}
                onSelectVm={(row) => onOpenVm(row.vm.vmid)}
              />
            </>
          )
        )}
      </div>
    </div>
  );
}
