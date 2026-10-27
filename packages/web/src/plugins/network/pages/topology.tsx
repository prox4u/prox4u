import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw, RotateCcw, Shield, Zap } from 'lucide-react';
import type { ImpactResult, NetworkFailure, NetworkTopology, SitePra, TopologyVm } from '@prox4u/shared';
import { buildNetworkInventory, decodeNetSel, filterNetworkRows, impactAnalysis, segmentKey } from '@prox4u/shared';
import { fetchNetworkTopology } from '../../../core/api/apiClient';
import type { NetworkTopologyResponse } from '../../../core/api/types';
import { TopologyFlow, type TopologyFilter, type TopologySelection } from '../components/topology-flow';
import { NetworkInventory } from '../components/network-inventory';
import { MultiSelect, type MultiGroup } from '../components/multi-select';
import { useMulti } from '../../../core/data/use-endpoint';
import { cn, formatBytes } from '../../../lib/utils';

export function TopologyPage() {
  const { t } = useTranslation();
  const multi = useMulti();
  const [data, setData] = useState<NetworkTopologyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [simSite, setSimSite] = useState<string | null>(null);
  const [sel, setSel] = useState<TopologySelection | null>(null);
  const [filterSel, setFilterSel] = useState<Set<string>>(new Set());
  const [incidentKey, setIncidentKey] = useState<string | null>(null);
  // clé de remontage du graphe → « Réinitialiser le layout » (positions de drag remises à zéro)
  const [layoutKey, setLayoutKey] = useState(0);

  // Vue d'inventaire + recherche + sélection réseau : synchronisées dans l'URL (deep-link partageable).
  // view : 'all' = vue agrégée multi-endpoints · sinon id d'endpoint. q : recherche libre.
  // net : réseau sélectionné dans le déroulé (encodé « vmbr0:10 », natif = « vmbr0:n »).
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') ?? 'all';
  const query = searchParams.get('q') ?? '';
  const netSel = searchParams.get('net') ?? '';
  const setNetSel = (sel: string) =>
    setSearchParams((p) => {
      if (sel) p.set('net', sel);
      else p.delete('net');
      return p;
    }, { replace: true });
  const setView = (v: string) => {
    setSearchParams((p) => {
      if (v === 'all') p.delete('view');
      else p.set('view', v);
      p.delete('net'); // la sélection de réseau est propre à la vue
      return p;
    }, { replace: true });
    setSimSite(null);
    setSel(null);
    setFilterSel(new Set());
    setIncidentKey(null);
  };
  const setQuery = (q: string) =>
    setSearchParams((p) => {
      if (q) p.set('q', q);
      else p.delete('q');
      return p;
    }, { replace: true });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchNetworkTopology());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const topologies = data?.topologies ?? [];
  const topo = view === 'all' ? null : topologies.find((x) => x.endpointId === view) ?? topologies[0] ?? null;

  // Sites + PRA du snapshot courant (pour la simulation N-1).
  const epSnapshot = multi?.endpoints.find((e) => e.id === topo?.endpointId);
  const sites = useMemo(() => epSnapshot?.snapshot?.sites ?? [], [epSnapshot]);
  const failedNodes = useMemo(() => {
    if (!simSite || !topo) return undefined;
    const site = sites.find((s) => s.id === simSite);
    if (!site) return undefined;
    return new Set(site.nodes);
  }, [simSite, topo, sites]);

  const praSite: SitePra | null = useMemo(() => {
    if (!simSite) return null;
    return epSnapshot?.snapshot?.pra.sites.find((s) => s.siteId === simSite) ?? null;
  }, [simSite, epSnapshot]);

  const failoverVms = useMemo(
    () => (topo && failedNodes ? topo.vms.filter((v) => failedNodes.has(v.node)) : []),
    [topo, failedNodes],
  );

  // --- Filtre de vue (VLANs / ponts / NICs) ---------------------------------------
  const filter = useMemo<TopologyFilter | undefined>(() => {
    if (filterSel.size === 0) return undefined;
    const vlans = new Set<number>();
    const bridges = new Set<string>();
    const nics = new Set<string>();
    for (const v of filterSel) {
      const [p, val] = v.split(':');
      if (p === 'v') vlans.add(Number(val));
      else if (p === 'b') bridges.add(val);
      else if (p === 'n') nics.add(val);
    }
    return { vlans, bridges, nics, networks: new Set<string>() };
  }, [filterSel]);

  // --- Recherche unifiée → filtre du graphe ---------------------------------------
  // La recherche libre (inventaire) restreint aussi le graphe : on en déduit les
  // ponts + VLANs des réseaux correspondants. Elle prime sur le filtre multi-sélection.
  const searchGraphFilter = useMemo<TopologyFilter | undefined>(() => {
    if (view === 'all' || !query.trim()) return undefined;
    const t = topologies.find((x) => x.endpointId === view);
    if (!t) return undefined;
    const rows = filterNetworkRows(buildNetworkInventory(t), query);
    const bridges = new Set(rows.map((r) => r.bridge));
    const vlans = new Set(rows.filter((r) => r.vlan !== null).map((r) => r.vlan as number));
    if (bridges.size === 0 && vlans.size === 0) return undefined;
    return { bridges, vlans, nics: new Set<string>(), networks: new Set<string>() };
  }, [view, query, topologies]);

  // --- Sélection de réseau (déroulé) → filtre du graphe ---------------------------
  // Le réseau sélectionné restreint le graphe à ce pont + VLAN. Il prime sur la
  // recherche et le multi-sélection (le plus spécifique gagne).
  const netGraphFilter = useMemo<TopologyFilter | undefined>(() => {
    if (view === 'all') return undefined;
    const net = decodeNetSel(netSel);
    if (!net) return undefined;
    // Segments exacts : une VM est visible si elle a une interface sur (pont, VLAN) précis.
    return {
      bridges: new Set<string>(),
      vlans: new Set<number>(),
      nics: new Set<string>(),
      networks: new Set([segmentKey(net.bridge, net.vlan)]),
    };
  }, [view, netSel]);

  // Noms des endpoints (pour la colonne « Serveur » de la vue agrégée).
  const endpointNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of multi?.endpoints ?? []) m[e.id] = e.name;
    return m;
  }, [multi]);

  const filterGroups = useMemo<MultiGroup[]>(() => {
    if (!topo) return [];
    const groups: MultiGroup[] = [];
    if (topo.vlans.length > 0)
      groups.push({ title: t('topo.filter.vlans'), options: topo.vlans.map((v) => ({ value: `v:${v}`, label: `${t('topo.vlan.label')} ${v}` })) });
    const bridgeNames = [...new Set(topo.nodes.flatMap((n) => n.bridges.map((b) => b.name)))];
    if (bridgeNames.length > 0) groups.push({ title: t('topo.filter.bridges'), options: bridgeNames.map((b) => ({ value: `b:${b}`, label: b })) });
    const nicNames = [...new Set(topo.nodes.flatMap((n) => n.nics.map((x) => x.name)))];
    if (nicNames.length > 0) groups.push({ title: t('topo.filter.nics'), options: nicNames.map((x) => ({ value: `n:${x}`, label: x })) });
    return groups;
  }, [topo, t]);

  // --- Analyse d'impact incident (calculée côté client, instantanée) ---------------
  const incidentOptions = useMemo(() => {
    if (!topo) return [];
    const groups: MultiGroup[] = [];
    const add = (title: string, items: { key: string; label: string }[]) => {
      if (items.length > 0) groups.push({ title, options: items.map((i) => ({ value: i.key, label: i.label })) });
    };
    add(t('topo.incident.switch'), topo.switches.map((s) => ({ key: `sw:${s.id}`, label: s.name })));
    add(t('topo.incident.vlan'), topo.vlans.map((v) => ({ key: `vlan:${v}`, label: `${t('topo.vlan.label')} ${v}` })));
    add(
      t('topo.incident.bridge'),
      topo.nodes.flatMap((n) => n.bridges.map((b) => ({ key: `br:${n.node}:${b.name}`, label: `${n.node} · ${b.name}` }))),
    );
    add(
      t('topo.incident.nic'),
      topo.nodes.flatMap((n) => n.nics.map((x) => ({ key: `nic:${n.node}:${x.name}`, label: `${n.node} · ${x.name}` }))),
    );
    add(t('topo.incident.node'), topo.nodes.map((n) => ({ key: `nd:${n.node}`, label: n.node })));
    return groups;
  }, [topo, t]);

  const incidentMap = useMemo(() => {
    const m = new Map<string, NetworkFailure>();
    if (!topo) return m;
    for (const s of topo.switches) m.set(`sw:${s.id}`, { kind: 'switch', id: s.id });
    for (const v of topo.vlans) m.set(`vlan:${v}`, { kind: 'vlan', vlan: v });
    for (const n of topo.nodes) {
      for (const b of n.bridges) m.set(`br:${n.node}:${b.name}`, { kind: 'bridge', node: n.node, bridge: b.name });
      for (const x of n.nics) m.set(`nic:${n.node}:${x.name}`, { kind: 'nic', node: n.node, nic: x.name });
      m.set(`nd:${n.node}`, { kind: 'node', node: n.node });
    }
    return m;
  }, [topo]);

  const incident = incidentKey ? incidentMap.get(incidentKey) ?? null : null;
  const impact = useMemo(() => (topo && incident ? impactAnalysis(topo, incident) : null), [topo, incident]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{t('topo.title')}</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('topo.hint')}</p>
      </div>

      {loading && !data ? (
        <div className="flex h-[560px] items-center justify-center rounded-xl border text-sm text-muted-foreground">
          {t('topo.loading')}
        </div>
      ) : error && !data ? (
        <div className="flex h-[560px] items-center justify-center rounded-xl border border-crit/40 bg-crit/10 px-4 text-sm text-crit">
          {t('topo.error', { error })}
        </div>
      ) : (
        <>
          {/* Inventaire réseaux → VMs (au-dessus du graphe) : vue · recherche · actualiser · export CSV */}
          <div className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <NetworkInventory
                topologies={topologies}
                endpointNames={endpointNames}
                view={view}
                onViewChange={setView}
                query={query}
                onQueryChange={setQuery}
                netSel={netSel}
                onNetChange={setNetSel}
              />
            </div>
            <button
              onClick={() => void load()}
              className="flex shrink-0 items-center gap-1.5 self-start rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              {t('topo.refresh')}
            </button>
          </div>

          {/* Vue par endpoint : contrôles + graphe (la vue agrégée « Tous » n'a pas de graphe) */}
          {view !== 'all' && topo && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <MultiSelect groups={filterGroups} selected={filterSel} onChange={setFilterSel} placeholder={t('topo.filter.title')} />

                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Zap className="h-3.5 w-3.5" />
                  {t('topo.incident.title')}
                  <select
                    value={incidentKey ?? ''}
                    onChange={(e) => setIncidentKey(e.target.value || null)}
                    className="max-w-[220px] rounded-md border bg-card px-2 py-1.5 text-xs font-medium text-foreground"
                  >
                    <option value="">{t('topo.incident.none')}</option>
                    {incidentOptions.map((g) => (
                      <optgroup key={g.title} label={g.title}>
                        {g.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  {t('topo.sim.title')}
                  <select
                    value={simSite ?? ''}
                    onChange={(e) => {
                      setSimSite(e.target.value || null);
                      setSel(null);
                    }}
                    disabled={sites.length <= 1}
                    className="rounded-md border bg-card px-2 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
                  >
                    <option value="">{t('topo.sim.none')}</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  onClick={() => setLayoutKey((k) => k + 1)}
                  className="ml-auto flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <RotateCcw className="h-3 w-3" />
                  {t('topo.resetLayout')}
                </button>
              </div>

              {/* Bannière de simulation PRA */}
              {simSite && sites.length > 1 && (
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
                    praSite?.severity === 'crit' ? 'border-crit/40 bg-crit/10 text-crit' : 'border-warn/40 bg-warn/10 text-warn',
                  )}
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {praSite?.severity === 'crit'
                    ? t('topo.sim.impossible', { site: sites.find((s) => s.id === simSite)?.name ?? simSite })
                    : praSite && praSite.absorptionPct !== null
                      ? t('topo.sim.banner', {
                          site: sites.find((s) => s.id === simSite)?.name ?? simSite,
                          vms: failoverVms.length,
                          pct: Math.round(praSite.absorptionPct),
                        })
                      : t('topo.sim.na')}
                </div>
              )}

              <TopologyFlow
                key={layoutKey}
                topology={topo}
                failedNodes={failedNodes}
                filter={netGraphFilter ?? searchGraphFilter ?? filter}
                impact={impact}
                selection={sel}
                onSelect={setSel}
              />

              {/* Analyse d'impact incident */}
              {impact && (impact.impactedVms.length > 0 || impact.degradedVms.length > 0) && <ImpactPanel impact={impact} />}

              {/* Légende */}
              <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded border border-indigo-400/60 bg-card" /> {t('topo.legend.switch')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded border bg-card" /> {t('topo.legend.node')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded border bg-secondary" /> {t('topo.legend.bridge')}
                </span>
                {topo.vlans.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded border border-dashed border-primary/50 bg-background" /> {t('topo.legend.segment')}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <Shield className="h-3 w-3 text-primary" /> {t('topo.legend.management')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-ok" /> {t('topo.status.running')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/50" /> {t('topo.status.stopped')}
                </span>
              </div>

              {sel && <DetailPanel topo={topo} sel={sel} onSelect={setSel} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

// --- Panneau d'analyse d'impact incident -------------------------------------------

function ImpactPanel({ impact }: { impact: ImpactResult }) {
  const { t } = useTranslation();
  const tone = impact.severity === 'crit' ? 'crit' : 'warn';
  return (
    <div className={cn('rounded-xl border p-3', tone === 'crit' ? 'border-crit/40 bg-crit/5' : 'border-warn/40 bg-warn/5')}>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <AlertTriangle className={cn('h-3.5 w-3.5 shrink-0', tone === 'crit' ? 'text-crit' : 'text-warn')} />
        <span className={tone === 'crit' ? 'text-crit' : 'text-warn'}>
          {t('topo.incident.summary', { impacted: impact.impactedVms.length, degraded: impact.degradedVms.length })}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {impact.impactedVms.length > 0 && (
          <VmList title={t('topo.incident.impacted')} vms={impact.impactedVms} tone="crit" />
        )}
        {impact.degradedVms.length > 0 && (
          <VmList title={t('topo.incident.degraded')} vms={impact.degradedVms} tone="warn" />
        )}
      </div>
    </div>
  );
}

function VmList({ title, vms, tone }: { title: string; vms: TopologyVm[]; tone: 'crit' | 'warn' }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className={cn('mb-1 text-[10px] font-semibold uppercase tracking-wider', tone === 'crit' ? 'text-crit' : 'text-warn')}>
        {title} ({vms.length})
      </div>
      <ul className="space-y-0.5">
        {vms.map((v) => (
          <li key={v.vmid} className="flex items-center gap-2 text-xs">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', v.status === 'running' ? 'bg-ok' : 'bg-muted-foreground/50')} />
            <span className="truncate font-medium">{v.name}</span>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {v.vmid} · {v.node} · {t(`topo.status.${v.status}`)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Panneau de détails (clic sur un élément) --------------------------------------

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium">{value}</span>
    </div>
  );
}

/** Libellé des VMs impactées si l'élément donné tombe (réutilise impactAnalysis). */
function impactLabel(topo: NetworkTopology, failure: NetworkFailure): string {
  const r = impactAnalysis(topo, failure);
  const names = [...r.impactedVms, ...r.degradedVms].map((v) => v.name);
  return names.length > 0 ? names.join(', ') : '—';
}

function DetailPanel({ topo, sel, onSelect }: { topo: NetworkTopology; sel: TopologySelection; onSelect: (s: TopologySelection | null) => void }) {
  const { t } = useTranslation();

  let body: ReactNode = null;
  if (sel.kind === 'switch') {
    const s = topo.switches.find((x) => x.id === sel.id);
    if (!s) return null;
    const connected = topo.nodes.filter((n) => n.bridges.some((b) => b.name === s.bridgeName && b.subnet === s.subnet));
    body = (
      <>
        <Row label={t('topo.detail.subnet')} value={s.subnet ?? '—'} />
        <Row label={t('common.state')} value={s.inferred ? t('topo.inferred') : '—'} />
        <Row label={t('topo.legend.node')} value={connected.map((n) => n.node).join(', ') || '—'} />
        <Row label={t('topo.detail.impact')} value={impactLabel(topo, { kind: 'switch', id: s.id })} />
      </>
    );
  } else if (sel.kind === 'node') {
    const n = topo.nodes.find((x) => x.node === sel.id);
    if (!n) return null;
    body = (
      <>
        <Row label={t('common.state')} value={n.online ? t('nodes.online') : t('nodes.offline')} />
        <Row label={t('topo.detail.ip')} value={n.ip ?? '—'} />
        <Row label={t('topo.detail.nics')} value={n.nics.map((x) => x.name).join(', ') || '—'} />
        <Row
          label={t('topo.detail.bridges')}
          value={n.bridges.map((b) => `${b.name}${b.ip ? ` (${b.ip})` : ''}`).join(', ') || '—'}
        />
      </>
    );
  } else if (sel.kind === 'bridge') {
    const [nodeName, bridgeName] = sel.id.split(':');
    const n = topo.nodes.find((x) => x.node === nodeName);
    const b = n?.bridges.find((x) => x.name === bridgeName);
    if (!n || !b) return null;
    const vms = topo.vms.filter((v) => v.node === n.node && v.nets.some((x) => x.bridge === b.name));
    body = (
      <>
        <Row label={t('topo.detail.ip')} value={b.ip ?? '—'} />
        <Row label={t('topo.detail.subnet')} value={b.subnet ?? '—'} />
        <Row label={t('topo.detail.gateway')} value={b.gateway ?? '—'} />
        <Row label={t('topo.detail.ports')} value={b.ports.join(', ') || '—'} />
        <Row label={t('topo.legend.vm')} value={vms.map((v) => v.name).join(', ') || '—'} />
        <Row label={t('topo.detail.impact')} value={impactLabel(topo, { kind: 'bridge', node: n.node, bridge: b.name })} />
      </>
    );
  } else if (sel.kind === 'segment') {
    const [nodeName, bridgeName, vlanPart] = sel.id.split(':');
    const vlan = vlanPart === 'natif' ? null : Number(vlanPart);
    const vms = topo.vms.filter(
      (v) => v.node === nodeName && v.nets.some((x) => x.bridge === bridgeName && x.tag === vlan),
    );
    body = (
      <>
        <Row label={t('topo.detail.ports')} value={bridgeName} />
        <Row label={t('topo.vlan.label')} value={vlan === null ? t('topo.vlan.native') : vlan} />
        <Row label={t('topo.legend.vm')} value={vms.map((v) => v.name).join(', ') || '—'} />
      </>
    );
  } else if (sel.kind === 'vm') {
    const v = topo.vms.find((x) => String(x.vmid) === sel.id);
    if (!v) return null;
    body = (
      <>
        <Row label={t('common.state')} value={t(`topo.status.${v.status}`)} />
        <Row label={t('common.node')} value={v.node} />
        {v.nets.length > 0 ? (
          <div className="mt-1 overflow-hidden rounded-md border">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-secondary/50 text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">{t('topo.iface.col.iface')}</th>
                  <th className="px-2 py-1 font-medium">{t('topo.iface.col.bridge')}</th>
                  <th className="px-2 py-1 font-medium">{t('topo.iface.col.vlan')}</th>
                  <th className="px-2 py-1 font-medium">{t('topo.iface.col.mac')}</th>
                  <th className="px-2 py-1 font-medium">{t('topo.iface.col.ip')}</th>
                </tr>
              </thead>
              <tbody>
                {v.nets.map((x) => {
                  // IP : guest agent (liste complète v4+v6) → config → mode déclaré (LXC manual/dhcp).
                  const live = v.agentIps?.[x.iface];
                  const ip = live && live.length > 0 ? live.join(', ') : x.ip ?? (x.ipMode ? t(`common.ip.${x.ipMode}`) : null);
                  return (
                    <tr
                      key={x.iface}
                      onClick={() => onSelect({ kind: 'iface', id: `${v.vmid}:${x.iface}` })}
                      title={t('topo.iface.title')}
                      className="cursor-pointer border-t hover:bg-primary/5"
                    >
                      <td className="px-2 py-1 font-medium">{x.iface}</td>
                      <td className="px-2 py-1">{x.bridge}</td>
                      <td className="px-2 py-1">{x.tag === null ? t('topo.vlan.native') : x.tag}</td>
                      <td className="px-2 py-1 font-mono text-[10px]">{x.mac ?? '—'}</td>
                      <td className="px-2 py-1">{ip ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Row label={t('topo.detail.ifaces')} value="—" />
        )}
        <Row
          label={t('topo.detail.traffic')}
          value={`${formatBytes(v.netInBps)}/s ↓ · ${formatBytes(v.netOutBps)}/s ↑`}
        />
      </>
    );
  } else if (sel.kind === 'iface') {
    const [vmidPart, ifaceName] = sel.id.split(':');
    const v = topo.vms.find((x) => String(x.vmid) === vmidPart);
    const net = v?.nets.find((x) => x.iface === ifaceName);
    if (!v || !net) return null;
    const others = v.nets.length - 1;
    // IP : guest agent (liste complète v4+v6) → config → mode déclaré (LXC manual/dhcp).
    const live = v.agentIps?.[net.iface];
    body = (
      <>
        <Row label={t('topo.legend.vm')} value={`${v.name} (${v.vmid})`} />
        <Row label={t('topo.iface.col.iface')} value={net.iface} />
        <Row label={t('topo.iface.col.bridge')} value={net.bridge} />
        <Row label={t('topo.iface.col.vlan')} value={net.tag === null ? t('topo.vlan.native') : net.tag} />
        <Row label={t('topo.iface.col.mac')} value={net.mac ?? '—'} />
        <Row label={t('topo.iface.col.ip')} value={(live && live.length > 0 ? live.join(', ') : net.ip ?? (net.ipMode ? t(`common.ip.${net.ipMode}`) : null)) ?? '—'} />
        <Row
          label={t('topo.iface.impact')}
          value={others === 0 ? t('topo.iface.down') : t('topo.iface.degraded', { n: others })}
        />
      </>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {sel.kind === 'iface' ? t('topo.iface.title') : t('topo.detail.title')}
      </div>
      <div className="space-y-1.5">{body}</div>
    </div>
  );
}
