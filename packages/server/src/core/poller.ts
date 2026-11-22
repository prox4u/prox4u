import {
  buildForecast,
  buildStorageVolumes,
  computeHealthScore,
  computePra,
  deriveQdeviceState,
  qdeviceStateFromCorosync,
  runAudit,
  usageSeverity,
  type AgentFsUsage,
  type Alert,
  type AuditBond,
  type AuditBridge,
  type AuditFailedUnit,
  type AuditRebootPending,
  type AuditReplication,
  type AuditScore,
  type AuditSecurityUpdates,
  type AuditSmartDisk,
  type AuditZfsArc,
  type DashboardSnapshot,
  type EndpointSnapshot,
  type KpiSummary,
  type MultiDashboardSnapshot,
  type NodeHealth,
  type PoolAggregate,
  type PraReport,
  type PveNodeStatus,
  type PveVmResource,
  type QdeviceState,
  type QuorumDetail,
  type QuorumState,
  type Site,
  type StorageDiskAlloc,
  type StorageVolume,
  type TopConsumer,
} from '@prox4u/shared';
import { reloadOvercommitConfig, reloadTunableConfigs, type AppConfig } from './config.js';
import type { DataSource } from './data-source.js';
import { AGENT_CONCURRENCY, mapLimit } from './prox4u-client.js';
import { buildLine, type InfluxClient } from './influx.js';
import type { WsHub } from './ws-hub.js';
import type { AuthContext } from '../modules/auth/runtime.js';
import type { UserConfigStore } from '../modules/userconfig/store.js';

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
  /** runtime d'authentification (store data/auth.json, sessions, provider, journal d'audit) */
  auth: AuthContext;
  /** personnalisation d'interface par user (data/user-configs/<userId>.json) */
  userConfig: UserConfigStore;
  /** hub WebSocket (broadcast snapshots + messages ponctuels) */
  hub: WsHub;
}

const DAY_MS = 86_400_000;

/** TTL du cache réseau (ponts + bonds) pour l'audit — topologie quasi statique. */
const AUDIT_NETWORK_TTL_MS = 5 * 60 * 1000;
/** TTL du cache réplication pour l'audit (check `replication_state`). */
const AUDIT_REPLICATION_TTL_MS = 5 * 60 * 1000;
/** TTL du cache ZFS ARC pour l'audit (check `zfs_arc_max`) — quasi statique. */
const AUDIT_ZFSARC_TTL_MS = 5 * 60 * 1000;
/** TTL du cache SMART pour l'audit (checks `disk_errors`/`disk_service_life`). */
const AUDIT_SMART_TTL_MS = 5 * 60 * 1000;
/** TTL du cache unités systemd pour l'audit (check `failed_units`). */
const AUDIT_UNITS_TTL_MS = 5 * 60 * 1000;
/** TTL du cache reboot en attente pour l'audit (check `pending_reboot`). */
const AUDIT_REBOOT_TTL_MS = 5 * 60 * 1000;
/** TTL du cache mises à jour sécurité pour l'audit (check `security_updates`). */
const AUDIT_UPDATES_TTL_MS = 5 * 60 * 1000;
/**
 * TTL du réchauffage des snapshots (check `stuck_snapshots`) : les appels API
 * (un par VM) ne se font qu'une fois par heure par VM, en background.
 */
