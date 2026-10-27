import {
  buildForecast,
  computeHealthScore,
  computePra,
  isThinStorage,
  usageSeverity,
  type Alert,
  type DashboardSnapshot,
  type EndpointSnapshot,
  type KpiSummary,
  type MultiDashboardSnapshot,
  type NodeHealth,
  type PoolAggregate,
  type PveNodeStatus,
  type PveVmResource,
  type Site,
  type TopConsumer,
} from '@prox4u/shared';
import { reloadOvercommitConfig, type AppConfig } from './config.js';
import type { DataSource } from './data-source.js';
import { buildLine, type InfluxClient } from './influx.js';
import type { WsHub } from './ws-hub.js';
import type { AuthContext } from '../modules/auth/runtime.js';

/** Endpoint surveillé : config + source de données + topologie (sites). */
export interface EndpointRuntime {
  id: string;
  name: string;
  /** URL API PVE (https://host:8006) — exposée au web pour les liens console */
  url: string;
  source: DataSource;
  sites: Site[];
}

export interface AppContext {
  config: AppConfig;
  endpoints: EndpointRuntime[];
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
  /** client InfluxDB (désactivé si INFLUX_TOKEN vide) */
  influx: InfluxClient;
  /** runtime d'authentification (store data/auth.json, sessions, provider) */
  auth: AuthContext;
  /** hub WebSocket (broadcast snapshots + messages ponctuels) */
  hub: WsHub;
}

const DAY_MS = 86_400_000;

interface DailySample {
  time: number;
  cpuPct: number;
  ramPct: number;
  storagePct: number;
}

/** État interne d'un endpoint (snapshot courant + tampon journalier). */
interface EndpointState {
  rt: EndpointRuntime;
  snapshot: DashboardSnapshot | null;
  lastError: string | null;
  daily: DailySample[];
  lastDayKey: string | null;
}

/**
 * Poller multi-endpoints : toutes les 5 s, interroge chaque endpoint en
 * parallèle (échecs isolés par endpoint), construit le MultiDashboardSnapshot
 * et le pousse via le WsHub.
 *
 * Maintient aussi un tampon d'échantillons journaliers par endpoint (30 j)
 * servant à la prévision de saturation du stockage (KPI + capacity planning).
 */
