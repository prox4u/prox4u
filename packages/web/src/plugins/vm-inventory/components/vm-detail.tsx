import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { VmDetailResponse } from '@prox4u/shared';
import { fetchVmDetail } from '../../../core/api/apiClient';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';
import { cn, formatBytes, formatUptime } from '../../../lib/utils';

interface Props {
  endpointId: string;
  vmid: number;
  onClose: () => void;
}

type Tab = 'config' | 'network' | 'snapshots';

const STATUS_TONE = { running: 'ok', paused: 'warn', stopped: 'default', unknown: 'default' } as const;

/** Barre d'utilisation (utilisé / alloué) avec code couleur >80 % warn, >90 % crit. */
function UsageBar({ used, max }: { used: number; max: number | null }) {
  if (max == null || max <= 0) return <div className="h-1.5 w-full rounded-full bg-secondary" />;
  const pct = Math.min(100, (used / max) * 100);
  return (
    <div className="h-1.5 w-full rounded-full bg-secondary">
      <div
        className={cn('h-1.5 rounded-full', pct >= 90 ? 'bg-crit' : pct >= 80 ? 'bg-warn' : 'bg-primary')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * Panneau détail d'une VM : état live (snapshot) + config (cache 1 h) + snapshots (cache 5 min),
 * servis par GET /api/vm-config. Onglets Configuration / Réseau / Snapshots.
 */
export function VmDetail({ endpointId, vmid, onClose }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<VmDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('config');

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    fetchVmDetail(endpointId, vmid)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [endpointId, vmid]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'config', label: t('vm.tab.config') },
    { id: 'network', label: t('vm.tab.network') },
    { id: 'snapshots', label: t('vm.tab.snapshots') },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{data?.vm.name ?? `VM ${vmid}`}</div>
          <div className="text-[11px] tabular-nums text-muted-foreground">#{vmid}</div>
        </div>
        {data && (
          <Badge tone={STATUS_TONE[data.vm.status]}>
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                data.vm.status === 'running' ? 'bg-ok' : data.vm.status === 'paused' ? 'bg-warn' : 'bg-muted-foreground/50',
              )}
            />
            {t(`vm.status.${data.vm.status}`)}
          </Badge>
        )}
        <button onClick={onClose} aria-label="close" className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

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

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <div className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-xs text-crit">{t('vm.detail.error', { error })}</div>
        ) : !data ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <>
            {tab === 'config' && (
              <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.node')}</dt>
                    <dd className="font-medium">{data.vm.node}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.os')}</dt>
                    <dd className="font-medium">{data.vm.os ?? data.config?.os ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.pool')}</dt>
                    <dd className="font-medium">{data.config?.pool ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.diskStorage')}</dt>
                    <dd className="font-medium">{data.config?.diskStorage ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.uptime')}</dt>
                    <dd className="font-medium tabular-nums">{formatUptime(data.vm.uptimeSec)}</dd>
                  </div>
                </dl>

                <div className="space-y-1">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">{t('vm.cfg.cpu')}</span>
                    <span className="font-medium tabular-nums">
                      {t('vm.cfg.cores', { n: data.vm.cpuAllocCores || data.config?.cpuAlloc || 0 })} · {data.vm.cpuPct.toFixed(1)} %
                    </span>
                  </div>
                  <UsageBar used={data.vm.cpuPct} max={100} />
                </div>

                <div className="space-y-1">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">{t('vm.cfg.mem')}</span>
                    <span className="font-medium tabular-nums">
                      {formatBytes(data.vm.memBytes)} / {data.vm.maxmemBytes != null ? formatBytes(data.vm.maxmemBytes) : '—'}
                    </span>
                  </div>
                  <UsageBar used={data.vm.memBytes} max={data.vm.maxmemBytes} />
                </div>

                <div className="space-y-1">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">{t('vm.cfg.disk')}</span>
                    <span className="font-medium tabular-nums">
                      {data.vm.diskBytes != null ? formatBytes(data.vm.diskBytes) : '—'} / {data.vm.maxdiskBytes != null ? formatBytes(data.vm.maxdiskBytes) : '—'}
                    </span>
                  </div>
                  <UsageBar used={data.vm.diskBytes ?? 0} max={data.vm.maxdiskBytes} />
                </div>
              </div>
            )}

            {tab === 'network' && (
              <div className="space-y-1.5">
                {(data.config?.nets.length ?? 0) === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">{t('vm.net.none')}</div>
                ) : (
                  data.config!.nets.map((n) => (
                    <div key={n.iface} className="rounded-lg border px-2.5 py-2 text-xs">
                      <div className="flex items-center justify-between font-medium">
                        {n.iface}
                        <span className="text-muted-foreground">{n.bridge}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums text-muted-foreground">
                        <span>{t('vm.net.mac')} : {n.mac ?? '—'}</span>
                        <span>{t('vm.net.vlan')} : {n.tag ?? 0}</span>
                        <span>{t('vm.net.ip')} : {n.ip ?? '—'}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {tab === 'snapshots' && (
              <div className="space-y-1.5">
                {data.snapshots.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">{t('vm.snap.none')}</div>
                ) : (
                  data.snapshots.map((s) => (
                    <div key={s.name} className="rounded-lg border px-2.5 py-2 text-xs">
                      <div className="flex items-center justify-between font-medium">
                        {s.name}
                        <span className="tabular-nums text-muted-foreground">
                          {s.time != null ? new Date(s.time * 1000).toLocaleDateString() : '—'}
                        </span>
                      </div>
                      <div className="mt-0.5 flex gap-4 text-muted-foreground">
                        <span>
                          {t('vm.snap.memory')} : {s.memory ? t('vm.snap.yes') : t('vm.snap.no')}
                        </span>
                        {s.note && <span>{s.note}</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
