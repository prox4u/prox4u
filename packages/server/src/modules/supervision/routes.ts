import type { FastifyInstance } from 'fastify';
import {
  buildDatastoreForecast,
  buildTopology,
  matchAgentNetsByMac,
  primaryAgentIp,
  type DatastoreHistoryResponse,
  type DatastorePoint,
  type DatastoreRange,
  type NetworkTopology,
  type ParsedVmNet,
  type PveVmResource,
  type StorageInventoryEndpoint,
  type StorageVmRef,
  type TopologyVm,
  type VmAgentNetIf,
} from '@prox4u/shared';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';
import { influxTsToUnix, type SqlRow } from '../../core/influx.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

/**
 * Supervision — phase 1B.
 * Topologie réseau auto-découverte : NICs/ponts par nœud (GET /nodes/{n}/network),
 * VM→pont via `bridge=` des interfaces netN / mpN de la config, switches physiques inférés
 * (même nom de pont + même sous-réseau = même switch — builder pur testé dans shared).
 */
export function registerSupervision(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  const topoCache = new Map<string, CacheEntry<NetworkTopology>>();
  const storageCache = new Map<string, CacheEntry<StorageInventoryEndpoint>>();
  const historyCache = new Map<string, CacheEntry<DatastoreHistoryResponse>>();

  /** Topologie de tous les endpoints (cache 5 min par endpoint). */
  app.get('/api/network-topology', async () => {
    const topologies: NetworkTopology[] = [];
    for (const ep of ctx.endpoints) {
      const cached = topoCache.get(ep.id);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        topologies.push(cached.value);
        continue;
      }
      try {
        const value = await computeTopology(ep);
        topoCache.set(ep.id, { at: Date.now(), value });
        topologies.push(value);
      } catch (err) {
        // Dégradation : cache périmé plutôt que rien ; sinon l'endpoint est omis.
        if (cached) topologies.push(cached.value);
        else ctx.logger.warn(`network-topology: endpoint ${ep.id} indisponible : ${(err as Error).message}`);
      }
    }
    return { topologies };
  });

  /**
   * Inventaire stockage → VMs (hypervision, vue type vCenter). Renvoie par endpoint
   * les datastores (capacité, type, nœuds, contenus) et les VMs avec leur champ
   * `storage` (datastore du disque). Le groupement VM→datastore et les agrégats
   * sont calculés côté client (fonctions pures shared/storage-inventory).
   */
  app.get('/api/storage-inventory', async () => {
    const endpoints: StorageInventoryEndpoint[] = [];
    for (const ep of ctx.endpoints) {
      const cached = storageCache.get(ep.id);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        endpoints.push(cached.value);
        continue;
      }
      try {
        const value = await computeStorageInventory(ep);
        storageCache.set(ep.id, { at: Date.now(), value });
        endpoints.push(value);
      } catch (err) {
        if (cached) endpoints.push(cached.value);
        else ctx.logger.warn(`storage-inventory: endpoint ${ep.id} indisponible : ${(err as Error).message}`);
      }
    }
    return { endpoints };
  });

  /**
   * Historique + capacity planning par datastore (vue stockage). Renvoie pour
   * chaque datastore de l'endpoint la série temporelle d'occupation (utilisé/total)
   * et la prévision de saturation (jours avant 80/90 %, pente, projection 30 j).
   * Données issues de la mesure InfluxDB `datastore_metrics` (enregistrée par le
   * poller). Vide si InfluxDB indisponible ou si moins de 7 j d'historique.
   */
  app.get('/api/storage-datastore-history', async (req) => {
    const q = req.query as { endpoint?: string; range?: string };
    const epId = q.endpoint ?? ctx.config.defaultEndpointId;
    const range: DatastoreRange = q.range === 'month' ? 'month' : 'year';
    const ep = ctx.endpoints.find((x) => x.id === epId);
    if (!ep) return { endpointId: epId, range, datastores: [] };
    const cacheKey = `${ep.id}:${range}`;
    const cached = historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await computeDatastoreHistory(ctx, ep, range);
    historyCache.set(cacheKey, { at: Date.now(), value });
    return value;
  });
}

/**
 * Historique d'occupation par datastore d'un endpoint.
 *
 * Source primaire : la mesure InfluxDB `datastore_metrics` — l'usage **réel**
 * de chaque datastore (lvmthin via /disks/lvmthin, lvm via /disks/lvm, dir via
 * rootfs), enregistré par le poller à chaque tick. C'est l'occupation exacte
 * (tous les disques VMs confondus, QEMU + LXC), pas un proxy.
 *
 * Backup : tant qu'InfluxDB n'a pas ≥ 7 jours d'historique, on retombe sur les
 * **RRD disque des VMs** (rrdtool, rétention ~1 an) — somme de l'usage disque des
 * VMs stockées sur chaque datastore. C'est un proxy (sous-estime les QEMU dont
 * l'usage RRD lit 0), d'où la priorité à InfluxDB dès qu'il est suffisant.
 *
 * `range` : 'year' (défaut, toute la rétention) ou 'month' (31 j).
 */