export class Poller {
  private states = new Map<string, EndpointState>();
  private multi: MultiDashboardSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private ctx: AppContext,
    private hub: WsHub,
    private intervalMs = 5_000,
  ) {
    for (const rt of ctx.endpoints) {
      this.states.set(rt.id, { rt, snapshot: null, lastError: null, daily: [], lastDayKey: null });
    }
  }

  start(): void {
    if (this.ctx.config.mock) this.seedMockHistory();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getMulti(): MultiDashboardSnapshot | null {
    return this.multi;
  }

  /** Historique journalier du stockage (%) d'un endpoint, pour la prévision. */
  getDiskHistory(endpointId: string): { time: number; value: number }[] {
    const st = this.states.get(endpointId);
    return st ? st.daily.map((d) => ({ time: d.time, value: Math.round(d.storagePct * 10) / 10 })) : [];
  }

  private seedMockHistory(): void {
    for (const st of this.states.values()) {
      const start =
        this.ctx.config.mockScenario === 'nominal' ? 38 : this.ctx.config.mockScenario === 'degraded' ? 55 : 76;
      const now = Date.now();
      for (let i = 29; i >= 0; i--) {
        const t = now - i * DAY_MS;
        const progress = (29 - i) / 29;
        st.daily.push({
          time: t,
          cpuPct: start * 0.7 + progress * 6,
          ramPct: start * 0.85 + progress * 8,
          storagePct: start + progress * (start * 0.12),
        });
      }
      st.lastDayKey = dayKey(now);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      reloadOvercommitConfig(this.ctx.config, this.ctx.logger);
      const endpoints = await Promise.all([...this.states.values()].map((st) => this.pollEndpoint(st)));
      this.multi = {
        generatedAt: Date.now(),
        mock: this.ctx.config.mock,
        defaultEndpointId: this.ctx.config.defaultEndpointId,
        overcommit: this.ctx.config.overcommit,
        endpoints,
      };
      this.hub.broadcast(this.multi);
    } finally {
      this.ticking = false;
    }
  }

  /** Poll un endpoint ; en cas d'échec, conserve le dernier snapshot connu. */
  private async pollEndpoint(st: EndpointState): Promise<EndpointSnapshot> {
    const { rt } = st;
    try {
      const [nodes, vms, storages] = await Promise.all([
        rt.source.getNodes(),
        rt.source.getResources(),
        rt.source.getStorage(),
      ]);

      // Allocations VMs (templates exclus) : par nœud et au total — ratios de surallocation
      const allocVms = vms.filter((v) => !v.template);
      const cpuAllocByNode = new Map<string, number>();
      const ramAllocByNode = new Map<string, number>();
      for (const v of allocVms) {
        cpuAllocByNode.set(v.node, (cpuAllocByNode.get(v.node) ?? 0) + (v.cpuAlloc ?? 0));
        ramAllocByNode.set(v.node, (ramAllocByNode.get(v.node) ?? 0) + (v.maxmem ?? 0));
      }
      const totalCpuAlloc = allocVms.reduce((s, v) => s + (v.cpuAlloc ?? 0), 0);
      const totalRamAlloc = allocVms.reduce((s, v) => s + (v.maxmem ?? 0), 0);
      const totalDiskAlloc = allocVms.reduce((s, v) => s + (v.maxdisk ?? 0), 0);

      const nodeHealth = nodes.map((n) => {
        const cpuPct = n.online && n.cpus ? (n.cpu ?? 0) / n.cpus * 100 : 0;
        const ramPct = n.online && n.memTotal ? ((n.memUsed ?? 0) / n.memTotal) * 100 : 0;
        const diskPct = n.online && n.rootfsTotal ? ((n.rootfsUsed ?? 0) / n.rootfsTotal) * 100 : 0;
        return {
          node: n.node,
          online: n.online,
          siteId: rt.sites.find((s) => s.nodes.includes(n.node))?.id ?? null,
          cpuPct: round1(cpuPct),
          ramPct: round1(ramPct),
          diskPct: round1(diskPct),
          uptimeSec: n.uptime,
          severity: !n.online ? 'crit' : usageSeverity(Math.max(cpuPct, ramPct, diskPct), this.ctx.config.overcommit),
          ip: n.ip,
          cpus: n.cpus,
          memUsedBytes: n.memUsed,
          memTotalBytes: n.memTotal,
          loadavg: n.loadavg,
          version: n.version,
          cpuAllocCores: cpuAllocByNode.get(n.node) ?? 0,
          ramAllocBytes: ramAllocByNode.get(n.node) ?? 0,
        } satisfies NodeHealth;
      });

      const online = nodes.filter((n) => n.online);
      const totalCpus = online.reduce((s, n) => s + (n.cpus ?? 0), 0);
      const usedCpus = online.reduce((s, n) => s + (n.cpu ?? 0), 0);
      const totalRam = online.reduce((s, n) => s + (n.memTotal ?? 0), 0);
      const usedRam = online.reduce((s, n) => s + (n.memUsed ?? 0), 0);
      const storWithCap = storages.filter((s) => s.total && s.total > 0);
      const totalDisk = storWithCap.reduce((s, x) => s + (x.total ?? 0), 0);
      const usedDisk = storWithCap.reduce((s, x) => s + (x.used ?? 0), 0);
      // Capacité des pools thin uniquement — dénominateur du ratio de surallocation disk
      const thinTotal = storWithCap.filter((s) => isThinStorage(s.type)).reduce((s, x) => s + (x.total ?? 0), 0);

      const kpis: KpiSummary = {
        nodes: { online: online.length, total: nodes.length },
        cpuTotalCores: totalCpus,
        cpuUsedCores: Math.round(usedCpus * 10) / 10,
        cpuPct: round1(totalCpus ? (usedCpus / totalCpus) * 100 : 0),
        cpuAllocatedCores: totalCpuAlloc,
        ramUsedBytes: usedRam,
        ramTotalBytes: totalRam,
        ramPct: round1(totalRam ? (usedRam / totalRam) * 100 : 0),
        ramAllocatedBytes: totalRamAlloc,
        diskAllocatedBytes: totalDiskAlloc,
        diskThinTotalBytes: thinTotal,
        storageUsedBytes: usedDisk,
        storageTotalBytes: totalDisk,
        storagePct: round1(totalDisk ? (usedDisk / totalDisk) * 100 : 0),
        storageDaysToFull: null, // rempli après mise à jour du tampon journalier
        vmsRunning: vms.filter((v) => v.status === 'running').length,
        vmsStopped: vms.length - vms.filter((v) => v.status === 'running').length,
        vmsTotal: vms.length,
      };

      this.updateDaily(st, kpis);
      kpis.storageDaysToFull = buildForecast('disk', this.getDiskHistory(rt.id)).daysTo90;

      const pra = computePra(rt.sites, nodes, vms);
      const alerts = buildAlerts(nodeHealth, kpis, pra);
      const health = computeHealthScore(nodeHealth, kpis, pra);

      const storageInfos = storWithCap.map((s) => ({
        storage: s.storage,
        type: s.type,
        usedBytes: s.used ?? 0,
        totalBytes: s.total ?? 0,
        pct: round1(((s.used ?? 0) / (s.total ?? 1)) * 100),
      }));

      const running = vms.filter((v) => v.status === 'running');
      const network = {
        rxBps: Math.round(running.reduce((sum, v) => sum + (v.netin ?? 0), 0)),
        txBps: Math.round(running.reduce((sum, v) => sum + (v.netout ?? 0), 0)),
      };

      const vmSummaries = vms.map((v) => ({
        vmid: v.vmid,
        name: v.name,
        type: v.type,
        status: v.status,
        node: v.node,
        cpuPct: round1(v.cpuAlloc ? ((v.cpu ?? 0) / v.cpuAlloc) * 100 : 0),
        memBytes: Math.round(v.mem ?? 0),
        maxmemBytes: v.maxmem,
        diskBytes: v.disk != null ? Math.round(v.disk) : null,
        maxdiskBytes: v.maxdisk,
        cpuAllocCores: v.cpuAlloc ?? 0,
        os: v.os ?? null,
        uptimeSec: v.uptime,
        netInBps: v.netin != null ? Math.round(v.netin) : null,
        netOutBps: v.netout != null ? Math.round(v.netout) : null,
        diskReadBps: v.diskread != null ? Math.round(v.diskread) : null,
        diskWriteBps: v.diskwrite != null ? Math.round(v.diskwrite) : null,
        ipAddresses: v.ipAddresses ?? [],
      }));

      const snap: DashboardSnapshot = {
        generatedAt: Date.now(),
        mock: rt.source.isMock,
        cluster: {
          name: rt.name,
          nodesOnline: online.length,
          nodesTotal: nodes.length,
        },
        sites: rt.sites,
        health,
        kpis,
        pra,
        nodes: nodeHealth,
        vms: vmSummaries,
        storages: storageInfos,
        network,
        topVms: topConsumers(vms),
        topPools: poolAggregates(vms),
        alerts,
      };
      st.snapshot = snap;
      st.lastError = null;
      this.writeInflux(rt.id, nodes, nodeHealth, vms, kpis);
      return { id: rt.id, name: rt.name, url: rt.url, ok: true, snapshot: snap };
    } catch (err) {
      st.lastError = (err as Error).message;
      this.ctx.logger.error(`poller endpoint ${rt.id} en échec : ${st.lastError}`);
      return { id: rt.id, name: rt.name, url: rt.url, ok: false, error: st.lastError, snapshot: st.snapshot };
    }
  }

  private updateDaily(st: EndpointState, kpis: KpiSummary): void {
    const now = Date.now();
    const key = dayKey(now);
    if (key === st.lastDayKey) return;
    st.lastDayKey = key;
    st.daily.push({ time: now - (now % DAY_MS), cpuPct: kpis.cpuPct, ramPct: kpis.ramPct, storagePct: kpis.storagePct });
    if (st.daily.length > 30) st.daily = st.daily.slice(-30);
  }

  /**
   * Écrit les mesures du tick dans InfluxDB (base raw, précision seconde),
   * avec le tag `cluster` = id de l'endpoint. Mode mock exclu : les données
   * simulées ne doivent pas polluer l'historique.
   */
  private writeInflux(clusterId: string, nodes: PveNodeStatus[], nodeHealth: NodeHealth[], vms: PveVmResource[], kpis: KpiSummary): void {
    const influx = this.ctx.influx;
    if (!influx.enabled || this.ctx.config.mock) return;
    const ts = Math.floor(Date.now() / 1000);
    // Stockage VM au niveau endpoint (used/total, toutes capacités confondues) :
    // série de référence pour les graphiques « Disque » — pondérée par capacité
    // à la lecture (contrairement à disk_pct = rootfs, qui reste pour la santé nœud).
    if (kpis.storageTotalBytes > 0) {
      influx.enqueue(
        buildLine(
          'storage_metrics',
          { cluster: clusterId },
          {
            used_bytes: Math.round(kpis.storageUsedBytes),
            total_bytes: Math.round(kpis.storageTotalBytes),
          },
          ts,
        ),
      );
    }
    // PVE ≥ 9 : /nodes/{n}/status n'expose plus netin/netout → le trafic réseau du
    // nœud est dérivé de la somme des VMs en marche (même convention que le KPI
    // réseau du dashboard) et écrit dans une mesure dédiée `node_net` : les lignes
    // historiques de node_metrics ont un net à zéro, la lecture séparée évite toute dilution.
    const vmNetByNode = new Map<string, { in: number; out: number }>();
    for (const v of vms) {
      if (v.status !== 'running') continue;
      const e = vmNetByNode.get(v.node) ?? { in: 0, out: 0 };
      e.in += v.netin ?? 0;
      e.out += v.netout ?? 0;
      vmNetByNode.set(v.node, e);
    }
    for (const n of nodes) {
      if (!n.online) continue;
      const h = nodeHealth.find((x) => x.node === n.node);
      if (!h) continue;
      influx.enqueue(
        buildLine(
          'node_metrics',
          { cluster: clusterId, node: n.node },
          {
            cpu_pct: h.cpuPct,
            ram_pct: h.ramPct,
            disk_pct: h.diskPct,
          },
          ts,
        ),
      );
      const net = vmNetByNode.get(n.node);
      influx.enqueue(
        buildLine(
          'node_net',
          { cluster: clusterId, node: n.node },
          {
            net_in_bps: Math.round(net?.in ?? 0),
            net_out_bps: Math.round(net?.out ?? 0),
          },
          ts,
        ),
      );
    }
    for (const v of vms) {
      if (v.status !== 'running') continue;
      influx.enqueue(
        buildLine(
          'vm_metrics',
          { cluster: clusterId, node: v.node, vmid: String(v.vmid), name: v.name },
          {
            cpu_pct: round1(v.cpuAlloc ? ((v.cpu ?? 0) / v.cpuAlloc) * 100 : 0),
            mem_bytes: Math.round(v.mem ?? 0),
            // I/O par VM (onglet Monitor) — disques en octets/s, réseau en bits/s (unité PVE, comme node_metrics)
            disk_read_bps: Math.round(v.diskread ?? 0),
            disk_write_bps: Math.round(v.diskwrite ?? 0),
            net_in_bps: Math.round(v.netin ?? 0),
            net_out_bps: Math.round(v.netout ?? 0),
          },
          ts,
        ),
      );
    }
  }
}

