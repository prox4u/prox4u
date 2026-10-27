import { useState } from 'react';
import { ArrowLeft, Cpu, Gauge, HardDrive, MemoryStick, Server, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NodeHealth, VmSortDir, VmSortKey, VmSummary } from '@prox4u/shared';
import { overcommitTone, usageSeverity } from '@prox4u/shared';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent } from '../../../components/ui/card';
import { Progress } from '../../../components/ui/progress';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
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

/** Carte KPI du nœud (même style que la page nœud hypervision). */
function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  pct?: number;
}) {
  const config = useOvercommitConfig();
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <div className="text-[11px] text-muted-foreground">{sub}</div>
        {pct !== undefined && <Progress value={pct} tone={usageSeverity(pct, config)} className="h-1.5" />}
      </CardContent>
    </Card>
  );
}

/**
 * Page détail d'un nœud Proxmox — approche vCenter (v2) : le nœud est sélectionnable dans
 * l'arborescence comme une VM, et sa page détail plein écran remplace le tableau.
 * Onglets Résumé / Monitor / VMs. Données : live (snapshot WS 5 s) + InfluxDB (Monitor).
 */
export function NodeDetail({ endpointId, endpointName, node, vms, onClose, onOpenVm }: Props) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const [tab, setTab] = useState<Tab>('summary');

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
          {node.ip && node.version && <span> · </span>}
          {node.version && <span>PVE {node.version}</span>}
          {(node.ip || node.version) && node.uptimeSec !== null && <span> · </span>}
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
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard
              icon={Cpu}
              label={t('metrics.cpu')}
              value={node.online ? `${node.cpuPct.toFixed(0)} %` : '—'}
              sub={
                node.online && usedCores !== null && node.cpus
                  ? t('node.kpi.cores', { used: usedCores.toFixed(1), total: node.cpus })
                  : '—'
              }
              pct={node.online ? node.cpuPct : undefined}
            />
            <StatCard
              icon={MemoryStick}
              label={t('metrics.ram')}
              value={node.online ? `${node.ramPct.toFixed(0)} %` : '—'}
              sub={
                node.online && node.memTotalBytes
                  ? `${formatBytes(node.memUsedBytes)} / ${formatBytes(node.memTotalBytes)}`
                  : '—'
              }
              pct={node.online ? node.ramPct : undefined}
            />
            <StatCard
              icon={HardDrive}
              label={t('nodes.disk')}
              value={node.online ? `${node.diskPct.toFixed(0)} %` : '—'}
              sub={t('node.kpi.rootfs')}
              pct={node.online ? node.diskPct : undefined}
            />
            <StatCard
              icon={Gauge}
              label={t('node.kpi.load')}
              value={node.online && node.loadavg ? node.loadavg[0].toFixed(2) : '—'}
              sub={
                node.online && node.loadavg
                  ? `${node.loadavg.map((v) => v.toFixed(2)).join(' / ')} ${t('node.kpi.loadSub')}`
                  : '—'
              }
            />
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
