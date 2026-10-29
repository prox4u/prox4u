import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { LineSeriesOption } from 'echarts/charts';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsUpDown,
  Database,
  Download,
  FolderOpen,
  HardDrive,
  Layers,
  Network,
  Search,
  type LucideIcon,
} from 'lucide-react';
import {
  buildStorageInventory,
  buildStorageInventoryAll,
  filterStorageRows,
  sortStorageRows,
  storageSeverity,
  usageSeverity,
  type DatastoreHistoryEntry,
  type PveStorageType,
  type Severity,
  type SeverityOrNa,
  type StorageInventoryEndpoint,
  type StorageRowAll,
  type StorageSort,
  type StorageSortKey,
} from '@prox4u/shared';
import { fetchStorageDatastoreHistory } from '../../../core/api/apiClient';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { Badge } from '../../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { cn, formatBytes } from '../../../lib/utils';

interface Props {
  endpoints: StorageInventoryEndpoint[];
  endpointNames: Record<string, string>;
  /** 'all' = vue agrégée multi-endpoints · sinon id d'endpoint. */
  view: string;
  onViewChange: (view: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** Type sélectionné dans le déroulé — '' = tous. */
  typeSel: string;
  onTypeChange: (t: string) => void;
  /** Portée d'historique des graphiques d'occupation : 1 an (défaut) ou 31 j. */
  range: 'year' | 'month';
  onRangeChange: (r: 'year' | 'month') => void;
}

/** Icône par type de datastore (vue type vCenter). */
const TYPE_ICON: Record<PveStorageType, LucideIcon> = {
  rbd: Database,
  cephfs: Database,
  nfs: Network,
  dir: FolderOpen,
  lvm: HardDrive,
  lvmthin: HardDrive,
  zfs: Layers,
  pbs: Database,
  iscsi: HardDrive,
  cifs: Network,
};

const SEVERITY_TONE: Record<SeverityOrNa, 'ok' | 'warn' | 'crit' | 'default'> = {
  ok: 'ok',
  warn: 'warn',
  crit: 'crit',
  na: 'default',
};

/** Barre de capacité vCenter : fond = total, remplissage = utilisé, teinte = sévérité. */
function CapacityBar({ pct, sev }: { pct: number; sev: SeverityOrNa }) {
  const fill = sev === 'crit' ? 'bg-crit' : sev === 'warn' ? 'bg-warn' : sev === 'ok' ? 'bg-ok' : 'bg-muted-foreground/40';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 min-w-[90px] flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', fill)} style={{ width: `${sev === 'na' ? 0 : pct}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] font-medium tabular-nums">{sev === 'na' ? '—' : `${pct}%`}</span>
    </div>
  );
}

/**
 * Inventaire stockage → VMs (hypervision, vue type vCenter). Une ligne par
 * datastore : barre de capacité colorée, icône de type, nœuds/partagé, contenus,
 * VMs hébergées. Dépliée, liste les VMs dont le disque est sur ce datastore.
 * Recherche + déroulé de type + vue agrégée + export CSV.
 */
/** VMs visibles dans le drill-down avant « Afficher plus » (garde-fou prod). */
const VM_PAGE = 50;