async function computeDatastoreHistory(
  ctx: AppContext,
  ep: EndpointRuntime,
  range: DatastoreRange,
): Promise<DatastoreHistoryResponse> {
  const empty: DatastoreHistoryResponse = { endpointId: ep.id, range, datastores: [] };
  // 1) InfluxDB (usage réel) — prioritaire dès qu'il a ≥ 7 jours.
  if (ctx.influx.enabled) {
    try {
      const fromInflux = await influxDatastoreHistory(ctx, ep, range);
      if (fromInflux.datastores.some((d) => distinctDays(d.points) >= MIN_HISTORY_DAYS)) return fromInflux;
    } catch (err) {
      ctx.logger.warn(`storage-datastore-history(${ep.id}) : InfluxDB indisponible → backup RRD (${(err as Error).message})`);
    }
  }
  // 2) Backup RRD (1 an, proxy) — tant qu'InfluxDB est insuffisant.
  const fromRrd = await rrdDatastoreHistory(ctx, ep, range);
  return fromRrd.datastores.length > 0 ? fromRrd : empty;
}

/** Seuil d'historique (jours distincts) en dessous duquel on bascule sur le backup RRD. */
const MIN_HISTORY_DAYS = 7;

/** Nombre de jours distincts couverts par une série de points. */
function distinctDays(points: DatastorePoint[]): number {
  const days = new Set<number>();
  for (const p of points) days.add(p.time - (p.time % 86_400));
  return days.size;
}

/** Historique par datastore depuis InfluxDB `datastore_metrics` (usage réel). */
async function influxDatastoreHistory(
  ctx: AppContext,
  ep: EndpointRuntime,
  range: DatastoreRange,
): Promise<DatastoreHistoryResponse> {
  const window = range === 'month' ? '31 days' : '365 days';
  // Les DEUX buckets InfluxDB :
  //  - raw (rétention 31 j) : haute résolution (un point par tick du poller)
  //  - infini (consolidated) : buckets 5 min, rétention illimitée (historique long terme)
  // On fusionne les deux et on dédoublonne par horodatage (raw prime, plus fin).
  const [rawRows, aggRows] = await Promise.all([
    ctx.influx.querySql<SqlRow>(
      ctx.influx.rawDb,
      `SELECT "storage", time, used_bytes, total_bytes
       FROM datastore_metrics
       WHERE time >= now() - INTERVAL '${window}' AND ${clusterFilter(ctx, ep.id)}
       ORDER BY time`,
    ),
    ctx.influx.querySql<SqlRow>(
      ctx.influx.aggDb,
      `SELECT "storage", time, used_bytes, total_bytes
       FROM datastore_metrics
       WHERE time >= now() - INTERVAL '${window}' AND ${clusterFilter(ctx, ep.id)}
       ORDER BY time`,
    ),
  ]);
  // Par (storage, time) : le point raw (fin) prime sur le point consolidé (5 min).
  const byKey = new Map<string, { storage: string; point: DatastorePoint }>();
  const add = (r: SqlRow, raw: boolean) => {
    const storage = String(r.storage ?? '');
    const total = Number(r.total_bytes ?? 0);
    if (!storage || total <= 0) return;
    const time = influxTsToUnix(r.time);
    const key = `${storage}@${time}`;
    const existing = byKey.get(key);
    // raw remplace consolidé ; consolidé n'écrase pas un point raw déjà présent.
    if (existing && raw === false) return;
    byKey.set(key, { storage, point: { time, used: Number(r.used_bytes ?? 0), total } });
  };
  for (const r of aggRows) add(r, false);
  for (const r of rawRows) add(r, true);
  const byStorage = new Map<string, { total: number; points: DatastorePoint[] }>();
  for (const { storage, point } of byKey.values()) {
    const e = byStorage.get(storage) ?? { total: point.total, points: [] };
    e.points.push(point);
    byStorage.set(storage, e);
  }
  const datastores = [...byStorage.entries()].map(([storage, { total, points }]) => {
    points.sort((a, b) => a.time - b.time);
    return { storage, totalBytes: total, points, forecast: buildDatastoreForecast(points) };
  });
  datastores.sort((a, b) => a.storage.localeCompare(b.storage));
  return { endpointId: ep.id, range, datastores };
}

