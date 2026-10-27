import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Download, Search } from 'lucide-react';
import {
  buildNetworkInventory,
  buildNetworkInventoryAll,
  decodeNetSel,
  encodeNetSel,
  filterNetworkRows,
  type NetworkRowAll,
  type NetworkSeverity,
  type NetworkTopology,
} from '@prox4u/shared';
import { Badge } from '../../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { cn, formatBytes } from '../../../lib/utils';

interface Props {
  topologies: NetworkTopology[];
  endpointNames: Record<string, string>;
  /** 'all' = vue agrégée multi-endpoints (A) · sinon id d'endpoint. */
  view: string;
  onViewChange: (view: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** Réseau sélectionné dans le déroulé (encodé, ex. « vmbr0:10 ») — '' = tous. */
  netSel: string;
  onNetChange: (sel: string) => void;
}

const SEVERITY_TONE: Record<NetworkSeverity, 'ok' | 'warn' | 'crit' | 'default'> = {
  ok: 'ok',
  warn: 'warn',
  crit: 'crit',
  na: 'default',
};

/**
 * Inventaire réseaux → VMs (hypervision). Table au-dessus du graphe : une ligne par
 * réseau (segment pont+VLAN) avec agrégats (état, trafic, impact, stats) et, dépliée,
 * les VMs qui l'utilisent. Recherche unifiée (filtre aussi le graphe, piloté par la page).
 * Export CSV de l'inventaire complet. Vue « Tous les serveurs » (A) ou par endpoint.
 */
export function NetworkInventory({ topologies, endpointNames, view, onViewChange, query, onQueryChange, netSel, onNetChange }: Props) {
  const { t } = useTranslation();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const isAll = view === 'all';

  const allRows = useMemo(() => buildNetworkInventoryAll(topologies, endpointNames), [topologies, endpointNames]);
  const scoped = useMemo<NetworkRowAll[]>(() => {
    if (isAll) return allRows;
    const topo = topologies.find((x) => x.endpointId === view);
    if (!topo) return [];
    return buildNetworkInventory(topo).map((r) => ({
      ...r,
      endpointId: topo.endpointId,
      endpointName: endpointNames[topo.endpointId] ?? topo.endpointId,
    }));
  }, [isAll, view, topologies, endpointNames, allRows]);

  // Déroulé : liste dédoublonnée des réseaux de la vue courante (200 VLAN → 200 options, scrollable).
  const netOptions = useMemo(() => {
    const seen = new Map<string, { bridge: string; vlan: number | null }>();
    for (const r of scoped) {
      const sel = encodeNetSel(r.bridge, r.vlan);
      if (!seen.has(sel)) seen.set(sel, { bridge: r.bridge, vlan: r.vlan });
    }
    return [...seen.entries()];
  }, [scoped]);

  const netFilter = useMemo(() => {
    const net = decodeNetSel(netSel);
    return net ? { network: net } : undefined;
  }, [netSel]);

  const rows = useMemo(() => filterNetworkRows(scoped, query, netFilter), [scoped, query, netFilter]);

  // Le réseau sélectionné est toujours déplié (voir ses VMs immédiatement).
  const netSelKeys = useMemo(
    () => (netFilter ? new Set(rows.filter((r) => r.bridge === netFilter.network!.bridge && r.vlan === netFilter.network!.vlan).map((r) => r.key)) : new Set<string>()),
    [rows, netFilter],
  );

  const exportCsv = () => {
    // Inventaire plat : une ligne par interface VM sur un réseau (le vrai « qui est branché où »).
    const header = ['serveur', 'reseau', 'vlan', 'type', 'sous_reseau', 'noeud', 'vmid', 'vm', 'iface', 'ip', 'mac', 'etat'];
    const lines: string[][] = [];
    for (const r of rows) {
      for (const v of r.vms) {
        lines.push([
          r.endpointName,
          r.bridge,
          r.vlan === null ? 'natif' : String(r.vlan),
          r.kind === 'management' ? 'interne_proxmox' : 'externe',
          r.subnets.join(' '),
          v.node,
          String(v.vmid),
          v.name,
          v.iface,
          v.ip ?? '',
          v.mac ?? '',
          v.status,
        ]);
      }
    }
    const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [header, ...lines].map((l) => l.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventaire-reseaux-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border bg-card">
      {/* En-tête : vue · recherche · export */}
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="flex rounded-lg border p-0.5">
          <button
            onClick={() => onViewChange('all')}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              isAll ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('topo.inv.view.all')}
          </button>
          {topologies.map((tp) => (
            <button
              key={tp.endpointId}
              onClick={() => onViewChange(tp.endpointId)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                view === tp.endpointId ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {endpointNames[tp.endpointId] ?? tp.endpointId}
            </button>
          ))}
        </div>

        <select
          value={netSel}
          onChange={(e) => onNetChange(e.target.value)}
          aria-label={t('topo.inv.col.network')}
          className="max-w-[220px] rounded-md border bg-card px-2 py-1.5 text-xs font-medium text-foreground"
        >
          <option value="">{t('topo.inv.select.all')}</option>
          {netOptions.map(([sel, { bridge, vlan }]) => (
            <option key={sel} value={sel}>
              {bridge} · {vlan === null ? t('topo.vlan.native') : `${t('topo.vlan.label')} ${vlan}`}
            </option>
          ))}
        </select>

        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('topo.inv.search.placeholder')}
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <Download className="h-3 w-3" />
          {t('topo.inv.export')}
        </button>
      </div>

      {/* Tableau */}
      {rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">{t('topo.inv.empty')}</div>
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <th className="w-6" />
              {isAll && <TableHead>{t('topo.inv.col.server')}</TableHead>}
              <TableHead>{t('topo.inv.col.network')}</TableHead>
              <TableHead>{t('topo.inv.col.kind')}</TableHead>
              <TableHead>{t('topo.inv.col.subnet')}</TableHead>
              <TableHead>{t('topo.inv.col.nodes')}</TableHead>
              <TableHead className="text-right">{t('topo.inv.col.vms')}</TableHead>
              <TableHead className="text-right">{t('topo.inv.col.traffic')}</TableHead>
              <TableHead>{t('topo.inv.col.state')}</TableHead>
              <TableHead>{t('topo.inv.col.impact')}</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const open = expandedKey === r.key || netSelKeys.has(r.key);
              const impacted = r.impactedCount + r.degradedCount;
              return (
                <FragmentRow
                  key={r.key}
                  row={r}
                  isAll={isAll}
                  open={open}
                  onToggle={() => setExpandedKey(open ? null : r.key)}
                  impacted={impacted}
                />
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function FragmentRow({ row, isAll, open, onToggle, impacted }: { row: NetworkRowAll; isAll: boolean; open: boolean; onToggle: () => void; impacted: number }) {
  const { t } = useTranslation();
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="w-6 px-1">
          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
        </TableCell>
        {isAll && <TableCell className="text-xs text-muted-foreground">{row.endpointName}</TableCell>}
        <TableCell>
          <div className="flex items-center gap-2 text-xs font-medium">
            {row.bridge}
            <Badge tone={row.vlan === null ? 'default' : 'primary'}>{row.vlan === null ? t('topo.vlan.native') : row.vlan}</Badge>
          </div>
        </TableCell>
        <TableCell>
          <Badge tone={row.kind === 'management' ? 'primary' : 'default'}>{t(`topo.inv.kind.${row.kind}`)}</Badge>
        </TableCell>
        <TableCell className="font-mono text-[11px] text-muted-foreground">{row.subnets.join(' ') || '—'}</TableCell>
        <TableCell className="text-xs text-muted-foreground">{row.nodes.join(', ')}</TableCell>
        <TableCell className="text-right text-xs">
          <span className="font-medium">{row.running + row.stopped}</span>
          <span className="ml-1 text-[10px] text-muted-foreground">
            {t('topo.inv.stats', { running: row.running, stopped: row.stopped })}
          </span>
        </TableCell>
        <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
          {formatBytes(row.trafficIn)}/s ↓ · {formatBytes(row.trafficOut)}/s ↑
        </TableCell>
        <TableCell>
          <Badge tone={SEVERITY_TONE[row.severity]}>{t(`topo.inv.state.${row.severity}`)}</Badge>
        </TableCell>
        <TableCell>
          {impacted > 0 ? (
            <Badge tone={row.impactedCount > 0 ? 'crit' : 'warn'}>
              {t('topo.inv.impact', { impacted: row.impactedCount, degraded: row.degradedCount })}
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <tr className="bg-muted/30">
          <td colSpan={isAll ? 10 : 9} className="px-6 py-2">
            {row.vms.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">{t('topo.inv.noVms')}</div>
            ) : (
              <Table>
                <TableHeader>
                  <tr>
                    <TableHead>{t('topo.iface.col.iface')}</TableHead>
                    <TableHead>{t('topo.iface.col.vm')}</TableHead>
                    <TableHead>{t('topo.iface.col.ip')}</TableHead>
                    <TableHead>{t('topo.iface.col.mac')}</TableHead>
                    <TableHead>{t('topo.legend.node')}</TableHead>
                    <TableHead>{t('common.state')}</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {row.vms.map((v) => (
                    <tr key={`${v.vmid}-${v.iface}`}>
                      <TableCell className="text-xs font-medium">{v.iface}</TableCell>
                      <TableCell className="text-xs">
                        <span className="font-medium">{v.name}</span>
                        <span className="ml-1 text-[10px] text-muted-foreground">{v.vmid}</span>
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">{v.ip ?? (v.ipMode ? t(`common.ip.${v.ipMode}`) : '—')}</TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">{v.mac ?? '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{v.node}</TableCell>
                      <TableCell>
                        <Badge tone={v.status === 'running' ? 'ok' : 'default'}>{t(`topo.status.${v.status}`)}</Badge>
                      </TableCell>
                    </tr>
                  ))}
                </TableBody>
              </Table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}


