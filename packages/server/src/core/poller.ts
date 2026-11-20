import {
  buildForecast,
  buildStorageVolumes,
  computeHealthScore,
  computePra,
  usageSeverity,
  type AgentFsUsage,
  type Alert,
  type DashboardSnapshot,
  type EndpointSnapshot,
  type KpiSummary,
  type MultiDashboardSnapshot,
  type NodeHealth,
  type PoolAggregate,
  type PveNodeStatus,
  type PveVmResource,
  type QuorumState,
  type Site,
  type StorageDiskAlloc,
  type StorageVolume,
  type TopConsumer,
} from '@prox4u/shared';
import { reloadOvercommitConfig, type AppConfig } from './config.js';
import type { DataSource } from './data-source.js';
import { AGENT_CONCURRENCY, mapLimit } from './prox4u-client.js';
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
  /**
   * Vivacité de l'agent invité (QGA) par vmid, mise à jour par le réchauffage
   * background (aucun appel API additionnel). true = QGA répond · false = agent non
   * démarré / injoignable. Absence d'entrée = inconnu (démarrage, cache pas réchauffé)
   * ou n/a (LXC, VM arrêtée → la clé est purgée).
   */
  agentActive: Map<number, boolean>;
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
  /**
   * Compteurs cumulés PVE (netin/netout/diskread/diskwrite) du poll précédent,
   * par VM. /cluster/resources renvoie des totaux depuis le boot (pas des débits) →
   * on en dérive le débit/s par delta avec ce snapshot. Clé : endpoint/nœud/vmid.
   */
  private ioPrev = new Map<string, Array<{ t: number; in: number; out: number; rd: number; wr: number }>>();
  /**
   * Guard single-flight du réchauffage des données agent (fsinfo/osinfo/interfaces), par
   * endpoint : un seul réchauffage en vol à la fois. Les CACHES DU CLIENT (fsinfo/osinfo 5 min,
   * interfaces 60 s) font le throttle réel — les vrais appels agent ne se font qu'aux fenêtres
   * de péremption. Le réchauffage tourne en BACKGROUND (hors du tick) et borne sa concurrence
   * à AGENT_CONCURRENCY : un guest lent n'entraîne pas le tick ni les autres VMs.
   */
  private agentRefreshing = new Set<string>();

  constructor(
    private ctx: AppContext,
    private hub: WsHub,
    private intervalMs = 5_000,
  ) {
    for (const rt of ctx.endpoints) {
      this.states.set(rt.id, { rt, snapshot: null, lastError: null, daily: [], lastDayKey: null, agentActive: new Map() });
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
      const [cluster, vms, storages] = await Promise.all([
        rt.source.getNodes(),
        rt.source.getResources(),
        rt.source.getStorage(),
      ]);
      const nodes = cluster.nodes;

      // Réchauffage BACKGROUND des données agent (fsinfo/osinfo/interfaces) — source unique
      // partagée avec la route proxmox-inventory. `void` (hors du tick) + single-flight : le
      // tick ne bloque JAMAIS derrière un appel agent, quelle que soit la taille du parc.
      void this.refreshAgentData(rt, vms);

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
      // Allocation de disques VM par datastore (Σ `size=` de la config, jointe en cache 1 h) —
      // base de la cartographie et du ratio thin. Une VM multi-disques compte sur chacun.
      const diskAllocMap = new Map<string, number>();
      for (const v of allocVms) for (const d of v.disks ?? []) diskAllocMap.set(d.storage, (diskAllocMap.get(d.storage) ?? 0) + d.sizeBytes);
      const diskAllocByStorage: StorageDiskAlloc[] = [...diskAllocMap.entries()].map(([storage, allocatedBytes]) => ({ storage, allocatedBytes }));

      const nodeHealth = nodes.map((n) => {
        // Le champ `cpu` du status nœud est déjà une fraction 0–1 du CPU total
        // (pas des unités de cœur) → on ne divise PAS par n.cpus.
        const cpuPct = n.online ? (n.cpu ?? 0) * 100 : 0;
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
          rootfsUsedBytes: n.rootfsUsed,
          rootfsTotalBytes: n.rootfsTotal,
          loadavg: n.loadavg,
          version: n.version,
          cpuAllocCores: cpuAllocByNode.get(n.node) ?? 0,
          ramAllocBytes: ramAllocByNode.get(n.node) ?? 0,
        } satisfies NodeHealth;
      });

      const online = nodes.filter((n) => n.online);
      const totalCpus = online.reduce((s, n) => s + (n.cpus ?? 0), 0);
      // `n.cpu` est une fraction 0–1 → conversion en unités de cœur (× cpus)
      const usedCpus = online.reduce((s, n) => s + (n.cpu ?? 0) * (n.cpus ?? 0), 0);
      const totalRam = online.reduce((s, n) => s + (n.memTotal ?? 0), 0);
      const usedRam = online.reduce((s, n) => s + (n.memUsed ?? 0), 0);
      // Hiérarchie iSCSI → LVM : le LUN iSCSI est le volume physique compté ; ses VG enfants
      // (listés dans `duplicateOf` du LUN) sont exclus des sommes — sinon le volume est compté
      // deux fois (LUN + VG). C'est l'inverse de l'ancien dédoublonnage (on comptait le VG et
      // on écartait le LUN) : on compte désormais le LUN, on écarte les VG enfants.
      const childVgNames = new Set(storages.flatMap((s) => s.duplicateOf ?? []));
      // Taille d'autorité des LUN (config storage-volumes.json) : appliquée aux totaux iSCSI
      // avant les sommes — un LUN sans taille connue reste une borne basse (Σ VG).
      const lunSizes = this.ctx.config.lunSizes;
      const storagesWithLun = storages.map((s) => (s.type === 'iscsi' && lunSizes[s.storage] ? { ...s, total: lunSizes[s.storage] } : s));
      const storWithCap = storagesWithLun.filter((s) => s.total && s.total > 0 && !childVgNames.has(s.storage));
      const totalDisk = storWithCap.reduce((s, x) => s + (x.total ?? 0), 0);
      const usedDisk = storWithCap.reduce((s, x) => s + (x.used ?? 0), 0);
      // Cartographie des volumes physiques (arbre iSCSI → LVM, classe thin/thick). Source unique
      // du ratio disk : les KPI thin en sont dérivés — les disques sur du thick (lvm/dir/iscsi)
      // ne gonflent plus un dénominateur thin → plus de faux 916 %.
      const { volumes: storageVolumes } = buildStorageVolumes(storagesWithLun, diskAllocByStorage, this.ctx.config.overcommit, lunSizes);
      // KPI thin : on aplatit l'arbre (un VG thin enfant compte ; son LUN parent est thick).
      const volumeNodes: StorageVolume[] = [];
      const collectVolumes = (vs: StorageVolume[]): void => {
        for (const v of vs) {
          volumeNodes.push(v);
          collectVolumes(v.children);
        }
      };
      collectVolumes(storageVolumes);
      const thinWithDisks = volumeNodes.filter((v) => v.thinCapable && v.hasDisks);
      const diskThinAllocatedBytes = thinWithDisks.reduce((s, v) => s + v.allocatedBytes, 0);
      const diskThinTotalBytes = thinWithDisks.reduce((s, v) => s + (v.totalBytes ?? 0), 0);

      // VMs QEMU en cours dont l'agent invité est inactif (alerte critique UI)
      const vmsAgentDown = vms.filter((v) => v.type === 'qemu' && v.status === 'running' && st.agentActive.get(v.vmid) === false).length;

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
        diskThinAllocatedBytes,
        diskThinTotalBytes,
        storageUsedBytes: usedDisk,
        storageTotalBytes: totalDisk,
        storagePct: round1(totalDisk ? (usedDisk / totalDisk) * 100 : 0),
        storageDaysToFull: null, // rempli après mise à jour du tampon journalier
        vmsRunning: vms.filter((v) => v.status === 'running').length,
        vmsStopped: vms.length - vms.filter((v) => v.status === 'running').length,
        vmsTotal: vms.length,
        vmsAgentDown,
      };

      this.updateDaily(st, kpis);
      kpis.storageDaysToFull = buildForecast('disk', this.getDiskHistory(rt.id)).daysTo90;

      const pra = computePra(rt.sites, nodes, vms);
      const clusterInfo = {
        name: rt.name,
        nodesOnline: online.length,
        nodesTotal: nodes.length,
        quorum: cluster.quorum,
        quorumState: cluster.quorumState,
      };
      const alerts = buildAlerts(nodeHealth, kpis, pra, clusterInfo);
      const health = computeHealthScore(nodeHealth, kpis, pra, clusterInfo);

      const storageInfos = storWithCap.map((s) => ({
        storage: s.storage,
        type: s.type,
        usedBytes: s.used ?? 0,
        totalBytes: s.total ?? 0,
        pct: round1(((s.used ?? 0) / (s.total ?? 1)) * 100),
      }));
      // Séries d'occupation par datastore (`datastore_metrics`) : TOUTES les vues à capacité
      // connue — y compris les VG enfants du LUN. Le dédoublonnage ne s'applique qu'aux SOMMES
      // KPI (pas de LUN + VG deux fois dans storageTotalBytes) ; chaque vue a sa propre courbe
      // indépendante (le VG est la vue où sont les disques VM — son graphique est le plus utile).
      // Sans ceci, l'inversion du dédoublonnage aurait privé les VG de tout historique.
      const storagesForMetrics = storagesWithLun
        .filter((s) => s.total && s.total > 0)
        .map((s) => ({
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
        cpuPct: round1(vmCpuPct(v)),
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
        // null = n/a (LXC/arrêtée) ou inconnu (1ers ticks, avant le réchauffage agent)
        agentActive: v.type === 'qemu' && v.status === 'running' ? st.agentActive.get(v.vmid) ?? null : null,
      }));

      const snap: DashboardSnapshot = {
        generatedAt: Date.now(),
        mock: rt.source.isMock,
        cluster: clusterInfo,
        sites: rt.sites,
        health,
        kpis,
        pra,
        nodes: nodeHealth,
        vms: vmSummaries,
        storages: storageInfos,
        storageVolumes,
        network,
        topVms: topConsumers(vms),
        topPools: poolAggregates(vms),
        alerts,
      };
      st.snapshot = snap;
      st.lastError = null;
      // Séries par datastore = toutes les vues à capacité (VG compris) — pas la liste dédoublonnée.
      await this.writeInflux(rt.id, rt.source, nodes, nodeHealth, vms, kpis, storagesForMetrics);
      return { id: rt.id, name: rt.name, url: rt.url, ok: true, snapshot: snap };
    } catch (err) {
      st.lastError = (err as Error).message;
      this.ctx.logger.error(`poller endpoint ${rt.id} en échec : ${st.lastError}`);
      return { id: rt.id, name: rt.name, url: rt.url, ok: false, error: st.lastError, snapshot: st.snapshot };
    }
  }

  /**
   * Réchauffe en background les données agent (fsinfo, osinfo, interfaces) de toutes les VMs
   * de l'endpoint, en les stockant dans les CACHES PARTAGÉS du client (source unique avec la
   * route proxmox-inventory). Single-flight par endpoint (un réchauffage en vol à la fois) et
   * concurrence bornée à AGENT_CONCURRENCY : un guest lent (timeout 8 s) retient au plus
   * AGENT_CONCURRENCY appels, pas N — et le pool undici n'est jamais épuisé. Les caches du
   * client font le throttle (fsinfo/osinfo 5 min, interfaces 60 s) → les vrais appels agent ne
   * se font qu'aux fenêtres de péremption, pas à chaque tick.
   */
  private async refreshAgentData(rt: EndpointRuntime, vms: PveVmResource[]): Promise<void> {
    if (this.agentRefreshing.has(rt.id)) return;
    this.agentRefreshing.add(rt.id);
    try {
      const st = this.states.get(rt.id)!;
      await mapLimit(vms, AGENT_CONCURRENCY, async (v) => {
        const { fs } = await rt.source.getAgentBundle(v.node, v.vmid, v.type, v.status);
        // `fs !== null` = le QGA répond (y compris [] : agent vivant, aucun fs sur disque VM).
        if (v.type === 'qemu' && v.status === 'running') st.agentActive.set(v.vmid, fs !== null);
        else st.agentActive.delete(v.vmid); // LXC / arrêtée / template : n/a
      });
    } finally {
      this.agentRefreshing.delete(rt.id);
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
   * Convertit les compteurs cumulés PVE (octets totaux depuis le boot) en débits/s.
   * PVE rafraîchit ses compteurs ~toutes les 10 s alors que l'app poll toutes les 5 s :
   * un delta simple (÷ intervalle de poll) produit des pics surestimés et des zéros.
   * On divise donc par le temps RÉEL écoulé sur une fenêtre glissante (30 s) : le
   * débit = (cumul_fin − cumul_début) / (t_fin − t_début), ce qui lisse les zéros/pics
   * et restaure le débit moyen réel. Reset de compteur (reboot) borné à 0.
   */
  private deltaCounters(
    endpointId: string,
    node: string,
    vmid: number,
    cur: { in: number; out: number; rd: number; wr: number },
    now: number,
    windowMs = 30_000,
  ): { in: number; out: number; rd: number; wr: number } {
    const key = `${endpointId}/${node}/${vmid}`;
    const buf = this.ioPrev.get(key) ?? [];
    buf.push({ t: now, ...cur });
    while (buf.length > 2 && now - buf[0].t > windowMs) buf.shift();
    this.ioPrev.set(key, buf);
    if (buf.length < 2) return { in: 0, out: 0, rd: 0, wr: 0 };
    const first = buf[0];
    const last = buf[buf.length - 1];
    const dt = (last.t - first.t) / 1000; // temps réel sur la fenêtre
    if (dt <= 0) return { in: 0, out: 0, rd: 0, wr: 0 };
    const rate = (c: number, p: number) => Math.max(0, (c - p) / dt);
    return { in: rate(last.in, first.in), out: rate(last.out, first.out), rd: rate(last.rd, first.rd), wr: rate(last.wr, first.wr) };
  }

  /**
   * Écrit les mesures du tick dans InfluxDB (base raw, précision seconde),
   * avec le tag `cluster` = id de l'endpoint. Mode mock exclu : les données
   * simulées ne doivent pas polluer l'historique.
   */
  private async writeInflux(
    clusterId: string,
    source: DataSource,
    nodes: PveNodeStatus[],
    nodeHealth: NodeHealth[],
    vms: PveVmResource[],
    kpis: KpiSummary,
    storages: { storage: string; usedBytes: number; totalBytes: number }[],
  ): Promise<void> {
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
    // Occupation par datastore (used/total) — séries temporelles du graphique
    // d'occupation et du capacity planning par datastore (vue stockage).
    for (const s of storages) {
      if (!s.totalBytes || s.totalBytes <= 0) continue;
      influx.enqueue(
        buildLine(
          'datastore_metrics',
          { cluster: clusterId, storage: s.storage },
          {
            used_bytes: Math.round(s.usedBytes),
            total_bytes: Math.round(s.totalBytes),
          },
          ts,
        ),
      );
    }
    // PVE ≥ 9 : /nodes/{n}/status n'expose plus netin/netout → le trafic réseau du
    // nœud est dérivé de la somme des débits des VMs en marche, écrit dans `node_net`.
    // ATTENTION : netin/netout/diskread/diskwrite de /cluster/resources sont des
    // CUMULATIFS (octets totaux depuis le boot), pas des débits/s → conversion par
    // delta avec le poll précédent (deltaCounters). Le 1er poll renvoie 0.
    const now = Date.now();
    const vmIo = new Map<number, { in: number; out: number; rd: number; wr: number }>();
    for (const v of vms) {
      if (v.status !== 'running') continue;
      vmIo.set(
        v.vmid,
        this.deltaCounters(clusterId, v.node, v.vmid, {
          in: v.netin ?? 0,
          out: v.netout ?? 0,
          rd: v.diskread ?? 0,
          wr: v.diskwrite ?? 0,
        }, now),
      );
    }
    const nodeNetByNode = new Map<string, { in: number; out: number }>();
    for (const v of vms) {
      if (v.status !== 'running') continue;
      const r = vmIo.get(v.vmid);
      if (!r) continue;
      const e = nodeNetByNode.get(v.node) ?? { in: 0, out: 0 };
      e.in += r.in;
      e.out += r.out;
      nodeNetByNode.set(v.node, e);
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
      const net = nodeNetByNode.get(n.node);
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
    // Occupation disque (réelle) PAR FILESYSTEM : QEMU via l'agent invité (get-fsinfo),
    // LXC via /cluster/resources (disk = rootfs utilisé, maxdisk = alloué — déjà réels).
    // Le RRD `disk` vaut 0 pour les QEMU → l'agent est la seule source fiable par VM.
    // Lecture SEULE des CACHES PARTAGÉS du client (chauffés en background par
    // refreshAgentData) : writeInflux ne relance JAMAIS l'agent ici — zéro fetch sur le
    // chemin d'écriture, et la même source alimente la route proxmox-inventory.
    // filesystems par VM (une entrée par point de montage) → mesure vm_fs.
    const fsByVm = new Map<number, AgentFsUsage[]>();
    // agrégat pour vm_metrics (disk_bytes = somme used, disk_alloc_bytes = somme total).
    const diskByVm = new Map<number, { used: number | null; alloc: number | null }>();
    for (const v of vms) {
      if (v.status !== 'running') continue;
      const alloc = v.maxdisk ?? null;
      if (v.type !== 'qemu') {
        // LXC : un seul filesystem rootfs (pas d'agent).
        const used = Math.round(v.disk ?? 0);
        const allocN = v.maxdisk ?? 0;
        if (allocN > 0) {
          fsByVm.set(v.vmid, [{ mountpoint: '/', dev: 'rootfs', usedBytes: used, totalBytes: allocN }]);
          diskByVm.set(v.vmid, { used, alloc: allocN });
        } else {
          diskByVm.set(v.vmid, { used: used > 0 ? used : null, alloc: null });
        }
        continue;
      }
      // QEMU : lecture seule du cache agent (chauffé en background). Absent au 1er tick →
      // vm_fs omis pour ce tick (comme l'I/O qui démarre au 2e poll) — aucun fetch ici.
      const fs = source.cachedFsUsage(v.node, v.vmid);
      if (fs && fs.length > 0) {
        fsByVm.set(v.vmid, fs);
        const used = fs.reduce((s, f) => s + f.usedBytes, 0);
        const tot = fs.reduce((s, f) => s + f.totalBytes, 0);
        diskByVm.set(v.vmid, { used: used > 0 ? used : null, alloc: tot > 0 ? tot : alloc });
      } else {
        diskByVm.set(v.vmid, { used: null, alloc }); // cache pas encore chaud
      }
    }
    for (const v of vms) {
      if (v.status !== 'running') continue;
      const r = vmIo.get(v.vmid) ?? { in: 0, out: 0, rd: 0, wr: 0 };
      const du = diskByVm.get(v.vmid) ?? { used: null, alloc: null };
      const fields: Record<string, number> = {
        // QEMU : cpu en unités de cœur → ÷ cpuAlloc × 100. LXC : fraction 0–1 → × 100.
        cpu_pct: round1(vmCpuPct(v)),
        mem_bytes: Math.round(v.mem ?? 0),
        // I/O par VM : débits/s calculés par delta des compteurs cumulés PVE
        disk_read_bps: Math.round(r.rd),
        disk_write_bps: Math.round(r.wr),
        net_in_bps: Math.round(r.in),
        net_out_bps: Math.round(r.out),
      };
      // Occupation disque (agrégat) : omise si inconnue (graphe démarre plus tard, comme l'I/O).
      if (du.used != null) fields.disk_bytes = Math.round(du.used);
      if (du.alloc != null) fields.disk_alloc_bytes = Math.round(du.alloc);
      influx.enqueue(
        buildLine('vm_metrics', { cluster: clusterId, node: v.node, vmid: String(v.vmid), name: v.name }, fields, ts),
      );
      // Occupation disque PAR FILESYSTEM → mesure vm_fs (une ligne par point de montage).
      for (const f of fsByVm.get(v.vmid) ?? []) {
        influx.enqueue(
          buildLine(
            'vm_fs',
            { cluster: clusterId, node: v.node, vmid: String(v.vmid), name: v.name, mountpoint: f.mountpoint, dev: f.dev },
            { used_bytes: Math.round(f.usedBytes), total_bytes: Math.round(f.totalBytes) },
            ts,
          ),
        );
      }
    }
  }
}

function buildAlerts(
  nodes: NodeHealth[],
  kpis: KpiSummary,
  pra: DashboardSnapshot['pra'],
  cluster?: { quorumState: QuorumState | null },
): Alert[] {
  const alerts: Alert[] = [];
  if (cluster?.quorumState === 'lost') {
    alerts.push({
      id: 'quorum-lost',
      severity: 'crit',
      messageKey: 'alerts.quorumLost',
      params: { online: nodes.filter((n) => n.online).length, total: nodes.length },
    });
  }
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
      cpuPct: round1(vmCpuPct(v)),
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
      // LXC : cpu est un % d'allocation → converti en unités de cœur avant la somme
      used.set(name, (used.get(name) ?? 0) + vmCpuCores(v));
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

/**
 * % d'allocation CPU d'une VM. Les échelles PVE diffèrent selon le type :
 *  - QEMU : `cpu` en unités de CŒUR (1.0 = 100 % d'UN cœur) → ÷ cpuAlloc × 100.
 *  - LXC  : `cpu` en FRACTION 0–1 de l'allocation (0.08 = 8 % des cœurs alloués)
 *           → × 100 (même nature que le CPU nœud, abstrait du nb de cœurs).
 * Vérifié : LXC à 8.5 % (top interne) → cpu(field) ≈ 0.08, RRD cpu ≈ 0.08 (= 8 %).
 */
function vmCpuPct(v: { type: string; cpu?: number | null; cpuAlloc?: number }): number {
  if (v.type === 'lxc') return (v.cpu ?? 0) * 100;
  return v.cpuAlloc ? ((v.cpu ?? 0) / v.cpuAlloc) * 100 : 0;
}

/** Usage CPU d'une VM en unités de cœur (pour les sommes/pools) : % d'allocation × cœurs / 100. */
function vmCpuCores(v: { type: string; cpu?: number | null; cpuAlloc?: number }): number {
  return (vmCpuPct(v) * (v.cpuAlloc ?? 0)) / 100;
}