/**
 * Backup RRD : somme de l'usage disque (RRD `disk`) des VMs stockées sur chaque
 * datastore, sur la rétention RRD (~1 an). Proxy de l'occupation — sous-estime
 * les QEMU (usage RRD = 0). `range` pilote la résolution (year=hebdo, month=jour).
 */
async function rrdDatastoreHistory(
  ctx: AppContext,
  ep: EndpointRuntime,
  range: DatastoreRange,
): Promise<DatastoreHistoryResponse> {
  const timeframe = range === 'month' ? 'month' : 'year';
  const empty: DatastoreHistoryResponse = { endpointId: ep.id, range, datastores: [] };
  try {
    const [storages, resources] = await Promise.all([ep.source.getStorage(), ep.source.getResources()]);
    // VMs groupées par datastore — multi-disque : chaque disque est attribué à son datastore.
    const vmsByStorage = new Map<string, PveVmResource[]>();
    for (const r of resources) {
      if (r.template) continue;
      if (r.disks && r.disks.length > 0) {
        for (const d of r.disks) {
          const arr = vmsByStorage.get(d.storage) ?? [];
          arr.push(r);
          vmsByStorage.set(d.storage, arr);
        }
      } else if (r.storage) {
        const arr = vmsByStorage.get(r.storage) ?? [];
        arr.push(r);
        vmsByStorage.set(r.storage, arr);
      }
    }
    // On parcourt TOUS les datastores (pas seulement ceux avec VMs) : un
    // datastore dir (ISOs/backups) n'a aucune VM donc aucun RRD disque, mais un
    // usage réel connu → on lui synthétise une ligne plate à cet usage.
    const datastores: DatastoreHistoryResponse['datastores'] = [];
    const now = Math.floor(Date.now() / 1000);
    const daySec = 86_400;
    const days = range === 'month' ? 31 : 365;
    for (const s of storages) {
      const storage = s.storage;
      const total = s.total ?? 0;
      const realUsed = s.used ?? 0;
      if (total <= 0 && realUsed <= 0) continue; // datastore sans capacité connue → ignoré
      const vms = vmsByStorage.get(storage) ?? [];
      let points: DatastorePoint[];
      if (vms.length > 0) {
        // Une VM peut apparaître plusieurs fois (multi-disque même datastore) → dédoublonner.
        const unique = [...new Map(vms.map((v) => [`${v.node}/${v.vmid}`, v])).values()];
        const rrds = await mapLimitCollect(unique, 5, (v) => ep.source.getRrddata('vm', v.node, v.vmid, timeframe, v.type));
        const byTime = new Map<number, number>();
        for (const rrd of rrds) for (const p of rrd) if (p.disk !== null) byTime.set(p.time, (byTime.get(p.time) ?? 0) + p.disk);
        // Le RRD sous-estime les QEMU (disk = 0). Si la somme RRD est ~0 mais que
        // le datastore a un usage réel connu, on affiche une ligne plate à l'usage
        // réel plutôt qu'une courbe trompeuse à 0 %. Dès que InfluxDB a ≥ 7 j, on
        // bascule sur l'usage réel historique (plus besoin de ce repli).
        const maxRrd = byTime.size > 0 ? Math.max(...byTime.values()) : 0;
        const rrdBlind = total > 0 && maxRrd <= total * 0.001 && realUsed > 0;
        if (byTime.size > 0) {
          points = [...byTime.entries()].map(([time, used]) => ({ time, used: rrdBlind ? realUsed : used, total }));
        } else {
          // VMs sans RRD disque (trop récentes) → ligne plate à l'usage réel (0 % si vide).
          points = flatSeries(now, days, daySec, realUsed, total);
        }
      } else {
        // Datastore SANS VM (dir ISOs/backups) ou VIDE : pas de RRD → ligne plate à
        // l'usage réel (0 % si vide). Toujours une courbe, jamais « aucun historique ».
        points = flatSeries(now, days, daySec, realUsed, total);
      }
      if (points.length > 0) {
        datastores.push({ storage, totalBytes: total, points, forecast: buildDatastoreForecast(points) });
      }
    }
    datastores.sort((a, b) => a.storage.localeCompare(b.storage));
    return { endpointId: ep.id, range, datastores };
  } catch (err) {
    ctx.logger.warn(`storage-datastore-history(${ep.id}) : backup RRD en échec : ${(err as Error).message}`);
    return empty;
  }
}

/**
 * Série temporelle plate à un niveau d'usage constant — repli quand il n'y a
 * pas d'historique mesurable (datastore sans VM, VMs sans RRD). Donne au moins
 * une courbe + un forecast « stable » au lieu de « aucun historique ».
 */
