import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { InvFilter, InvSortDir, InvSortKey, InvVm } from '@prox4u/shared';
import { fmtSize, invTotalDiskMb, osDisplay } from '@prox4u/shared';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { Input, Select } from '../../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';

export interface InvTableProps {
  vms: InvVm[];
  filter: InvFilter;
  onFilterChange: (f: InvFilter) => void;
  sortKey: InvSortKey;
  sortDir: InvSortDir;
  onSortChange: (key: InvSortKey, dir: InvSortDir) => void;
}

type ColKind = 'text' | 'enum' | 'num' | 'multi';
interface Col {
  key: string;
  labelKey: string;
  kind: ColKind;
  sortKey?: InvSortKey;
  /** champ du filtre (node/type/status/cpu/ram/disk) */
  filter?: 'node' | 'type' | 'status' | 'cpu' | 'ram' | 'disk';
}

const COLS: Col[] = [
  { key: 'name', labelKey: 'pxinv.col.name', kind: 'text', sortKey: 'name' },
  { key: 'hostname', labelKey: 'pxinv.col.hostname', kind: 'text' },
  { key: 'vmid', labelKey: 'pxinv.col.vmid', kind: 'num', sortKey: 'vmid' },
  { key: 'host', labelKey: 'pxinv.col.host', kind: 'text' },
  { key: 'node', labelKey: 'pxinv.col.node', kind: 'enum', sortKey: 'node', filter: 'node' },
  { key: 'type', labelKey: 'pxinv.col.type', kind: 'enum', sortKey: 'type', filter: 'type' },
  { key: 'status', labelKey: 'pxinv.col.status', kind: 'enum', sortKey: 'status', filter: 'status' },
  { key: 'osType', labelKey: 'pxinv.col.osType', kind: 'text', sortKey: undefined },
  { key: 'cpuCores', labelKey: 'pxinv.col.cpuCores', kind: 'num', sortKey: 'cpuCores' },
  { key: 'cpuPct', labelKey: 'pxinv.col.cpuPct', kind: 'num', sortKey: 'cpuPct', filter: 'cpu' },
  { key: 'ramAllocMb', labelKey: 'pxinv.col.ramAlloc', kind: 'num', sortKey: 'ramAllocMb' },
  { key: 'ramUsedMb', labelKey: 'pxinv.col.ramUsed', kind: 'num', sortKey: 'ramUsedMb', filter: 'ram' },
  { key: 'ramUsedPct', labelKey: 'pxinv.col.ramPct', kind: 'num', sortKey: 'ramUsedPct' },
  { key: 'uptimeS', labelKey: 'pxinv.col.uptime', kind: 'num', sortKey: 'uptimeS' },
  { key: 'disks', labelKey: 'pxinv.col.disks', kind: 'multi', sortKey: 'diskMb', filter: 'disk' },
  { key: 'interfaces', labelKey: 'pxinv.col.interfaces', kind: 'multi' },
  { key: 'ips', labelKey: 'pxinv.col.ips', kind: 'multi' },
  { key: 'tags', labelKey: 'pxinv.col.tags', kind: 'multi' },
  { key: 'notes', labelKey: 'pxinv.col.notes', kind: 'text' },
  { key: 'template', labelKey: 'pxinv.col.template', kind: 'enum' },
];

function na(t: (k: string) => string): string {
  return t('pxinv.na');
}

/**
 * Un disque = deux lignes : le badge porte le point de montage + l'occupation (%) —
 * l'info actionable — et une sous-ligne atténuée donne les tailles utilisées/total.
 */
function diskBadge(d: InvVm['disks'][number]): { head: string; sub: string; tone: 'default' | 'warn' | 'crit' } {
  const pct = d.usedPct ?? 0;
  return {
    head: `${d.mountpoint} · ${Math.round(pct)}%`,
    sub: `${fmtSize(d.usedMb ?? 0)} / ${fmtSize(d.totalMb ?? 0)}`,
    tone: pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'default',
  };
}

/**
 * Tableau d'inventaire : une VM par ligne, multi-valeurs en badges, filtres par
 * colonne (sélecteurs énumérés + plages numériques), tri par en-tête. La
 * recherche globale est gérée par la page (champ dédié).
 */
