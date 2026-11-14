import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Container, MonitorSmartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { VmDetailResponse } from '@prox4u/shared';
import { matchAgentNetsByMac } from '@prox4u/shared';
import { fetchVmDetail } from '../../../core/api/apiClient';
import { VmMonitor } from './vm-monitor';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';
import { cn, formatBytes, formatUptime } from '../../../lib/utils';

interface Props {
  endpointId: string;
  /** Nom affiché de l'endpoint (« Géré par » / « Cluster » des objets liés). */
  endpointName: string;
  vmid: number;
  /** URL API PVE de l'endpoint (https://host:8006) — requis pour la console web. */
  endpointUrl?: string;
  /** Horodatage (ms) du dernier snapshot live — « Dernière mise à jour » du panneau Utilisation. */
  lastUpdated?: number;
  onClose: () => void;
}

type Tab = 'summary' | 'monitor' | 'config' | 'network' | 'snapshots';

const STATUS_TONE = { running: 'ok', paused: 'warn', stopped: 'default', unknown: 'default' } as const;

/** Pastille d'état (running/paused/arrêté). */
function StatusDot({ status }: { status: VmDetailResponse['vm']['status'] }) {
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'running' ? 'bg-ok' : status === 'paused' ? 'bg-warn' : 'bg-muted-foreground/50',
      )}
    />
  );
}

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

/** Panneau de la vue Résumé (style vSphere : titre + lignes libellé/valeur). */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <h3 className="border-b px-3 py-2 text-xs font-semibold">{title}</h3>
      <div className="space-y-1.5 px-3 py-2.5">{children}</div>
    </section>
  );
}

/** Ligne libellé (gauche, atténué) / valeur (droite). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
    </div>
  );
}

/**
 * Page détail d'une VM — approche vCenter (v2) : en-tête (nom, état, console web),
 * onglets Résumé / Configuration / Réseau / Snapshots. Le Résumé est une grille de
 * panneaux type vSphere (OS invité, Détails VM, Matériel, Utilisation, Objets liés…).
 * Données : live (snapshot 5 s) + config (cache 1 h) + snapshots (cache 5 min).
 */