function flatSeries(now: number, days: number, daySec: number, used: number, total: number): DatastorePoint[] {
  return Array.from({ length: days }, (_, i) => ({
    time: now - (days - 1 - i) * daySec,
    used,
    total,
  }));
}

/** map avec concurrence limitée, collecte les résultats. */
async function mapLimitCollect<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Filtre SQL « cluster = endpoint » (le tag est absent avant le 1er tick). */
function clusterFilter(ctx: AppContext, epId: string): string {
  return `COALESCE(cluster, '${ctx.config.defaultEndpointId}') = '${epId}'`;
}

/** Datastores + VMs (avec leur datastore) d'un endpoint, depuis sa source. */
async function computeStorageInventory(ep: EndpointRuntime): Promise<StorageInventoryEndpoint> {
  const [storages, resources] = await Promise.all([ep.source.getStorage(), ep.source.getResources()]);
  const vms: StorageVmRef[] = [];
  for (const r of resources) {
    if (r.template) continue; // les templates ne sont pas des workloads
    // Multi-disque : une référence par (VM, datastore), taille = Σ des disques de
    // la VM sur ce datastore (config `size=`). Une VM à disques sur N datastores
    // apparaît donc sur N datastores.
    if (r.disks && r.disks.length > 0) {
      const byStorage = new Map<string, number>();
      for (const d of r.disks) byStorage.set(d.storage, (byStorage.get(d.storage) ?? 0) + d.sizeBytes);
      for (const [storage, sizeBytes] of byStorage) {
        vms.push({ vmid: r.vmid, name: r.name, node: r.node, status: r.status, diskBytes: sizeBytes, storage });
      }
      continue;
    }
    // Repli : disques non parsés → disque principal (storage + maxdisk).
    if (!r.storage) continue;
    vms.push({
      vmid: r.vmid,
      name: r.name,
      node: r.node,
      status: r.status,
      diskBytes: r.maxdisk ?? 0,
      storage: r.storage,
    });
  }
  return { endpointId: ep.id, storages, vms };
}

/**
 * Complète les interfaces de config avec les IPs live du guest agent (jointure par MAC) :
 * - `nets[].ip` ← IP primaire (IPv4 d'abord) quand la config n'en a pas ;
 * - `agentIps` ← liste complète par interface (v4 + v6), absente si aucune jointure.
 */
export function enrichVmAgentIps(
  nets: ParsedVmNet[],
  agentNets: VmAgentNetIf[],
): { nets: ParsedVmNet[]; agentIps?: Record<string, string[]> } {
  const joined = matchAgentNetsByMac(nets, agentNets);
  if (joined.size === 0) return { nets };
  const agentIps = Object.fromEntries(joined);
  return {
    nets: nets.map((n) => {
      const ips = agentIps[n.iface];
      return !n.ip && ips?.length ? { ...n, ip: primaryAgentIp(ips) ?? null } : n;
    }),
    agentIps,
  };
}

/** Assemble la topologie d'un endpoint depuis sa source (réseau nœuds + ressources VMs). */
async function computeTopology(ep: EndpointRuntime): Promise<NetworkTopology> {
  const [nodeNets, resources] = await Promise.all([ep.source.getNetwork(), ep.source.getResources()]);

  // Interfaces VM depuis la config (cache 1 h côté client — déjà chaud via le poller).
  const vms: TopologyVm[] = [];
  for (const r of resources) {
    if (r.template) continue; // les templates ne sont pas des workloads réseau
    const cfg = await ep.source.getVmConfig(r.node, r.vmid, r.type);
    const nets = cfg?.nets ?? [];

    // IPs live par interface (VM en marche : guest agent QEMU / netns LXC PVE ≥ 9 — cache 60 s dans le client).
    const enriched =
      r.status === 'running'
        ? enrichVmAgentIps(
            nets,
            r.type === 'qemu'
              ? await ep.source.getVmAgentNets(r.node, r.vmid)
              : await ep.source.getLxcInterfaces(r.node, r.vmid),
          )
        : { nets };

    vms.push({
      vmid: r.vmid,
      name: r.name,
      type: r.type,
      status: r.status,
      node: r.node,
      nets: enriched.nets,
      agentIps: enriched.agentIps,
      netInBps: r.netin,
      netOutBps: r.netout,
    });
  }

  return buildTopology({
    endpointId: ep.id,
    nodes: nodeNets.map((n) => ({
      node: n.node,
      online: n.online,
      ip: n.ip,
      nics: n.nics,
      bridges: n.bridges,
    })),
    vms,
  });
}
