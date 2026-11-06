import { useTranslation } from 'react-i18next';
import { Cpu, HardDrive, Server, Boxes } from 'lucide-react';
import type { KpiSummary, OvercommitConfig } from '@prox4u/shared';
import { usageSeverity } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { formatBytes, formatPct } from '../../../lib/utils';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import type { SparkPoint } from '../../../core/data/dashboard';

function tone(pct: number, config: OvercommitConfig): 'ok' | 'warn' | 'crit' {
  return usageSeverity(pct, config);
}

const TONE_HEX: Record<string, string> = { ok: '#34d399', warn: '#fbbf24', crit: '#f87171', default: '#818cf8' };

/** Sparkline SVG légère (pas d'ECharts pour 60 points). */
export function Sparkline({ values, color, height = 36 }: { values: number[]; color: string; height?: number }) {
  if (values.length < 2) return <div style={{ height }} />;
  const w = 100;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${height} ${pts.join(' ')} ${w},${height}`;
  const id = `sg-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface KpiProps {
  kpis: KpiSummary;
  spark: SparkPoint[];
}

export function KpiNodesCard({ kpis }: KpiProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Server className="h-3.5 w-3.5" /> {t('kpi.nodes')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col justify-between">
        <div className="text-2xl font-bold tabular-nums">
          {kpis.nodes.online}
          <span className="text-sm font-normal text-muted-foreground"> / {kpis.nodes.total}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function KpiCpuRamCard({ kpis, spark }: KpiProps) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const cpuTone = tone(kpis.cpuPct, config);
  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Cpu className="h-3.5 w-3.5" /> {t('kpi.cpuRam')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col justify-between gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums" style={{ color: TONE_HEX[cpuTone] }}>
            {formatPct(kpis.cpuPct, 0)}
          </span>
          <span className="truncate text-xs text-muted-foreground tabular-nums">
            RAM {formatPct(kpis.ramPct, 0)} · {formatBytes(kpis.ramUsedBytes)}/{formatBytes(kpis.ramTotalBytes)}
          </span>
        </div>
        <Sparkline values={spark.map((p) => p.ramPct)} color={TONE_HEX[tone(kpis.ramPct, config)]} />
      </CardContent>
    </Card>
  );
}

export function KpiStorageCard({ kpis, spark }: KpiProps) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const storageFree = Math.max(0, kpis.storageTotalBytes - kpis.storageUsedBytes);
  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <HardDrive className="h-3.5 w-3.5" /> {t('kpi.storage')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col justify-between">
        <div className="text-2xl font-bold tabular-nums" style={{ color: TONE_HEX[tone(kpis.storagePct, config)] }}>
          {formatPct(kpis.storagePct, 0)}
        </div>
        <div className="mb-1 truncate text-[11px] text-muted-foreground">
          {t('kpi.storageLeft', { size: formatBytes(storageFree) })}
          {' · '}
          {kpis.storageDaysToFull !== null ? t('kpi.storageDays', { days: kpis.storageDaysToFull }) : t('kpi.storageStable')}
        </div>
        <Sparkline values={spark.map((p) => p.storagePct)} color={TONE_HEX[tone(kpis.storagePct, config)]} />
      </CardContent>
    </Card>
  );
}

export function KpiVmsCard({ kpis, spark }: KpiProps) {
  const { t } = useTranslation();
  // Compteur « agents PVE inactifs » (VMs QEMU en cours sans QGA) — critique si > 0.
  const agentDown = kpis.vmsAgentDown ?? 0;
  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Boxes className="h-3.5 w-3.5" /> {t('kpi.vms')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col justify-between">
        <div className="text-2xl font-bold tabular-nums">
          {kpis.vmsRunning}
          <span className="text-sm font-normal text-muted-foreground"> / {kpis.vmsTotal}</span>
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{kpis.vmsStopped} {t('kpi.stopped')}</span>
        </div>
        <div className={agentDown > 0 ? 'mb-1 truncate text-[11px] font-semibold text-crit' : 'mb-1 truncate text-[11px] text-muted-foreground'}>
          {agentDown > 0
            ? t('kpi.vmAgentDown', { n: agentDown })
            : t('kpi.vmAgentOk')}
        </div>
        <Sparkline values={spark.map((p) => p.vmsRunning)} color={TONE_HEX.default} />
      </CardContent>
    </Card>
  );
}