function buildAlerts(nodes: NodeHealth[], kpis: KpiSummary, pra: DashboardSnapshot['pra']): Alert[] {
  const alerts: Alert[] = [];
  for (const n of nodes) {
    if (!n.online) alerts.push({ id: `node-down-${n.node}`, severity: 'crit', messageKey: 'alerts.nodeDown', params: { node: n.node } });
  }
  if (kpis.cpuPct > 90) alerts.push({ id: 'cpu-high', severity: 'crit', messageKey: 'alerts.cpuHigh', params: { pct: kpis.cpuPct } });
  else if (kpis.cpuPct >= 80) alerts.push({ id: 'cpu-high', severity: 'warn', messageKey: 'alerts.cpuHigh', params: { pct: kpis.cpuPct } });
  if (kpis.ramPct > 90) alerts.push({ id: 'ram-high', severity: 'crit', messageKey: 'alerts.ramHigh', params: { pct: kpis.ramPct } });
  else if (kpis.ramPct >= 80) alerts.push({ id: 'ram-high', severity: 'warn', messageKey: 'alerts.ramHigh', params: { pct: kpis.ramPct } });
  if (kpis.storagePct > 90) alerts.push({ id: 'disk-high', severity: 'crit', messageKey: 'alerts.diskHigh', params: { pct: kpis.storagePct } });
  else if (kpis.storagePct >= 80) alerts.push({ id: 'disk-high', severity: 'warn', messageKey: 'alerts.diskHigh', params: { pct: kpis.storagePct } });

  for (const s of pra.sites) {
    if (s.severity === 'crit' || s.severity === 'warn') {
      alerts.push({
        id: `pra-${s.severity}-${s.siteId}`,
        severity: s.severity,
        messageKey: s.severity === 'crit' ? 'alerts.praCrit' : 'alerts.praWarn',
        params: { site: s.siteName, pct: Math.min(Math.round(s.absorptionPct ?? 0), 999) },
      });
    }
  }
  return alerts;
}