export function StorageInventory({ endpoints, endpointNames, view, onViewChange, query, onQueryChange, typeSel, onTypeChange, range, onRangeChange }: Props) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  // Déploiement multiple : chaque ligne est indépendante (l'utilisateur contrôle
  // lui-même quel datastore est ouvert — plus aucun rabattage automatique).
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  // Pagination « Afficher plus » par ligne (clé = clé de la ligne).
  const [vmLimits, setVmLimits] = useState<Map<string, number>>(new Map());
  const [sort, setSort] = useState<StorageSort>({ key: 'server', dir: 'asc' });
  // Historique d'occupation + forecast par datastore, indexé par endpointId.
  const [history, setHistory] = useState<Record<string, DatastoreHistoryEntry[]>>({});
  const isAll = view === 'all';

  // Récupère l'historique par datastore pour chaque endpoint (occupation +
  // capacity planning). Rechargé quand la liste d'endpoints change (rafraîchi).
  const loadHistory = useCallback(async () => {
    const res = await Promise.all(endpoints.map((ep) => fetchStorageDatastoreHistory(ep.endpointId, range)));
    const m: Record<string, DatastoreHistoryEntry[]> = {};
    for (const r of res) m[r.endpointId] = r.datastores;
    setHistory(m);
  }, [endpoints, range]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const toggleSort = (key: StorageSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'capacity' || key === 'volumes' || key === 'vms' || key === 'state' ? 'desc' : 'asc' }));
  const toggleRow = (key: string) =>
    setExpandedKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const showMoreVms = (key: string) => setVmLimits((m) => new Map(m).set(key, (m.get(key) ?? VM_PAGE) + VM_PAGE));

  const allRows = useMemo(() => buildStorageInventoryAll(endpoints, endpointNames), [endpoints, endpointNames]);
  const scoped = useMemo<StorageRowAll[]>(() => {
    if (isAll) return allRows;
    const ep = endpoints.find((x) => x.endpointId === view);
    if (!ep) return [];
    const name = endpointNames[ep.endpointId] ?? ep.endpointId;
    return buildStorageInventory(ep.storages, ep.vms).map((r) => ({ ...r, endpointId: ep.endpointId, endpointName: name }));
  }, [isAll, view, endpoints, endpointNames, allRows]);

  // Déroulé : types présents dans la vue courante (dédoublonnés).
  const typeOptions = useMemo(() => {
    const seen = new Set<PveStorageType>();
    for (const r of scoped) seen.add(r.type);
    return [...seen].sort();
  }, [scoped]);

  const rows = useMemo(
    () => sortStorageRows(filterStorageRows(scoped, query, typeSel ? { type: typeSel as PveStorageType } : undefined), config, sort),
    [scoped, query, typeSel, config, sort],
  );

  const exportCsv = () => {
    // Inventaire plat : une ligne par VM sur un datastore (le vrai « quoi est stocké où »).
    const header = ['serveur', 'datastore', 'type', 'nature', 'noeud', 'vmid', 'vm', 'noeud_vm', 'disque_octets', 'etat'];
    const lines: string[][] = [];
    for (const r of rows) {
      for (const v of r.vms) {
        lines.push([
          r.endpointName,
          r.storage,
          r.type,
          r.kind,
          r.nodes.join(' '),
          String(v.vmid),
          v.name,
          v.node,
          String(v.diskBytes),
          v.status,
        ]);
      }
    }
    const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [header, ...lines].map((l) => l.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventaire-stockage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border bg-card">
      {/* En-tête : vue · déroulé type · recherche · export */}
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="flex rounded-lg border p-0.5">
          <button
            onClick={() => onViewChange('all')}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              isAll ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('storage.view.all')}
          </button>
          {endpoints.map((ep) => (
            <button
              key={ep.endpointId}
              onClick={() => onViewChange(ep.endpointId)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                view === ep.endpointId ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {endpointNames[ep.endpointId] ?? ep.endpointId}
            </button>
          ))}
        </div>

        <select
          value={typeSel}
          onChange={(e) => onTypeChange(e.target.value)}
          aria-label={t('storage.col.type')}
          className="max-w-[200px] rounded-md border bg-card px-2 py-1.5 text-xs font-medium text-foreground"
        >
          <option value="">{t('storage.select.all')}</option>
          {typeOptions.map((ty) => (
            <option key={ty} value={ty}>
              {t(`storage.type.${ty}`)}
            </option>
          ))}
        </select>

        {/* Portée d'historique des graphiques d'occupation (drill-down). */}
        <div className="flex rounded-lg border p-0.5" role="group" aria-label={t('storage.range.label')}>
          {(['year', 'month'] as const).map((r) => (
            <button
              key={r}
              onClick={() => onRangeChange(r)}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                range === r ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(r === 'year' ? 'storage.range.year' : 'storage.range.month')}
            </button>
          ))}
        </div>

        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('storage.search.placeholder')}
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <button
          onClick={exportCsv}
          disabled={rows.some((r) => r.vms.length > 0) ? false : true}
          className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <Download className="h-3 w-3" />
          {t('storage.export')}
        </button>
      </div>

      {/* Tableau */}
      {rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">{t('storage.empty')}</div>
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <th className="w-6" />
              <SortHead label={t('storage.col.server')} sortKey="server" sort={sort} onSort={toggleSort} />
              <SortHead label={t('storage.col.datastore')} sortKey="datastore" sort={sort} onSort={toggleSort} />
              <SortHead label={t('storage.col.type')} sortKey="type" sort={sort} onSort={toggleSort} />
              <TableHead>{t('storage.col.node')}</TableHead>
              <SortHead label={t('storage.col.capacity')} sortKey="capacity" sort={sort} onSort={toggleSort} className="w-[240px]" />
              <SortHead label={t('storage.col.volumes')} sortKey="volumes" sort={sort} onSort={toggleSort} className="text-right" align="right" />
              <TableHead>{t('storage.col.content')}</TableHead>
              <SortHead label={t('storage.col.vms')} sortKey="vms" sort={sort} onSort={toggleSort} className="text-right" align="right" />
              <SortHead label={t('storage.col.state')} sortKey="state" sort={sort} onSort={toggleSort} />
            </tr>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const open = expandedKeys.has(r.key);
              const sev = storageSeverity(r, config);
              const hist = history[r.endpointId]?.find((h) => h.storage === r.storage);
              return (
                <FragmentRow
                  key={r.key}
                  row={r}
                  open={open}
                  sev={sev}
                  hist={hist}
                  vmLimit={vmLimits.get(r.key) ?? VM_PAGE}
                  onShowMore={() => showMoreVms(r.key)}
                  onToggle={() => toggleRow(r.key)}
                />
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** En-tête de colonne triable : clic = alterner croissant/décroissant. */
function SortHead({
  label,
  sortKey,
  sort,
  onSort,
  className,
  align,
}: {
  label: string;
  sortKey: StorageSortKey;
  sort: StorageSort;
  onSort: (key: StorageSortKey) => void;
  className?: string;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'flex w-full items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
          align === 'right' && 'justify-end',
        )}
        aria-label={`${label} — ${active ? (sort.dir === 'asc' ? 'tri croissant' : 'tri décroissant') : 'trier'}`}
      >
        {label}
        <Icon className={cn('h-3 w-3 shrink-0', active ? 'text-primary' : 'opacity-40')} />
      </button>
    </TableHead>
  );
}

