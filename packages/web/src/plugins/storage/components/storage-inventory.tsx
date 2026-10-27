import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  type PveStorageType,
  type SeverityOrNa,
  type StorageInventoryEndpoint,
  type StorageRowAll,
  type StorageSort,
  type StorageSortKey,
} from '@prox4u/shared';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
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

export function StorageInventory({ endpoints, endpointNames, view, onViewChange, query, onQueryChange, typeSel, onTypeChange }: Props) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [vmLimit, setVmLimit] = useState(VM_PAGE);
  const [sort, setSort] = useState<StorageSort>({ key: 'datastore', dir: 'asc' });
  const isAll = view === 'all';

  const toggleSort = (key: StorageSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'capacity' || key === 'vms' || key === 'state' ? 'desc' : 'asc' }));
  const toggleRow = (key: string) => {
    setExpandedKey((cur) => (cur === key ? null : key));
    setVmLimit(VM_PAGE); // réinitialiser la pagination à chaque ligne dépliée
  };

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
              <SortHead label={t('storage.col.datastore')} sortKey="datastore" sort={sort} onSort={toggleSort} />
              {isAll && <SortHead label={t('storage.col.server')} sortKey="server" sort={sort} onSort={toggleSort} />}
              <SortHead label={t('storage.col.type')} sortKey="type" sort={sort} onSort={toggleSort} />
              <TableHead>{t('storage.col.node')}</TableHead>
              <SortHead label={t('storage.col.capacity')} sortKey="capacity" sort={sort} onSort={toggleSort} className="w-[240px]" />
              <TableHead>{t('storage.col.content')}</TableHead>
              <SortHead label={t('storage.col.vms')} sortKey="vms" sort={sort} onSort={toggleSort} className="text-right" align="right" />
              <SortHead label={t('storage.col.state')} sortKey="state" sort={sort} onSort={toggleSort} />
            </tr>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const open = expandedKey === r.key;
              const sev = storageSeverity(r, config);
              return (
                <FragmentRow
                  key={r.key}
                  row={r}
                  isAll={isAll}
                  open={open}
                  sev={sev}
                  vmLimit={vmLimit}
                  onShowMore={() => setVmLimit((v) => v + VM_PAGE)}
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
  isAll,
  open,
  sev,
  vmLimit,
  onShowMore,
  onToggle,
}: {
  row: StorageRowAll;
  isAll: boolean;
  open: boolean;
  sev: SeverityOrNa;
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
        <TableCell>
          <div className="flex items-center gap-2 text-xs font-medium">
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {row.storage}
          </div>
        </TableCell>
        {isAll && <TableCell className="text-xs text-muted-foreground">{row.endpointName}</TableCell>}
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
          <td colSpan={isAll ? 9 : 8} className="px-6 py-2">
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
                        <TableCell className="text-right font-mono text-[11px] text-muted-foreground">{formatBytes(v.diskBytes)}</TableCell>
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
          </td>
        </tr>
      )}
    </>
  );
}
