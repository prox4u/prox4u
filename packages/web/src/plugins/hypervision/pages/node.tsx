import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, Cpu, Gauge, HardDrive, Loader2, MemoryStick, type LucideIcon } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { NodeHealth, VmSummary } from '@prox4u/shared';
import { overcommitTone, usageSeverity } from '@prox4u/shared';
import { useDashboard } from '../../../core/data/dashboard';
import { useEndpoint, useOvercommitConfig } from '../../../core/data/use-endpoint';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Progress } from '../../../components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { MetricsPanel } from '../components/metrics-panel';
import { formatBytes, formatUptime } from '../../../lib/utils';

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

function VmRow({ vm }: { vm: VmSummary }) {
  const { t } = useTranslation();
  const running = vm.status === 'running';
  return (
    <TableRow className={!running ? 'opacity-60' : ''}>
      <TableCell className="text-muted-foreground">{vm.vmid}</TableCell>
      <TableCell className="font-medium">{vm.name}</TableCell>
      <TableCell>{vm.type === 'lxc' ? 'LXC' : 'KVM'}</TableCell>
      <TableCell>
        <Badge tone={running ? 'ok' : 'default'}>{running ? t('kpi.running') : t('kpi.stopped')}</Badge>
      </TableCell>
      <TableCell className="text-right">{running ? `${vm.cpuPct.toFixed(0)} %` : '—'}</TableCell>
      <TableCell className="text-right">
        {running && vm.maxmemBytes ? `${formatBytes(vm.memBytes)} / ${formatBytes(vm.maxmemBytes)}` : '—'}
      </TableCell>
    </TableRow>
  );
}

export function NodePage() {
  const { t } = useTranslation();
  const { endpointId, nodeId } = useParams<{ endpointId: string; nodeId: string }>();
  const ep = useEndpoint(endpointId);
  const config = useOvercommitConfig();
  const multiLoaded = useDashboard((s) => s.multi !== null);

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

  const node: NodeHealth | undefined = snapshot.nodes.find((n) => n.node === nodeId);
  if (!node) return <Navigate to={`/e/${encodeURIComponent(ep.id)}`} replace />;

  const vms = snapshot.vms.filter((v) => v.node === node.node);
  const runningCount = vms.filter((v) => v.status === 'running').length;
  const usedCores = node.cpus ? (node.cpuPct / 100) * node.cpus : null;
  // Ratios de surallocation du nœud (RAM : avec provision hôte, idem dashboard)
  const cpuRatio = node.cpus ? node.cpuAllocCores / node.cpus : null;
  const ramRatio = node.memTotalBytes
    ? (node.ramAllocBytes + (config.hostRamProvisionPct / 100) * node.memTotalBytes) / node.memTotalBytes
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to={`/e/${encodeURIComponent(ep.id)}`}
          className="flex h-8 w-8 items-center justify-center rounded-lg border bg-card text-muted-foreground transition-colors hover:text-foreground"
          title={ep.name}
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="text-xl font-semibold tracking-tight">{node.node}</div>
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

      {!ep.ok && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('endpoint.stale', { error: ep.error ?? '' })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
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

      <MetricsPanel endpointId={ep.id} node={node.node} />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>{t('node.vms.title')}</CardTitle>
          {vms.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('node.vms.running', { n: runningCount, total: vms.length })}
            </span>
          )}
        </CardHeader>
        <CardContent className="overflow-y-auto">
          {vms.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">{t('node.vms.none')}</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>{t('node.vms.col.vm')}</TableHead>
                    <TableHead>{t('node.vms.col.type')}</TableHead>
                    <TableHead>{t('common.state')}</TableHead>
                    <TableHead className="text-right">{t('metrics.cpu')}</TableHead>
                    <TableHead className="text-right">{t('metrics.ram')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vms.map((vm) => (
                    <VmRow key={vm.vmid} vm={vm} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