function FragmentRow({
  row,
  open,
  sev,
  hist,
  vmLimit,
  onShowMore,
  onToggle,
}: {
  row: StorageRowAll;
  open: boolean;
  sev: SeverityOrNa;
  /** historique d'occupation + forecast du datastore (undefined = pas encore d'historique). */
  hist: DatastoreHistoryEntry | undefined;
  vmLimit: number;
  onShowMore: () => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const Icon = TYPE_ICON[row.type];
  const shown = row.vms.slice(0, vmLimit);
  const hasMore = row.vms.length > shown.length;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="w-6 px-1">
          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{row.endpointName}</TableCell>
        <TableCell>
          <div className="flex items-center gap-2 text-xs font-medium">
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {row.storage}
          </div>
        </TableCell>
        <TableCell>
          <Badge tone={row.kind === 'shared' ? 'primary' : 'default'}>{t(`storage.type.${row.type}`)}</Badge>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {row.kind === 'shared' ? (
            <span className="text-primary">{t('storage.kind.shared')}</span>
          ) : (
            row.nodes.join(', ') || '—'
          )}
        </TableCell>
        <TableCell>
          <div className="space-y-0.5">
            <CapacityBar pct={row.pct} sev={sev} />
            <div className="text-[10px] tabular-nums text-muted-foreground">
              {row.hasCapacity ? `${formatBytes(row.used)} / ${formatBytes(row.total)}` : t('storage.na')}
            </div>
          </div>
        </TableCell>
        <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {row.diskAllocated > 0 ? formatBytes(row.diskAllocated) : '—'}
        </TableCell>
        <TableCell className="text-[11px] text-muted-foreground">{row.content.join(', ') || '—'}</TableCell>
        <TableCell className="text-right text-xs">
          <span className="font-medium">{row.running + row.stopped}</span>
          <span className="ml-1 text-[10px] text-muted-foreground">
            {t('storage.stats', { running: row.running, stopped: row.stopped })}
          </span>
        </TableCell>
        <TableCell>
          <Badge tone={SEVERITY_TONE[sev]}>{t(`storage.state.${sev}`)}</Badge>
        </TableCell>
      </TableRow>
      {open && (
        <tr className="bg-muted/30">
          <td colSpan={10} className="px-6 py-3">
            <DatastorePanels hist={hist} allocPct={row.total > 0 ? (row.diskAllocated / row.total) * 100 : null} />
            <div className="mt-3">
            {row.vms.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">{t('storage.noVms')}</div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <tr>
                      <TableHead>{t('storage.col.vm')}</TableHead>
                      <TableHead>{t('storage.col.vmid')}</TableHead>
                      <TableHead className="text-right">{t('storage.col.disk')}</TableHead>
                      <TableHead>{t('storage.col.vmnode')}</TableHead>
                      <TableHead>{t('common.state')}</TableHead>
                    </tr>
                  </TableHeader>
                  <TableBody>
                    {shown.map((v) => (
                      <tr key={v.vmid}>
                        <TableCell className="text-xs font-medium">{v.name}</TableCell>
                        <TableCell className="text-xs tabular-nums text-muted-foreground">{v.vmid}</TableCell>
                        <TableCell className="text-right font-mono text-[11px] tabular-nums">{formatBytes(v.diskBytes)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{v.node}</TableCell>
                        <TableCell>
                          <Badge tone={v.status === 'running' ? 'ok' : 'default'}>{t(`storage.vmstatus.${v.status === 'running' ? 'running' : 'stopped'}`)}</Badge>
                        </TableCell>
                      </tr>
                    ))}
                  </TableBody>
                </Table>
                {hasMore && (
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[11px] tabular-nums text-muted-foreground">{t('storage.vmShown', { shown: shown.length, total: row.vms.length })}</span>
                    <button
                      type="button"
                      onClick={onShowMore}
                      className="rounded-md border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {t('storage.showMore')}
                    </button>
                  </div>
                )}
              </>
            )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Couleur d'aire/ligne = sévérité de l'occupation courante (cohérent 🟢🟠🔴). */
const SEV_COLOR: Record<Severity, string> = { ok: '#10b981', warn: '#f59e0b', crit: '#ef4444' };
/** Ligne d'allocation : indigo pointillés (comme le graphe ressource du monitor). */
const ALLOC_COLOR = '#6366f1';

/**
 * Panneaux du drill-down datastore — même style que les graphs « monitor »
 * (resource-chart) : ligne colorée par sévérité de l'occupation courante, aire en
 * dégradé, bandes de seuil discrètes, ligne d'allocation indigo pointillée
 * (diskAllocated/total), occupation courante en haut à droite. + capacity planning
 * (jours avant 90 %, pente). Vide tant que le poller n'a pas d'historique.
 */
function DatastorePanels({ hist, allocPct }: { hist: DatastoreHistoryEntry | undefined; allocPct: number | null }) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  // Occupation courante (dernier point) → sévérité → couleur de la ligne.
  const current = hist && hist.points.length > 0 ? (hist.points[hist.points.length - 1].used / hist.points[hist.points.length - 1].total) * 100 : null;
  const sev = current !== null ? usageSeverity(current, config) : 'ok';
  const color = SEV_COLOR[sev];

  const option = useMemo<EChartsOption | null>(() => {
    if (!hist || hist.points.length === 0) return null;
    const data = hist.points.map((p) => [p.time * 1000, Math.round((p.used / p.total) * 1000) / 10]);
    const proj = hist.forecast.projection.map((p) => [p.time * 1000, p.value]);
    const { warnPct, critPct } = config.usage;
    const series: LineSeriesOption[] = [
      {
        name: t('storage.drilldown.occupancy'),
        type: 'line',
        smooth: true,
        symbol: 'none',
        data,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: `${color}55` },
              { offset: 1, color: `${color}00` },
            ],
          },
        },
        // bandes de seuils d'usage — fond très discret (style monitor)
        markArea: {
          silent: true,
          data: [
            [{ yAxis: 0, itemStyle: { color: '#10b981', opacity: 0.05 } }, { yAxis: warnPct }],
            [{ yAxis: warnPct, itemStyle: { color: '#f59e0b', opacity: 0.07 } }, { yAxis: critPct }],
            [{ yAxis: critPct, itemStyle: { color: '#ef4444', opacity: 0.08 } }, { yAxis: 100 }],
          ],
        },
        // ligne d'allocation (indigo pointillés) — % du datastore engagé par les disques VMs
        markLine:
          allocPct !== null
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { type: 'dashed', color: ALLOC_COLOR, width: 1.5 },
                label: { formatter: `${t('res.alloc')} ${Math.round(allocPct)} %`, color: ALLOC_COLOR, fontSize: 10, position: 'insideEndTop' },
                data: [{ yAxis: Math.min(allocPct, 99) }],
              }
            : undefined,
      },
      {
        name: t('capacity.projection'),
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: proj,
        lineStyle: { width: 2, type: 'dashed', color, opacity: 0.6 },
        itemStyle: { color },
      },
    ];
    return {
      animation: false,
      grid: { top: 24, right: 16, bottom: 20, left: 36 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? `${v.toFixed(1)} %` : String(v)),
      },
      legend: { top: 0, textStyle: { color: ct.legend, fontSize: 11 } },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series,
    };
  }, [hist, allocPct, color, ct, t, config]);

  const ref = useEChart(option);
  const fc = hist?.forecast;

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_220px]">
      <div className="rounded-lg border bg-card p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold">{t('storage.drilldown.occupancy')}</span>
          {current !== null && (
            <span className={`text-sm font-semibold tabular-nums ${sev === 'crit' ? 'text-crit' : sev === 'warn' ? 'text-warn' : 'text-ok'}`}>
              {current.toFixed(0)} %
            </span>
          )}
        </div>
        {!option ? (
          <div className="flex h-32 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
            {t('storage.drilldown.noData')}
          </div>
        ) : (
          <div ref={ref} className="h-32 w-full" />
        )}
      </div>
      <div className="rounded-lg border bg-card p-2">
        <div className="mb-1 text-xs font-semibold">{t('storage.drilldown.capacity')}</div>
        {!fc ? (
          <div className="text-[11px] text-muted-foreground">—</div>
        ) : (
          <div className="space-y-1.5 text-[11px]">
            {fc.insufficientData ? (
              <Badge tone="default">{t('storage.drilldown.insufficient')}</Badge>
            ) : fc.daysTo90 !== null ? (
              <Badge tone={fc.daysTo90 < 30 ? 'crit' : fc.daysTo90 < 90 ? 'warn' : 'ok'}>
                {t('capacity.daysTo90', { days: fc.daysTo90 })}
              </Badge>
            ) : (
              <Badge tone="ok">{t('capacity.stable')}</Badge>
            )}
            <div className="text-muted-foreground">
              {fc.insufficientData
                ? '—'
                : `pente ${fc.slopePerDay >= 0 ? '+' : ''}${fc.slopePerDay.toFixed(2)} %/j`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