export function VmDetail({ endpointId, endpointName, vmid, endpointUrl, lastUpdated, onClose }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<VmDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('summary');

  // Console web : lien vers la console de la VM dans l'UI PVE (nouvel onglet).
  // Absent en mode démo (endpoint sans URL) → bouton désactivé.
  const consoleUrl =
    endpointUrl && data ? `${endpointUrl}/#next;nodes/${data.vm.node}/${data.vm.type}/${vmid}/console` : null;

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
    { id: 'summary', label: t('vm.tab.summary') },
    { id: 'monitor', label: t('vm.tab.monitor') },
    { id: 'config', label: t('vm.tab.config') },
    { id: 'network', label: t('vm.tab.network') },
    { id: 'snapshots', label: t('vm.tab.snapshots') },
  ];

  const vm = data?.vm;
  const config = data?.config ?? null;
  const isLxc = vm?.type === 'lxc';
  const VmIcon = isLxc ? Container : MonitorSmartphone;
  const cores = vm?.cpuAllocCores || config?.cpuAlloc || 0;
  // Interfaces guest agent (QEMU) jointes à la config PVE par MAC — iface → IPs.
  const agentIps = matchAgentNetsByMac(config?.nets ?? [], data?.agentNets ?? []);
  // IP : par interface (guest agent + config LXC) si connue, sinon IPs live détectées par PVE.
  const perIfaceIps = [...agentIps.values()].flat();
  const cfgIps = (config?.nets ?? []).filter((n) => n.ip).map((n) => n.ip!);
  const ips =
    perIfaceIps.length > 0 || cfgIps.length > 0
      ? [...new Set([...perIfaceIps, ...cfgIps])]
      : (vm?.ipAddresses ?? []);
  const bridges = (config?.nets ?? []).map((n) => n.bridge);

  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card">
      {/* En-tête : retour, icône, nom, état, actions (console web). */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <button
          onClick={onClose}
          title={t('vm.back')}
          aria-label={t('vm.back')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <VmIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{vm?.name ?? `VM ${vmid}`}</div>
          <div className="text-[11px] tabular-nums text-muted-foreground">
            #{vmid} · {endpointName} / {vm?.node ?? '—'}
          </div>
        </div>
        {data && (
          <Badge tone={STATUS_TONE[data.vm.status]}>
            <StatusDot status={data.vm.status} />
            {t(`vm.status.${data.vm.status}`)}
          </Badge>
        )}
        <button
          onClick={() => consoleUrl && window.open(consoleUrl, '_blank', 'noopener,noreferrer')}
          disabled={!consoleUrl}
          title={consoleUrl ? t('vm.console.web') : t('vm.console.unavailable')}
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          <MonitorSmartphone className="h-3.5 w-3.5" />
          {t('vm.console.web')}
        </button>
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
        {error ? (
          <div className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-xs text-crit">{t('vm.detail.error', { error })}</div>
        ) : !data || !vm ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <>
            {tab === 'summary' && (
              <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {/* OS invité */}
                <Panel title={t('vm.sum.guestOs')}>
                  <Row label={t('vm.sum.os')}>{vm.os ?? config?.os ?? '—'}</Row>
                  <Row label={t('vm.sum.type')}>{isLxc ? t('vm.type.lxc') : t('vm.type.qemu')}</Row>
                </Panel>

                {/* Détails de la machine virtuelle */}
                <Panel title={t('vm.sum.vmDetails')}>
                  <Row label={t('vm.sum.powerStatus')}>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot status={vm.status} />
                      {t(`vm.status.${vm.status}`)}
                    </span>
                  </Row>
                  <Row label={t('vm.sum.managedBy')}>{endpointName}</Row>
                  <Row label={t('vm.sum.dnsName')}>{vm.name}</Row>
                  <Row label={t('vm.sum.ipAddresses')}>{ips.length > 0 ? ips.join(', ') : '—'}</Row>
                  <Row label={t('vm.sum.encryption')}>{t('vm.sum.notEncrypted')}</Row>
                </Panel>

                {/* Matériel VM */}
                <Panel title={t('vm.sum.hardware')}>
                  <Row label={t('vm.sum.cpu')}>{t('vm.cfg.cores', { n: cores })}</Row>
                  <Row label={t('vm.sum.memory')}>
                    {formatBytes(vm.maxmemBytes ?? vm.memBytes)}
                  </Row>
                  <Row label={t('vm.sum.hardDisk')}>
                    {config?.diskStorage
                      ? `${config.diskStorage}${vm.maxdiskBytes != null ? ` · ${formatBytes(vm.maxdiskBytes)}` : ''}`
                      : '—'}
                  </Row>
                  <Row label={t('vm.sum.netAdapter')}>
                    {bridges.length > 0 ? (
                      <>
                        {bridges[0]}{' '}
                        <span className="text-muted-foreground">
                          ({vm.status === 'running' ? t('vm.sum.connected') : t('vm.sum.disconnected')})
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </Row>
                  <Row label={t('vm.sum.compatibility')}>{isLxc ? 'LXC' : 'QEMU'}</Row>
                </Panel>

                {/* Interfaces réseau (pont + VLAN + MAC par interface, IP si connue — guest agent ou config LXC) */}
                <Panel title={t('vm.sum.interfaces')}>
                  {(config?.nets.length ?? 0) === 0 ? (
                    <Row label="—">{t('vm.net.none')}</Row>
                  ) : (
                    config!.nets.map((n) => {
                      const aips = agentIps.get(n.iface);
                      // IP : config statique → guest agent → mode déclaré (LXC manual/dhcp) — PVE ne voit pas l'IP réelle.
                      const ip = n.ip ?? (aips && aips.length > 0 ? aips.join(', ') : n.ipMode ? t(`common.ip.${n.ipMode}`) : null);
                      return (
                        <Row key={n.iface} label={n.iface}>
                          {n.bridge}
                          {n.tag != null ? ` (VLAN ${n.tag})` : ''}
                          {n.mac ? ` · ${n.mac}` : ''}
                          {ip ? ` · ${ip}` : ''}
                        </Row>
                      );
                    })
                  )}
                </Panel>

                {/* Utilisation */}
                <Panel title={t('vm.sum.usage')}>
                  <div className="text-[11px] text-muted-foreground">
                    {t('vm.sum.lastUpdated')} : {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '—'}
                  </div>
                  <div className="space-y-1 pt-1">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">{t('vm.sum.cpu')}</span>
                      <span className="font-medium tabular-nums">{vm.cpuPct.toFixed(1)} %</span>
                    </div>
                    <UsageBar used={vm.cpuPct} max={100} />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">{t('vm.sum.memory')}</span>
                      <span className="font-medium tabular-nums">
                        {formatBytes(vm.memBytes)} / {vm.maxmemBytes != null ? formatBytes(vm.maxmemBytes) : '—'}
                      </span>
                    </div>
                    <UsageBar used={vm.memBytes} max={vm.maxmemBytes} />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">{t('vm.sum.storage')}</span>
                      <span className="font-medium tabular-nums">
                        {vm.diskBytes != null ? formatBytes(vm.diskBytes) : '—'} / {vm.maxdiskBytes != null ? formatBytes(vm.maxdiskBytes) : '—'}
                      </span>
                    </div>
                    <UsageBar used={vm.diskBytes ?? 0} max={vm.maxdiskBytes} />
                  </div>
                </Panel>

                {/* Objets liés */}
                <Panel title={t('vm.sum.related')}>
                  <Row label={t('vm.sum.cluster')}>
                    <Link to={`/e/${endpointId}`} className="text-primary hover:underline">
                      {endpointName}
                    </Link>
                  </Row>
                  <Row label={t('vm.sum.host')}>
                    <Link to={`/e/${endpointId}/n/${encodeURIComponent(vm.node)}`} className="text-primary hover:underline">
                      {vm.node}
                    </Link>
                  </Row>
                  <Row label={t('vm.sum.networks')}>{bridges.length > 0 ? bridges.join(', ') : '—'}</Row>
                  <Row label={t('vm.sum.storage')}>{config?.diskStorage ?? '—'}</Row>
                </Panel>

                {/* Détails VM */}
                <Panel title={t('vm.sum.vmInfo')}>
                  <Row label={t('vm.sum.pool')}>{config?.pool ?? '—'}</Row>
                  <Row label={t('vm.sum.vmClass')}>{isLxc ? t('vm.type.lxc') : t('vm.type.qemu')}</Row>
                  <Row label={t('vm.sum.vmId')}>#{vmid}</Row>
                  <Row label={t('vm.sum.uptime')}>{formatUptime(vm.uptimeSec)}</Row>
                </Panel>
              </dl>
            )}

            {/* Monitor : lazy — le composant n'est monté que quand l'onglet est ouvert. */}
            {tab === 'monitor' && (
              <VmMonitor endpointId={endpointId} vmid={vmid} vmName={vm.name} maxmemBytes={vm.maxmemBytes} maxdiskBytes={vm.maxdiskBytes} />
            )}

            {tab === 'config' && (
              <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.node')}</dt>
                    <dd className="font-medium">{vm.node}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.os')}</dt>
                    <dd className="font-medium">{vm.os ?? config?.os ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.pool')}</dt>
                    <dd className="font-medium">{config?.pool ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.diskStorage')}</dt>
                    <dd className="font-medium">{config?.diskStorage ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vm.cfg.uptime')}</dt>
                    <dd className="font-medium tabular-nums">{formatUptime(vm.uptimeSec)}</dd>
                  </div>
                </dl>

                <div className="space-y-1">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">{t('vm.cfg.cpu')}</span>
                    <span className="font-medium tabular-nums">
                      {t('vm.cfg.cores', { n: cores })} · {vm.cpuPct.toFixed(1)} %
                    </span>
                  </div>
                  <UsageBar used={vm.cpuPct} max={100} />
                </div>

                <div className="space-y-1">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">{t('vm.cfg.mem')}</span>
                    <span className="font-medium tabular-nums">
                      {formatBytes(vm.memBytes)} / {vm.maxmemBytes != null ? formatBytes(vm.maxmemBytes) : '—'}
                    </span>
                  </div>
                  <UsageBar used={vm.memBytes} max={vm.maxmemBytes} />
                </div>

                <div className="space-y-1">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">{t('vm.cfg.disk')}</span>
                    <span className="font-medium tabular-nums">
                      {vm.diskBytes != null ? formatBytes(vm.diskBytes) : '—'} / {vm.maxdiskBytes != null ? formatBytes(vm.maxdiskBytes) : '—'}
                    </span>
                  </div>
                  <UsageBar used={vm.diskBytes ?? 0} max={vm.maxdiskBytes} />
                </div>
              </div>
            )}

            {tab === 'network' && (
              <div className="space-y-1.5">
                {/* IPs live détectées par PVE (/cluster/resources) — liste plate, en complément
                    des IPs par interface fournies par le guest agent (jointure par MAC). */}
                {vm.ipAddresses.length > 0 && (
                  <div className="rounded-lg border px-2.5 py-2 text-xs">
                    <span className="text-muted-foreground">{t('vm.net.liveIps')} : </span>
                    <span className="font-medium tabular-nums">{vm.ipAddresses.join(', ')}</span>
                  </div>
                )}
                {(config?.nets.length ?? 0) === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">{t('vm.net.none')}</div>
                ) : (
                  config!.nets.map((n) => {
                    const aips = agentIps.get(n.iface);
                    // IP : config statique → guest agent → mode déclaré (LXC manual/dhcp) — PVE ne voit pas l'IP réelle.
                    const ip = n.ip ?? (aips && aips.length > 0 ? aips.join(', ') : n.ipMode ? t(`common.ip.${n.ipMode}`) : null);
                    return (
                      <div key={n.iface} className="rounded-lg border px-2.5 py-2 text-xs">
                        <div className="flex items-center justify-between font-medium">
                          {n.iface}
                          <span className="text-muted-foreground">{n.bridge}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums text-muted-foreground">
                          <span>{t('vm.net.mac')} : {n.mac ?? '—'}</span>
                          <span>{t('vm.net.vlan')} : {n.tag ?? 0}</span>
                          <span>{t('vm.net.ip')} : {ip ?? '—'}</span>
                        </div>
                      </div>
                    );
                  })
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
