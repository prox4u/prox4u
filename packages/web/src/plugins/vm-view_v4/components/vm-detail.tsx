import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Container, MonitorSmartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { VmDetailResponse, WidgetItem } from '@prox4u/shared';
import { addWidget, matchAgentNetsByMac, mergePageConfig, removeWidget } from '@prox4u/shared';
import { fetchCapacity, fetchVmDetail } from '../../../core/api/apiClient';
import type { CapacityResponse } from '../../../core/api/types';
import { CapacityChartBody } from '../../hypervision_v4/components/capacity-chart';
import { VmMonitor } from './vm-monitor';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';
import { cn, formatBytes, formatUptime } from '../../../lib/utils';
import { useUserConfig } from '../../../store/user-config';
import type { CoreWidgetDef } from '../../../core/widgets/types';
import { layoutsEqual } from '../../../core/widgets/types';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';

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

// Cache module de la capacity planning par endpoint (TTL 5 min) — la capacity est au
// niveau CLUSTER (identique pour toutes les VMs de l'endpoint) → pas de re-fetch en
// changeant de VM. Donnée secondaire : un échec ne casse pas le panneau.
const CAPACITY_TTL_MS = 5 * 60 * 1000;
const capacityCache = new Map<string, { at: number; value: CapacityResponse }>();

/** Capacity planning du cluster (endpoint) — pour la section « Capacité du cluster » du Résumé. */
function useClusterCapacity(endpointId: string): CapacityResponse | null {
  const [capacity, setCapacity] = useState<CapacityResponse | null>(null);
  useEffect(() => {
    const cached = capacityCache.get(endpointId);
    if (cached && Date.now() - cached.at < CAPACITY_TTL_MS) {
      setCapacity(cached.value);
      return;
    }
    let alive = true;
    setCapacity(null); // endpointId changé → reset pendant le fetch
    fetchCapacity(endpointId)
      .then((c) => {
        capacityCache.set(endpointId, { at: Date.now(), value: c });
        if (alive) setCapacity(c);
      })
      .catch((e) => console.warn('chargement capacity (détail VM) en échec', e));
    return () => {
      alive = false;
    };
  }, [endpointId]);
  return capacity;
}

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

/**
 * Corps d'un panneau Résumé dans la grille personnalisable — le frame de widget
 * (WidgetFrame) fournit la carte + le titre + le handle de drag + le bouton
 * « retirer ». `<dl>` pour la validité des `<dt>`/`<dd>` de `Row` (les panneaux
 * sans `Row` — Utilisation — restent valides : un `<dl>` peut contenir des `<div>`).
 */