export function ProxmoxInventoryTable({ vms, filter, onFilterChange, sortKey, sortDir, onSortChange }: InvTableProps) {
  const { t } = useTranslation();

  // Valeurs distinctes pour les sélecteurs énumérés (nœud/type/état).
  const distinct = useMemo(() => {
    const nodes = [...new Set(vms.map((v) => v.node))].sort();
    const types = [...new Set(vms.map((v) => v.type))].sort();
    const statuses = [...new Set(vms.map((v) => v.status))].sort();
    return { nodes, types, statuses };
  }, [vms]);

  const setEnum = (f: Col['filter'], value: string) => {
    if (f === 'node') onFilterChange({ ...filter, node: value });
    else if (f === 'type') onFilterChange({ ...filter, type: value });
    else if (f === 'status') onFilterChange({ ...filter, status: value });
  };
  const setRange = (f: Col['filter'], which: 'min' | 'max', value: string) => {
    const n = value === '' ? null : Number(value);
    if (f === 'cpu') onFilterChange({ ...filter, [which === 'min' ? 'cpuMin' : 'cpuMax']: n });
    else if (f === 'ram') onFilterChange({ ...filter, [which === 'min' ? 'ramMin' : 'ramMax']: n });
    else if (f === 'disk') onFilterChange({ ...filter, [which === 'min' ? 'diskMin' : 'diskMax']: n });
  };

  const cell = (v: InvVm, c: Col): React.ReactNode => {
    switch (c.key) {
      case 'name': return v.name;
      case 'hostname': return v.hostname ?? na(t);
      case 'vmid': return v.vmid;
      case 'host': return v.host;
      case 'node': return v.node;
      case 'type': return v.type;
      case 'status':
        return <Badge tone={v.status === 'running' ? 'ok' : v.status === 'stopped' ? 'default' : 'warn'}>{v.status}</Badge>;
      case 'osType':
        return (
          <div className="leading-tight">
            <div className="font-medium">{osDisplay(v)}</div>
            {(v.osArch || v.osKernel) && (
              <div className="text-[10px] text-muted-foreground">
                {[v.osArch, v.osKernel ? `noyau ${v.osKernel}` : null].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        );
      case 'cpuCores': return v.cpuCores ?? na(t);
      case 'cpuPct': return v.cpuPct != null ? `${v.cpuPct.toFixed(1)} %` : na(t);
      case 'ramAllocMb': return v.ramAllocMb != null ? fmtSize(v.ramAllocMb) : na(t);
      case 'ramUsedMb': return v.ramUsedMb != null ? fmtSize(v.ramUsedMb) : na(t);
      case 'ramUsedPct': return v.ramUsedPct != null ? `${v.ramUsedPct.toFixed(1)} %` : na(t);
      case 'uptimeS': return v.uptimeS != null ? String(Math.round(v.uptimeS)) : na(t);
      case 'disks':
        return v.disks.length
          ? (
            <div className="flex flex-col gap-1.5">
              {v.disks.map((d) => {
                const b = diskBadge(d);
                return (
                  <div key={d.mountpoint} className="flex flex-col gap-0.5">
                    <Badge tone={b.tone}>{b.head}</Badge>
                    <span className="pl-0.5 text-[10px] leading-none tabular-nums text-muted-foreground">{b.sub}</span>
                  </div>
                );
              })}
            </div>
          )
          : na(t);
      case 'interfaces':
        return v.interfaces.length
          ? <div className="flex flex-wrap gap-1">{v.interfaces.map((i) => <Badge key={i.name}>{i.name} {i.mac ?? ''}</Badge>)}</div>
          : na(t);
      case 'ips':
        return v.ips.length
          ? <div className="flex flex-wrap gap-1">{v.ips.map((ip) => <Badge key={ip} tone="default">{ip}</Badge>)}</div>
          : na(t);
      case 'tags':
        return v.tags.length
          ? <div className="flex flex-wrap gap-1">{v.tags.map((tag) => <Badge key={tag} tone="primary">{tag}</Badge>)}</div>
          : na(t);
      case 'notes': return v.notes ?? na(t);
      case 'template': return v.template ? t('pxinv.col.template') : '—';
      default: return null;
    }
  };

  const headFilter = (c: Col): React.ReactNode => {
    if (c.kind === 'enum' && c.filter) {
      const options = c.filter === 'node' ? distinct.nodes : c.filter === 'type' ? distinct.types : distinct.statuses;
      const current = c.filter === 'node' ? filter.node : c.filter === 'type' ? filter.type : filter.status;
      return (
        <Select value={current} onChange={(e) => setEnum(c.filter, e.target.value)} className="mt-1 h-7">
          <option value="">{t('pxinv.filter.all')}</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      );
    }
    if (c.filter === 'cpu' || c.filter === 'ram' || c.filter === 'disk') {
      const min = c.filter === 'cpu' ? filter.cpuMin : c.filter === 'ram' ? filter.ramMin : filter.diskMin;
      const max = c.filter === 'cpu' ? filter.cpuMax : c.filter === 'ram' ? filter.ramMax : filter.diskMax;
      return (
        <div className="mt-1 flex items-center gap-1">
          <Input type="number" placeholder={t('pxinv.filter.min')} value={min ?? ''} onChange={(e) => setRange(c.filter, 'min', e.target.value)} className="h-7" />
          <span className="text-muted-foreground">–</span>
          <Input type="number" placeholder={t('pxinv.filter.max')} value={max ?? ''} onChange={(e) => setRange(c.filter, 'max', e.target.value)} className="h-7" />
        </div>
      );
    }
    return null;
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLS.map((c) => (
            <TableHead key={c.key} className="align-top">
              {c.sortKey ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-1 hover:text-foreground"
                  onClick={() => onSortChange(c.sortKey!, sortKey === c.sortKey && sortDir === 'asc' ? 'desc' : 'asc')}
                >
                  {t(c.labelKey)}
                  {sortKey === c.sortKey
                    ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                    : <ArrowUpDown className="h-3 w-3 opacity-50" />}
                </button>
              ) : (
                t(c.labelKey)
              )}
              {headFilter(c)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {vms.map((v) => (
          <TableRow key={`${v.host}/${v.vmid}`}>
            {COLS.map((c) => (
              <TableCell key={c.key} className={c.kind === 'num' ? 'text-right tabular-nums' : undefined}>
                {cell(v, c)}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {vms.length === 0 && (
          <TableRow>
            <TableCell colSpan={COLS.length} className="py-8 text-center text-muted-foreground">
              {t('pxinv.empty')}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** Volume total d'une VM (Mo) — utilisé pour l'affichage / le tri. */
export { invTotalDiskMb };
