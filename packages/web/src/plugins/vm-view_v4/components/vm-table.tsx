import { useMemo } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_VM_FILTER,
  filterVmRows,
  sortVmRows,
  type VmSortDir,
  type VmSortKey,
  type VmSummary,
} from '@prox4u/shared';
import { Badge } from '../../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { cn, formatBytes } from '../../../lib/utils';

export interface VmRow {
  vm: VmSummary;
  endpointId: string;
}

interface Props {
  /** VMs du périmètre sélectionné dans l'arborescence. */
  rows: VmRow[];
  query: string;
  onQueryChange: (q: string) => void;
  statusSel: string;
  onStatusChange: (s: string) => void;
  typeSel: string;
  onTypeChange: (t: string) => void;
  sortKey: VmSortKey;
  sortDir: VmSortDir;
  onSortChange: (key: VmSortKey, dir: VmSortDir) => void;
  selectedVmid: number | null;
  onSelectVm: (row: VmRow) => void;
}

const STATUS_TONE = { running: 'ok', paused: 'warn', stopped: 'default', unknown: 'default' } as const;

export function VmTable(props: Props) {
  const { t } = useTranslation();
  const { rows, query, onQueryChange, statusSel, onStatusChange, typeSel, onTypeChange, sortKey, sortDir, onSortChange, selectedVmid, onSelectVm } = props;

  const filtered = useMemo(
    () =>
      sortVmRows(
        filterVmRows(
          rows.map((r) => r.vm),
          query,
          { ...DEFAULT_VM_FILTER, status: (statusSel || 'all') as typeof DEFAULT_VM_FILTER.status, type: (typeSel || 'all') as typeof DEFAULT_VM_FILTER.type },
        ),
        sortKey,
        sortDir,
      ),
    [rows, query, statusSel, typeSel, sortKey, sortDir],
  );

  const byVmid = useMemo(() => new Map(rows.map((r) => [r.vm.vmid, r])), [rows]);
  const running = filtered.filter((v) => v.status === 'running').length;
  const stopped = filtered.length - running;

  const header = (label: string, key: VmSortKey, className?: string) => (
    <TableHead className={cn('cursor-pointer select-none', className)} onClick={() => onSortChange(key, sortKey === key && sortDir === 'asc' ? 'desc' : 'asc')}>
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === key ? (
          sortDir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </span>
    </TableHead>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusSel}
          onChange={(e) => onStatusChange(e.target.value)}
          aria-label={t('vm.filter.status')}
          className="max-w-[160px] rounded-md border bg-card px-2 py-1.5 text-xs font-medium text-foreground"
        >
          <option value="">{t('vm.filter.status')} : {t('vm.all')}</option>
          <option value="running">{t('vm.status.running')}</option>
          <option value="paused">{t('vm.status.paused')}</option>
          <option value="stopped">{t('vm.status.stopped')}</option>
        </select>

        <select
          value={typeSel}
          onChange={(e) => onTypeChange(e.target.value)}
          aria-label={t('vm.filter.type')}
          className="max-w-[160px] rounded-md border bg-card px-2 py-1.5 text-xs font-medium text-foreground"
        >
          <option value="">{t('vm.filter.type')} : {t('vm.all')}</option>
          <option value="qemu">VM</option>
          <option value="lxc">LXC</option>
        </select>

        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('vm.search.placeholder')}
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('vm.stats', { running, stopped, total: filtered.length })}
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {header(t('vm.col.name'), 'name')}
              {header(t('vm.col.id'), 'vmid', 'w-16')}
              {header(t('vm.col.node'), 'node')}
              {header(t('vm.col.type'), 'type')}
              {header(t('vm.col.status'), 'status')}
              {header(t('vm.col.agent'), 'agentActive')}
              {header(t('vm.col.cpu'), 'cpuPct', 'text-right')}
              {header(t('vm.col.mem'), 'memBytes', 'text-right')}
              {header(t('vm.col.disk'), 'diskBytes', 'text-right')}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={9} className="py-10 text-center text-xs text-muted-foreground">
                  {t('vm.empty')}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((v) => {
                const row = byVmid.get(v.vmid);
                if (!row) return null;
                const selected = selectedVmid === v.vmid;
                return (
                  <TableRow
                    key={v.vmid}
                    onClick={() => onSelectVm(row)}
                    className={cn('cursor-pointer', selected && 'bg-accent')}
                  >
                    <TableCell className="font-medium">{v.name}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{v.vmid}</TableCell>
                    <TableCell className="text-muted-foreground">{v.node}</TableCell>
                    <TableCell>
                      <Badge tone={v.type === 'lxc' ? 'primary' : 'default'} className="px-1.5 py-0 text-[10px] uppercase">
                        {v.type === 'lxc' ? 'LXC' : 'VM'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone={STATUS_TONE[v.status]} className="gap-1.5">
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            v.status === 'running' ? 'bg-ok' : v.status === 'paused' ? 'bg-warn' : 'bg-muted-foreground/50',
                          )}
                        />
                        {t(`vm.status.${v.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {v.agentActive === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : v.agentActive ? (
                        <Badge tone="ok" className="gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                          {t('vm.agent.active')}
                        </Badge>
                      ) : (
                        <Badge tone="crit" className="gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-crit" />
                          {t('vm.agent.down')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{v.cpuPct.toFixed(1)} %</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(v.memBytes)}
                      {v.maxmemBytes != null && <span className="text-muted-foreground"> / {formatBytes(v.maxmemBytes)}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {v.diskBytes != null ? formatBytes(v.diskBytes) : '—'}
                      {v.maxdiskBytes != null && <span className="text-muted-foreground"> / {formatBytes(v.maxdiskBytes)}</span>}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