function PanelBody({ children }: { children: ReactNode }) {
  return <dl className="space-y-1.5 p-3">{children}</dl>;
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
  // Capacity planning du cluster (endpoint) — section « Capacité du cluster » du Résumé.
  const capacity = useClusterCapacity(endpointId);

  // Personnalisation de la grille Résumé par utilisateur : scope = « endpoint/vmid »
  // (vmid stable au renommage — le nom n'entre jamais dans la clé). Persistance
  // /api/user-config (serveur = source de vérité, suit le compte → survit à la reconnexion).
  const scope = `${endpointId}/${vmid}`;
  const stored = useUserConfig((s) => s.config?.pages.vmSummary?.[scope] ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

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

  // Catalogue des widgets du Résumé — 7 panneaux vSphere + 3 graphiques capacité
  // (par élément). Les corps capturent les valeurs dérivées (vm, config, …) — le
  // catalogue est reconstruit quand elles changent (data chargée). Les ids sont
  // STATIQUES (pas de widgets dynamiques) → la clé du catalogue est stable.
  const catalog = useMemo<CoreWidgetDef[]>(() => {
    const defs: CoreWidgetDef[] = [];
    defs.push(
      {
        id: 'vm-os',
        title: t('vm.sum.guestOs'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        render: () => (
          <PanelBody>
            <Row label={t('vm.sum.os')}>{vm?.os ?? config?.os ?? '—'}</Row>
            <Row label={t('vm.sum.type')}>{isLxc ? t('vm.type.lxc') : t('vm.type.qemu')}</Row>
          </PanelBody>
        ),
      },
      {
        id: 'vm-details',
        title: t('vm.sum.vmDetails'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        render: () => (
          <PanelBody>
            <Row label={t('vm.sum.powerStatus')}>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={vm?.status ?? 'unknown'} />
                {vm ? t(`vm.status.${vm.status}`) : '—'}
              </span>
            </Row>
            <Row label={t('vm.sum.managedBy')}>{endpointName}</Row>
            <Row label={t('vm.sum.dnsName')}>{vm?.name ?? '—'}</Row>
            <Row label={t('vm.sum.ipAddresses')}>{ips.length > 0 ? ips.join(', ') : '—'}</Row>
            <Row label={t('vm.sum.encryption')}>{t('vm.sum.notEncrypted')}</Row>
          </PanelBody>
        ),
      },
      {
        id: 'vm-hardware',
        title: t('vm.sum.hardware'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        render: () => (
          <PanelBody>
            <Row label={t('vm.sum.cpu')}>{t('vm.cfg.cores', { n: cores })}</Row>
            <Row label={t('vm.sum.memory')}>{vm ? formatBytes(vm.maxmemBytes ?? vm.memBytes) : '—'}</Row>
            <Row label={t('vm.sum.hardDisk')}>
              {config?.diskStorage
                ? `${config.diskStorage}${vm?.maxdiskBytes != null ? ` · ${formatBytes(vm.maxdiskBytes)}` : ''}`
                : '—'}
            </Row>
            <Row label={t('vm.sum.netAdapter')}>
              {bridges.length > 0 ? (
                <>
                  {bridges[0]}{' '}
                  <span className="text-muted-foreground">
                    {vm?.status === 'running' ? t('vm.sum.connected') : t('vm.sum.disconnected')}
                  </span>
                </>
              ) : (
                '—'
              )}
            </Row>
            <Row label={t('vm.sum.compatibility')}>{isLxc ? 'LXC' : 'QEMU'}</Row>
          </PanelBody>
        ),
      },
      {
        id: 'vm-interfaces',
        title: t('vm.sum.interfaces'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        render: () => (
          <PanelBody>
            {(config?.nets.length ?? 0) === 0 ? (
              <Row label="—">{t('vm.net.none')}</Row>
            ) : (
              config!.nets.map((n) => {
                const aips = agentIps.get(n.iface);
                const ip =
                  n.ip ?? (aips && aips.length > 0 ? aips.join(', ') : n.ipMode ? t(`common.ip.${n.ipMode}`) : null);
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
          </PanelBody>
        ),
      },
      {
        id: 'vm-usage',
        title: t('vm.sum.usage'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        render: () => (
          <PanelBody>
            <div className="text-[11px] text-muted-foreground">
              {t('vm.sum.lastUpdated')} : {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '—'}
            </div>
            <div className="space-y-1 pt-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{t('vm.sum.cpu')}</span>
                <span className="font-medium tabular-nums">{vm ? `${vm.cpuPct.toFixed(1)} %` : '—'}</span>
              </div>
              <UsageBar used={vm?.cpuPct ?? 0} max={100} />
            </div>
            <div className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{t('vm.sum.memory')}</span>
                <span className="font-medium tabular-nums">
                  {vm ? formatBytes(vm.memBytes) : '—'} / {vm?.maxmemBytes != null ? formatBytes(vm.maxmemBytes) : '—'}
                </span>
              </div>
              <UsageBar used={vm?.memBytes ?? 0} max={vm?.maxmemBytes ?? null} />
            </div>
            <div className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{t('vm.sum.storage')}</span>
                <span className="font-medium tabular-nums">
                  {vm?.diskBytes != null ? formatBytes(vm.diskBytes) : '—'} /{' '}
                  {vm?.maxdiskBytes != null ? formatBytes(vm.maxdiskBytes) : '—'}
                </span>
              </div>
              <UsageBar used={vm?.diskBytes ?? 0} max={vm?.maxdiskBytes ?? null} />
            </div>
          </PanelBody>
        ),
      },
      {
        id: 'vm-related',
        title: t('vm.sum.related'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        render: () => (
          <PanelBody>
            <Row label={t('vm.sum.cluster')}>
              <Link to={`/e/${endpointId}`} className="text-primary hover:underline">
                {endpointName}
              </Link>
            </Row>
            <Row label={t('vm.sum.host')}>
              <Link to={`/e/${endpointId}/n/${encodeURIComponent(vm?.node ?? '')}`} className="text-primary hover:underline">
                {vm?.node ?? '—'}
              </Link>
            </Row>
            <Row label={t('vm.sum.networks')}>{bridges.length > 0 ? bridges.join(', ') : '—'}</Row>
            <Row label={t('vm.sum.storage')}>{config?.diskStorage ?? '—'}</Row>
          </PanelBody>
        ),
      },
      {
        id: 'vm-info',
        title: t('vm.sum.vmInfo'),
        default: { w: 4, h: 3 },
        minW: 3,
        minH: 2,
        render: () => (
          <PanelBody>
            <Row label={t('vm.sum.pool')}>{config?.pool ?? '—'}</Row>
            <Row label={t('vm.sum.vmClass')}>{isLxc ? t('vm.type.lxc') : t('vm.type.qemu')}</Row>
            <Row label={t('vm.sum.vmId')}>#{vmid}</Row>
            <Row label={t('vm.sum.uptime')}>{vm ? formatUptime(vm.uptimeSec) : '—'}</Row>
          </PanelBody>
        ),
      },
      {
        id: 'capacity-cpu',
        title: t('capacity.titleCpu'),
        default: { w: 4, h: 4 },
        minW: 3,
        minH: 3,
        render: () => <CapacityChartBody capacity={capacity} metric="cpu" />,
      },
      {
        id: 'capacity-ram',
        title: t('capacity.titleRam'),
        default: { w: 4, h: 4 },
        minW: 3,
        minH: 3,
        render: () => <CapacityChartBody capacity={capacity} metric="ram" />,
      },
      {
        id: 'capacity-disk',
        title: t('capacity.titleDisk'),
        default: { w: 4, h: 4 },
        minW: 3,
        minH: 3,
        render: () => <CapacityChartBody capacity={capacity} metric="disk" />,
      },
    );
    return defs;
  }, [t, vm, config, isLxc, cores, agentIps, ips, bridges, lastUpdated, capacity, endpointId, endpointName, vmid]);

  // Clé du catalogue (ids) — stable (widgets statiques).
  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);

  // Layout par défaut « design validé » : 3 colonnes de panneaux + rangée capacité.
  const defaultLayout = useMemo<WidgetItem[]>(
    () => [
      { widgetId: 'vm-os', x: 0, y: 0, w: 4, h: 3 },
      { widgetId: 'vm-details', x: 4, y: 0, w: 4, h: 3 },
      { widgetId: 'vm-hardware', x: 8, y: 0, w: 4, h: 3 },
      { widgetId: 'vm-interfaces', x: 0, y: 3, w: 4, h: 3 },
      { widgetId: 'vm-usage', x: 4, y: 3, w: 4, h: 3 },
      { widgetId: 'vm-related', x: 8, y: 3, w: 4, h: 3 },
      { widgetId: 'vm-info', x: 0, y: 6, w: 4, h: 3 },
      { widgetId: 'capacity-cpu', x: 0, y: 9, w: 4, h: 4 },
      { widgetId: 'capacity-ram', x: 4, y: 9, w: 4, h: 4 },
      { widgetId: 'capacity-disk', x: 8, y: 9, w: 4, h: 4 },
    ],
    [],
  );

  // FUSION « utilisateurs présents et futurs » : positions stockées priment ;
  // widget nouveau du code → ajouté en fin de grille ; disparu → bibliothèque.
  const merged = useMemo(
    () => mergePageConfig(stored, catalog, defaultLayout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, catalogKey, defaultLayout],
  );

  const onLayoutChange = (layout: WidgetItem[]) => {
    // Garde : RGL rappelle onLayoutChange sur les compactations parent-driven.
    if (layoutsEqual(layout, merged.layout)) return;
    updatePage('vmSummary', scope, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => {
    updatePage('vmSummary', scope, removeWidget(merged, widgetId));
  };
  const onAdd = (widgetId: string) => {
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('vmSummary', scope, addWidget(merged, def));
  };
  const onReset = () => clearPage('vmSummary', scope);

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
              <div className="flex flex-col gap-3">
                {/* Barre d'outils : bibliothèque + réinitialiser + indicateur de sauvegarde. */}
                <div className="flex items-center justify-end">
                  <WidgetToolbar
                    libraryOpen={libraryOpen}
                    onToggleLibrary={() => setLibraryOpen((o) => !o)}
                    onReset={onReset}
                    libraryCount={merged.library.length}
                  />
                </div>
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <WidgetGridLayout
                      catalog={catalog}
                      config={merged}
                      ctx={{ endpointId, vmName: vm.name }}
                      onLayoutChange={onLayoutChange}
                      onRemove={onRemove}
                    />
                  </div>
                  {libraryOpen && (
                    <WidgetLibraryPanel
                      catalog={catalog}
                      config={merged}
                      onAdd={onAdd}
                      onRemove={onRemove}
                      onClose={() => setLibraryOpen(false)}
                    />
                  )}
                </div>
              </div>
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