function topConsumers(vms: PveVmResource[]): TopConsumer[] {
  return vms
    .filter((v) => v.status === 'running')
    .map((v) => ({
      vmid: v.vmid,
      name: v.name,
      node: v.node,
      pool: v.pool ?? null,
      cpuPct: round1(v.cpuAlloc ? ((v.cpu ?? 0) / v.cpuAlloc) * 100 : 0),
      memBytes: v.mem ?? 0,
      memPct: round1(v.maxmem ? ((v.mem ?? 0) / v.maxmem) * 100 : 0),
    }))
    .sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes)
    .slice(0, 5);
}

function poolAggregates(vms: PveVmResource[]): PoolAggregate[] {
  const byPool = new Map<string, PoolAggregate>();
  for (const v of vms) {
    const name = v.pool ?? 'Sans pool';
    const agg = byPool.get(name) ?? { pool: name, vmCount: 0, runningCount: 0, cpuPct: 0, memBytes: 0 };
    agg.vmCount += 1;
    if (v.status === 'running') {
      agg.runningCount += 1;
      agg.memBytes += v.mem ?? 0;
    }
    byPool.set(name, agg);
  }
  // cpuPct par pool : somme des utilisations / somme des allocations
  const alloc = new Map<string, number>();
  const used = new Map<string, number>();
  for (const v of vms) {
    const name = v.pool ?? 'Sans pool';
    if (v.cpuAlloc) {
      alloc.set(name, (alloc.get(name) ?? 0) + v.cpuAlloc);
      used.set(name, (used.get(name) ?? 0) + (v.cpu ?? 0));
    }
  }
  const result = [...byPool.values()].map((a) => ({
    ...a,
    cpuPct: round1(alloc.get(a.pool) ? ((used.get(a.pool) ?? 0) / alloc.get(a.pool)!) * 100 : 0),
  }));
  return result.sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes).slice(0, 5);
}

function dayKey(t: number): string {
  return new Date(t).toDateString();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