const AUDIT_SNAPSHOT_TTL_MS = 60 * 60 * 1000;

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
  /**
   * Âge du snapshot le plus vieux par vmid (jours), mis à jour par le réchauffage
   * background (check `stuck_snapshots`). `ageDays=null` = pas de snapshot.
   * Absence d'entrée = inconnu (1ers ticks) → le check ne produit pas de constat.
   */
  snapshotAge: Map<number, { at: number; ageDays: number | null }>;
  /**
   * Données brutes du dernier poll RÉUSSI (nœuds + VMs) — conservées pour le
   * PRA global cross-endpoints (tick) : un endpoint down garde son dernier état
   * connu (nœuds offline, VMs figées) au lieu de disparaître du calcul global.
   */
  lastNodes: PveNodeStatus[];
  lastVms: PveVmResource[];
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
  /**
   * Guard single-flight du réchauffage des snapshots (check `stuck_snapshots`), par
   * endpoint. Le TTL de 1 h (SNAPSHOT_TTL_MS) est vérifié par VM dans l'état : les
   * vrais appels API ne se font qu'une fois par heure par VM, en background.
   */
  private snapshotRefreshing = new Set<string>();
  /**
   * Détail du quorum corosync (table Telegraf `quorum_detail`) par endpoint —
   * cache 30 s (donnée quasi statique, écrite toutes les 10 s par Telegraf).
   * `detail=null` est aussi mis en cache : pas de Qdevice / agent non déployé,
   * on ne martèle pas InfluxDB à chaque tick.
   */
  private quorumDetailCache = new Map<string, { at: number; detail: QuorumDetail | null }>();
  /**
   * Réseau par nœud pour l'audit (checks `bridge_without_ports` + `bond_members`) —
   * cache 5 min par endpoint : la topologie réseau est quasi statique, inutile de
   * rappeler getNetwork() à chaque tick de 5 s. `[]` (échec) est aussi mis en cache.
   */
  private networkCache = new Map<string, { at: number; bridges: AuditBridge[]; bonds: AuditBond[] }>();
  /**
   * Statut des jobs de réplication pour l'audit (check `replication_state`) —
   * cache 5 min par endpoint. `[]` (aucun job / échec) est aussi mis en cache.
   */
  private replicationCache = new Map<string, { at: number; replications: AuditReplication[] }>();
  /**
   * ZFS ARC max par nœud pour l'audit (check `zfs_arc_max`) — cache 5 min par
   * endpoint (table Telegraf `zfs`, quasi statique). `[]` (pas de données) mis en cache.
   */
  private zfsArcCache = new Map<string, { at: number; zfsArc: AuditZfsArc[] }>();
  /**
   * SMART des disques pour l'audit (checks `disk_errors`/`disk_service_life`) —
   * cache 5 min par endpoint (table Telegraf `smart_device`). `[]` mis en cache.
   */
  private smartDiskCache = new Map<string, { at: number; smartDisks: AuditSmartDisk[] }>();
  /**
   * Unités systemd en échec pour l'audit (check `failed_units`) — cache 5 min
   * par endpoint (table Telegraf `systemd_units`). `[]` mis en cache.
   */
  private failedUnitCache = new Map<string, { at: number; failedUnits: AuditFailedUnit[] }>();
  /**
   * Nœuds avec reboot en attente pour l'audit (check `pending_reboot`) — cache
   * 5 min par endpoint (table Telegraf `reboot_pending`). `[]` mis en cache.
   */
  private rebootCache = new Map<string, { at: number; rebootPending: AuditRebootPending[] }>();
  /**
   * Mises à jour sécurité en attente pour l'audit (check `security_updates`) —
   * cache 5 min par endpoint (table Telegraf `security_updates`). `[]` mis en cache.
   */
  private updatesCache = new Map<string, { at: number; securityUpdates: AuditSecurityUpdates[] }>();

  constructor(
    private ctx: AppContext,
    private hub: WsHub,
    private intervalMs = 5_000,
  ) {
    for (const rt of ctx.endpoints) {
      this.states.set(rt.id, {
        rt,
        snapshot: null,
        lastError: null,
        daily: [],
        lastDayKey: null,
        agentActive: new Map(),
        snapshotAge: new Map(),
        lastNodes: [],
        lastVms: [],
      });
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
      reloadTunableConfigs(this.ctx.config, this.ctx.logger);
      const endpoints = await Promise.all([...this.states.values()].map((st) => this.pollEndpoint(st)));
      this.multi = {
        generatedAt: Date.now(),
        mock: this.ctx.config.mock,
        defaultEndpointId: this.ctx.config.defaultEndpointId,
        overcommit: this.ctx.config.overcommit,
        endpoints,
        globalPra: this.computeGlobalPra(),
      };
      this.hub.broadcast(this.multi);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * PRA GLOBAL cross-endpoints (niveau 3) : si un bâtiment/site tombe, les
   * AUTRES sites de TOUS les endpoints peuvent absorber (prérequis : stockage
   * identique d'un site à l'autre — le disque est exclu du calcul).
   *
   * Les noms de nœuds sont préfixés par l'endpoint (`clusterproxmox/ProxSite1`)
   * pour éviter les collisions de noms entre clusters ET clarifier l'origine
   * des VMs affectées. Les ids de sites sont préfixés aussi (clés uniquement —
   * le nom d'affichage, le bâtiment, reste intact).
   *
   * Un endpoint jamais pollé (pas de snapshot) est exclu : son état est inconnu.
   * Un endpoint down garde son dernier état connu (nœuds offline, VMs figées).
   * null si aucun site défini (sites.json absent/vide).
   */
  private computeGlobalPra(): PraReport | null {
    const allSites: Site[] = [];
    const allNodes: PveNodeStatus[] = [];
    const allVms: PveVmResource[] = [];
    for (const st of this.states.values()) {
      if (!st.snapshot) continue;
      const ep = st.rt.id;
      for (const s of st.rt.sites) {
        allSites.push({ ...s, id: `${ep}/${s.id}`, nodes: s.nodes.map((n) => `${ep}/${n}`) });
      }
      for (const n of st.lastNodes) allNodes.push({ ...n, node: `${ep}/${n.node}` });
      for (const v of st.lastVms) allVms.push({ ...v, node: `${ep}/${v.node}` });
    }
    if (allSites.length === 0) return null;
    return computePra(allSites, allNodes, allVms, this.ctx.config.health.thresholds);
  }

  /**
   * Ponts par nœud pour l'audit (check `bridge_without_ports`) — cache 5 min
   * (topologie quasi statique). `[]` si getNetwork() indisponible (endpoint down)
   * → le check est simplement sans objet, pas de faux positifs.
   */
  /**
   * Réseau pour l'audit (ponts + bonds) — cache 5 min par endpoint. Les deux
   * checks réseau (`bridge_without_ports`, `bond_members`) partagent le même
   * getNetwork() : un seul appel, deux vues.
   */
  private async getAuditNetwork(st: EndpointState): Promise<{ bridges: AuditBridge[]; bonds: AuditBond[] }> {
    const cached = this.networkCache.get(st.rt.id);
    if (cached && Date.now() - cached.at < AUDIT_NETWORK_TTL_MS) return { bridges: cached.bridges, bonds: cached.bonds };
    let bridges: AuditBridge[] = [];
    let bonds: AuditBond[] = [];
    try {
      const network = await st.rt.source.getNetwork();
      bridges = network.flatMap((n) => n.bridges.map((b) => ({ node: n.node, name: b.name, ports: b.ports })));
      bonds = network.flatMap((n) => n.bonds.map((b) => ({ node: n.node, name: b.name, slaves: b.slaves })));
    } catch {
      bridges = [];
      bonds = [];
    }
    this.networkCache.set(st.rt.id, { at: Date.now(), bridges, bonds });
    return { bridges, bonds };
  }

  /**
   * Statut des jobs de réplication pour l'audit (check `replication_state`) —
   * cache 5 min. L'âge (heures) est calculé ici (le check reste pur) ; le nom de
   * la VM est joint depuis /cluster/resources.
   */
  private async getAuditReplications(st: EndpointState, vms: PveVmResource[]): Promise<AuditReplication[]> {
    const cached = this.replicationCache.get(st.rt.id);
    if (cached && Date.now() - cached.at < AUDIT_REPLICATION_TTL_MS) return cached.replications;
    let replications: AuditReplication[] = [];
    try {
      const jobs = await st.rt.source.getReplicationStatus();
      const nowSec = Date.now() / 1000;
      const vmByVmid = new Map(vms.map((v) => [v.vmid, v]));
      replications = jobs.map((j) => {
        const vm = vmByVmid.get(j.vmid);
        return {
          vmid: j.vmid,
          node: vm?.node ?? '',
          name: vm?.name || `VM ${j.vmid}`,
          lastResult: j.lastResult,
          lastEndAgeHours: j.lastEndTime != null ? (nowSec - j.lastEndTime) / 3600 : null,
        };
      });
    } catch {
      replications = [];
    }
    this.replicationCache.set(st.rt.id, { at: Date.now(), replications });
    return replications;
  }

  /**
   * ZFS ARC max par nœud pour l'audit (check `zfs_arc_max`) — cache 5 min. Lit la
   * table Telegraf `zfs` (arcstats_c_max, quasi statique) sur une fenêtre de 1 h ;
   * la RAM vient du poll courant (nodeHealth). Pas de données (agent non déployé)
   * → `[]` (le check n'a rien à signaler).
   */
  private async getAuditZfsArc(st: EndpointState, nodes: NodeHealth[]): Promise<AuditZfsArc[]> {
    const cached = this.zfsArcCache.get(st.rt.id);
    if (cached && Date.now() - cached.at < AUDIT_ZFSARC_TTL_MS) return cached.zfsArc;
    const influx = this.ctx.influx;
    let zfsArc: AuditZfsArc[] = [];
    if (influx.enabled && !this.ctx.config.mock && nodes.length > 0) {
      try {
        const inList = nodes.map((n) => `'${n.node.replace(/'/g, "''")}'`).join(', ');
        const rows = await influx.querySql<Record<string, string | number | null>>(
          influx.rawDb,
          `SELECT node, max(arcstats_c_max) AS arc_max
           FROM zfs
           WHERE node IN (${inList}) AND time >= now() - INTERVAL '1 hour'
           GROUP BY node`,
        );
        const memByNode = new Map(nodes.map((n) => [n.node, n.memTotalBytes ?? 0]));
        zfsArc = rows
          .map((r) => ({ node: String(r.node), arcMaxBytes: Number(r.arc_max) || 0, memTotalBytes: memByNode.get(String(r.node)) ?? 0 }))
          .filter((z) => z.arcMaxBytes > 0 && z.memTotalBytes > 0);
      } catch (err) {
        // Table absente (agent non déployé) = état attendu → silencieux.
        const msg = (err as Error).message;
        if (!/not found/i.test(msg)) {
          this.ctx.logger.warn(`zfs (audit) : lecture InfluxDB échouée pour ${st.rt.id} (${msg})`);
        }
      }
    }
    this.zfsArcCache.set(st.rt.id, { at: Date.now(), zfsArc });
    return zfsArc;
  }

  /**
   * SMART des disques pour l'audit (checks `disk_errors`/`disk_service_life`) —
   * cache 5 min. Lit la table Telegraf `smart_device` (dernier point par
   * (node, device), fenêtre 1 h) sur les nœuds de l'endpoint. Pas de données
   * (agent non déployé) → `[]` (les checks n'ont rien à signaler).
   */
  private async getAuditSmartDisks(st: EndpointState, nodes: NodeHealth[]): Promise<AuditSmartDisk[]> {
    const cached = this.smartDiskCache.get(st.rt.id);
    if (cached && Date.now() - cached.at < AUDIT_SMART_TTL_MS) return cached.smartDisks;
    const influx = this.ctx.influx;
    let smartDisks: AuditSmartDisk[] = [];
    if (influx.enabled && !this.ctx.config.mock && nodes.length > 0) {
      try {
        const inList = nodes.map((n) => `'${n.node.replace(/'/g, "''")}'`).join(', ');
        const rows = await influx.querySql<Record<string, string | number | null>>(
          influx.rawDb,
          `SELECT node, device, model, health_ok, reallocated_sectors_count, pending_sector_count,
                  uncorrectable_sector_count, udma_crc_errors, percentage_used
           FROM smart_device
           WHERE node IN (${inList}) AND time >= now() - INTERVAL '1 hour'
           ORDER BY time DESC`,
        );
        const map = new Map<string, AuditSmartDisk>();
        for (const r of rows) {
          const key = `${r.node}/${r.device}`;
          if (map.has(key)) continue;
          map.set(key, {
            node: String(r.node ?? ''),
            device: String(r.device ?? ''),
            model: (r.model as string) ?? null,
            // NULL (pas de SMART : disque virtuel / RAID) → null (inconnu), pas false.
            healthOk: r.health_ok == null ? null : Boolean(r.health_ok),
            reallocatedSectors: (r.reallocated_sectors_count as number) ?? null,
            pendingSectors: (r.pending_sector_count as number) ?? null,
            uncorrectableSectors: (r.uncorrectable_sector_count as number) ?? null,
            udmaCrcErrors: (r.udma_crc_errors as number) ?? null,
            percentageUsed: (r.percentage_used as number) ?? null,
          });
        }
        smartDisks = [...map.values()];
      } catch (err) {
        // Table absente (agent non déployé) = état attendu → silencieux.
        const msg = (err as Error).message;
        if (!/not found/i.test(msg)) {
          this.ctx.logger.warn(`smart_device (audit) : lecture InfluxDB échouée pour ${st.rt.id} (${msg})`);
        }
      }
    }
    this.smartDiskCache.set(st.rt.id, { at: Date.now(), smartDisks });
    return smartDisks;
  }

  /**
   * Unités systemd en échec pour l'audit (check `failed_units`) — cache 5 min.
   * Lit la table Telegraf `systemd_units` (SEULES les vraies alertes :
   * `active='failed'` ou `load='error'` — jamais `sub='dead'`, état de repos
   * normal), dernier point par (node, name), fenêtre 1 h.
   */
  private async getAuditFailedUnits(st: EndpointState, nodes: NodeHealth[]): Promise<AuditFailedUnit[]> {
    const cached = this.failedUnitCache.get(st.rt.id);
    if (cached && Date.now() - cached.at < AUDIT_UNITS_TTL_MS) return cached.failedUnits;
    const influx = this.ctx.influx;
    let failedUnits: AuditFailedUnit[] = [];
    if (influx.enabled && !this.ctx.config.mock && nodes.length > 0) {
      try {
        const inList = nodes.map((n) => `'${n.node.replace(/'/g, "''")}'`).join(', ');
        const rows = await influx.querySql<Record<string, string | number | null>>(
          influx.rawDb,
          `SELECT node, name
           FROM systemd_units
           WHERE node IN (${inList}) AND time >= now() - INTERVAL '1 hour'
             AND (active = 'failed' OR load = 'error')
           ORDER BY time DESC`,
        );
        const map = new Map<string, AuditFailedUnit>();
        for (const r of rows) {
          const key = `${r.node}/${r.name}`;
          if (map.has(key)) continue;
          map.set(key, { node: String(r.node ?? ''), name: String(r.name ?? '') });
        }
        failedUnits = [...map.values()];
      } catch (err) {
        const msg = (err as Error).message;
        if (!/not found/i.test(msg)) {
          this.ctx.logger.warn(`systemd_units (audit) : lecture InfluxDB échouée pour ${st.rt.id} (${msg})`);
        }
      }
    }
    this.failedUnitCache.set(st.rt.id, { at: Date.now(), failedUnits });
    return failedUnits;
  }

  /**
   * Nœuds avec un redémarrage en attente pour l'audit (check `pending_reboot`) —
   * cache 5 min. Lit la table Telegraf `reboot_pending` (script exec,
   * `pending=1` si /var/run/reboot-required existe), dernier point par nœud,
   * fenêtre 1 h. Ne renvoie QUE les nœuds en attente.
   */
  private async getAuditReboot(st: EndpointState, nodes: NodeHealth[]): Promise<AuditRebootPending[]> {
    const cached = this.rebootCache.get(st.rt.id);
    if (cached && Date.now() - cached.at < AUDIT_REBOOT_TTL_MS) return cached.rebootPending;
    const influx = this.ctx.influx;
    let rebootPending: AuditRebootPending[] = [];
    if (influx.enabled && !this.ctx.config.mock && nodes.length > 0) {
      try {
        const inList = nodes.map((n) => `'${n.node.replace(/'/g, "''")}'`).join(', ');
        const rows = await influx.querySql<Record<string, string | number | null>>(
          influx.rawDb,
          `SELECT node, pending
           FROM reboot_pending
           WHERE node IN (${inList}) AND time >= now() - INTERVAL '1 hour'
           ORDER BY time DESC`,
        );
        const map = new Map<string, number>();
        for (const r of rows) {
          const key = String(r.node ?? '');
          if (map.has(key)) continue;
          map.set(key, Number(r.pending) || 0);
        }
        rebootPending = [...map.entries()].filter(([, p]) => p === 1).map(([node]) => ({ node }));
      } catch (err) {
        const msg = (err as Error).message;
        if (!/not found/i.test(msg)) {
          this.ctx.logger.warn(`reboot_pending (audit) : lecture InfluxDB échouée pour ${st.rt.id} (${msg})`);
        }
      }
    }
    this.rebootCache.set(st.rt.id, { at: Date.now(), rebootPending });
    return rebootPending;
  }

  /**
   * Mises à jour de sécurité en attente pour l'audit (check `security_updates`)
   * — cache 5 min. Lit la table Telegraf `security_updates` (script exec,
   * `updates` = nb de paquets de sécurité en attente), dernier point par nœud,
   * fenêtre 1 h.
   */
  private async getAuditUpdates(st: EndpointState, nodes: NodeHealth[]): Promise<AuditSecurityUpdates[]> {
    const cached = this.updatesCache.get(st.rt.id);
    if (cached && Date.now() - cached.at < AUDIT_UPDATES_TTL_MS) return cached.securityUpdates;
    const influx = this.ctx.influx;
    let securityUpdates: AuditSecurityUpdates[] = [];
    if (influx.enabled && !this.ctx.config.mock && nodes.length > 0) {
      try {
        const inList = nodes.map((n) => `'${n.node.replace(/'/g, "''")}'`).join(', ');
        const rows = await influx.querySql<Record<string, string | number | null>>(
          influx.rawDb,
          `SELECT node, updates
           FROM security_updates
           WHERE node IN (${inList}) AND time >= now() - INTERVAL '1 hour'
           ORDER BY time DESC`,
        );
        const map = new Map<string, number>();
        for (const r of rows) {
          const key = String(r.node ?? '');
          if (map.has(key)) continue;
          map.set(key, Number(r.updates) || 0);
        }
        securityUpdates = [...map.entries()].map(([node, count]) => ({ node, count }));
      } catch (err) {
        const msg = (err as Error).message;
        if (!/not found/i.test(msg)) {
          this.ctx.logger.warn(`security_updates (audit) : lecture InfluxDB échouée pour ${st.rt.id} (${msg})`);
        }
      }
    }
    this.updatesCache.set(st.rt.id, { at: Date.now(), securityUpdates });
    return securityUpdates;
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

      // Réchauffage BACKGROUND des snapshots (check `stuck_snapshots`, TTL 1 h) —
      // un appel API par VM, une fois par heure, hors du tick.
      void this.refreshSnapshotData(rt, vms);

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

      const pra = computePra(rt.sites, nodes, vms, this.ctx.config.health.thresholds);
      // État RÉEL du Qdevice (corosync, table Telegraf quorum_detail) — prime
      // sur la déduction API (l'API PVE ne l'expose pas). null si agent non
      // déployé / pas de données → repli sur la déduction.
      const quorumDetail = await this.readQuorumDetail(rt, nodes.map((n) => n.node));
      const clusterInfo = {
        name: rt.name,
        nodesOnline: online.length,
        nodesTotal: nodes.length,
        quorum: cluster.quorum,
        quorumState: cluster.quorumState,
        // Qdevice : état réel corosync si dispo ('up'/'down'/'absent'), sinon
        // déduit de l'API ('up' quand les nœuds seuls ne suffisent pas mais le
        // cluster est quorate, 'down' sinon, 'unknown' quand les nœuds suffisent).
        qdevice: quorumDetail
          ? qdeviceStateFromCorosync(quorumDetail.hasQdevice, quorumDetail.qdeviceOnline)
          : deriveQdeviceState(nodes.length, online.length, cluster.quorumState),
        quorumDetail,
      };
      const alerts = buildAlerts(nodeHealth, kpis, pra, clusterInfo);
      const health = computeHealthScore(nodeHealth, kpis, pra, clusterInfo, this.ctx.config.health);

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
        // Audit / best-practices (config, cache 1 h) — absents si config inconnue.
        unprivileged: v.unprivileged,
        cpuHost: v.cpuHost,
        autostart: v.autostart,
        // null = pas de snapshot ou inconnu (1ers ticks, avant le réchauffage) — le
        // check `stuck_snapshots` ne produit pas de constat sur null.
        oldestSnapshotAgeDays: st.snapshotAge.get(v.vmid)?.ageDays ?? null,
      }));

      // Audit / best-practices (P3) — 2ᵉ score de CONFIGURATION. Checks purs
      // (shared/audit.ts) ; réseau (ponts+bonds) cache 5 min, réplication cache
      // 5 min, ZFS ARC cache 5 min (table Telegraf), snapshots réchauffés 1 h.
      const { bridges, bonds } = await this.getAuditNetwork(st);
      const [replications, zfsArc, smartDisks, failedUnits, rebootPending, securityUpdates] = await Promise.all([
        this.getAuditReplications(st, vms),
        this.getAuditZfsArc(st, nodeHealth),
        this.getAuditSmartDisks(st, nodeHealth),
        this.getAuditFailedUnits(st, nodeHealth),
        this.getAuditReboot(st, nodeHealth),
        this.getAuditUpdates(st, nodeHealth),
      ]);
      const audit: AuditScore = runAudit({
        endpointId: rt.id,
        nodes: nodeHealth,
        vms: vmSummaries,
        storages: storageInfos,
        storageVolumes,
        bridges,
        bonds,
        replications,
        zfsArc,
        smartDisks,
        failedUnits,
        rebootPending,
        securityUpdates,
        overcommit: this.ctx.config.overcommit,
        config: this.ctx.config.audit,
      });

      const snap: DashboardSnapshot = {
        generatedAt: Date.now(),
        mock: rt.source.isMock,
        cluster: clusterInfo,
        sites: rt.sites,
        health,
        audit,
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
      // Données brutes du poll réussi — servent au PRA global cross-endpoints
      // (tick) : un endpoint down conserve son dernier état connu.
      st.lastNodes = nodes;
      st.lastVms = vms;
      // Failover : si l'API a été servie par un autre nœud que l'URL configurée,
      // on l'expose (transparence) — le nœud endpoint est down, l'app bascule.
      const apiVia = rt.source.activeUrl && rt.source.activeUrl !== rt.url ? rt.source.activeUrl : undefined;
      // Séries par datastore = toutes les vues à capacité (VG compris) — pas la liste dédoublonnée.
      await this.writeInflux(rt.id, rt.source, nodes, nodeHealth, vms, kpis, storagesForMetrics);
      return { id: rt.id, name: rt.name, url: rt.url, ok: true, apiVia, snapshot: snap };
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

  /**
   * Réchauffe en background l'âge du snapshot le plus vieux par VM (check
   * `stuck_snapshots`). Single-flight par endpoint + concurrence bornée à
   * AGENT_CONCURRENCY. Le TTL de 1 h (vérifié par VM dans l'état) fait que les
   * vrais appels API (un par VM) ne se font qu'une fois par heure par VM — le
   * tick de 5 s ne déclenche rien tant que le cache est frais.
   */
  private async refreshSnapshotData(rt: EndpointRuntime, vms: PveVmResource[]): Promise<void> {
    if (this.snapshotRefreshing.has(rt.id)) return;
    this.snapshotRefreshing.add(rt.id);
    try {
      const st = this.states.get(rt.id)!;
      const now = Date.now();
      const targets = vms.filter((v) => !v.template);
      await mapLimit(targets, AGENT_CONCURRENCY, async (v) => {
        const cached = st.snapshotAge.get(v.vmid);
        if (cached && now - cached.at < AUDIT_SNAPSHOT_TTL_MS) return; // frais
        const snaps = await rt.source.getVmSnapshots(v.node, v.vmid, v.type);
        // snapshot le plus vieux = min(snaptime) ; null si aucun snapshot.
        let oldest: number | null = null;
        for (const s of snaps) {
          if (s.time != null && (oldest == null || s.time < oldest)) oldest = s.time;
        }
        const ageDays = oldest != null ? (now / 1000 - oldest) / 86400 : null;
        st.snapshotAge.set(v.vmid, { at: now, ageDays });
      });
      // purge des VMs disparues (supprimées / migrées)
      const current = new Set(targets.map((v) => v.vmid));
      for (const vmid of st.snapshotAge.keys()) if (!current.has(vmid)) st.snapshotAge.delete(vmid);
    } finally {
      this.snapshotRefreshing.delete(rt.id);
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
   * Détail du quorum corosync (état réel du Qdevice + votes) — lu depuis la
   * table Telegraf `quorum_detail` (base raw, écrite par le script
   * `prox4u-telegraf-quorum.sh` qui parse `pvecm status`). Cache 30 s par
   * endpoint (donnée quasi statique). Renvoie null si InfluxDB désactivé,
   * agent non déployé, ou pas de données récentes → le poller replie sur la
   * déduction API (`deriveQdeviceState`).
   *
   * Fenêtre 10 min : les points Telegraf arrivent toutes les 10 s ; au-delà,
   * l'agent est considéré muet (nœud arrêté / Telegraf arrêté).
   */
  private async readQuorumDetail(rt: EndpointRuntime, nodeNames: string[]): Promise<QuorumDetail | null> {
    const influx = this.ctx.influx;
    if (!influx.enabled || this.ctx.config.mock || nodeNames.length === 0) return null;
    const now = Date.now();
    const cached = this.quorumDetailCache.get(rt.id);
    if (cached && now - cached.at < 30_000) return cached.detail;

    let detail: QuorumDetail | null = null;
    try {
      const inList = nodeNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
      const rows = await influx.querySql<Record<string, string | number | null>>(
        influx.rawDb,
        `SELECT expected_votes, total_votes, quorum_threshold, quorate, has_qdevice, qdevice_online
         FROM quorum_detail
         WHERE node IN (${inList}) AND time >= now() - INTERVAL '10 minutes'
         ORDER BY time DESC
         LIMIT 1`,
      );
      const r = rows[0];
      if (r) {
        detail = {
          expectedVotes: Number(r.expected_votes) || 0,
          totalVotes: Number(r.total_votes) || 0,
          quorumThreshold: Number(r.quorum_threshold) || 0,
          quorate: Number(r.quorate) === 1,
          hasQdevice: Number(r.has_qdevice) === 1,
          qdeviceOnline: Number(r.qdevice_online) === 1,
        };
      }
    } catch (err) {
      // Table absente (agent Telegraf non déployé) = état attendu → silencieux.
      // Autre erreur (InfluxDB injoignable, timeout) → warning. Dans les deux
      // cas on garde le dernier détail connu (ou null) : la déduction API reste
      // le repli.
      const msg = (err as Error).message;
      if (!/not found/i.test(msg)) {
        this.ctx.logger.warn(`quorum_detail : lecture InfluxDB échouée pour ${rt.id} (${msg})`);
      }
      if (cached) detail = cached.detail;
    }
    this.quorumDetailCache.set(rt.id, { at: now, detail });
    return detail;
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
  cluster?: { quorumState: QuorumState | null; qdevice?: QdeviceState },
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
  // Qdevice configuré mais hors ligne : le quorum n'est plus protégé (si un
  // nœud tombe ensuite, le quorum est perdu). 'warn' — pas d'incident immédiat
  // tant que le quorum tient, mais risque concret.
  if (cluster?.qdevice === 'down') {
    alerts.push({ id: 'qdevice-down', severity: 'warn', messageKey: 'alerts.qdeviceDown' });
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
