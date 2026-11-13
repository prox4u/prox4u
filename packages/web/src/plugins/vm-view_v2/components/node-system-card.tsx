import { useTranslation } from 'react-i18next';
import type { NodeSystemRow } from '@prox4u/shared';
import { formatBytes, formatUptime } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';

/**
 * Monitor nœud (Vue VM v2) — section « Système (nœud) » : état courant du nœud affiché —
 * load 1/5/15 (teinté vs nb de cœurs), iowait, swap, uptime. Source : agent hôte
 * (Telegraf, 10 s) — l'API PVE ne fournit ni iowait ni swap affiché. Pas de donnée
 * (nœud hors ligne / agent inactif) = « — », jamais de valeur inventée.
 * Seuils identiques à la carte cross-nœud (hypervision/system-nodes-card).
 */
type Tone = 'ok' | 'warn' | 'crit';
const TONE_CLS: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit' };

/** load1 / cœurs : ≥ 1 = noyau saturé (warn), ≥ 2 = file importante (crit). */
function loadTone(load1: number, nCpus: number): Tone {
  if (nCpus <= 0) return 'ok';
  const r = load1 / nCpus;
  if (r >= 2) return 'crit';
  if (r >= 1) return 'warn';
  return 'ok';
}
function iowaitTone(p: number | null): Tone {
  if (p == null) return 'ok';
  if (p >= 25) return 'crit';
  if (p >= 10) return 'warn';
  return 'ok';
}
function swapTone(p: number | null): Tone {
  if (p == null) return 'ok';
  if (p >= 80) return 'crit';
  if (p >= 50) return 'warn';
  return 'ok';
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className={`truncate text-lg font-semibold tabular-nums tracking-tight ${tone ? TONE_CLS[tone] : ''}`}>
        {value}
      </div>
      {sub && <div className="truncate text-[11px] tabular-nums text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function NodeSystemCard({ row, loading }: { row: NodeSystemRow | undefined; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle title={t('vm.node.system.hint')}>{t('vm.node.system')}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !row ? (
          <Skeleton className="h-12 w-full" />
        ) : !row ? (
          <div className="px-1 py-2 text-xs text-muted-foreground">{t('overview.system.none')}</div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
            <Stat
              label={t('overview.system.load')}
              tone={loadTone(row.load1, row.nCpus)}
              value={row.load1.toFixed(2)}
              sub={`${row.load5.toFixed(2)} / ${row.load15.toFixed(2)} ${t('node.kpi.loadSub')}`}
            />
            <Stat label={t('overview.system.cores')} value={row.nCpus > 0 ? String(row.nCpus) : '—'} />
            <Stat
              label={t('overview.system.iowait')}
              tone={iowaitTone(row.iowaitPct)}
              value={row.iowaitPct != null ? `${row.iowaitPct.toFixed(1)} %` : '—'}
            />
            <Stat
              label={t('overview.system.swap')}
              tone={swapTone(row.swapPct)}
              value={row.swapPct != null ? `${row.swapPct.toFixed(row.swapPct < 1 ? 2 : 0)} %` : '—'}
              sub={
                row.swapPct != null
                  ? `(${formatBytes(row.swapUsedBytes)} / ${formatBytes(row.swapTotalBytes)})`
                  : undefined
              }
            />
            <Stat label={t('common.uptime')} value={row.uptimeSec > 0 ? formatUptime(row.uptimeSec) : '—'} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
