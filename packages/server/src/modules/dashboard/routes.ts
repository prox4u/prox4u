import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  buildForecast,
  computeOvercommit,
  riskSeverity,
  usageSeverity,
  type CapacityForecast,
  type MetricSource,
  type MetricsPoint,
  type MetricsResponse,
  type MetricsTimeframe,
  type OsSlice,
  type OvercommitRiskResponse,
  type PveNodeStatus,
  type RrddataPoint,
  type SeverityOrNa,
  type TrendPoint,
} from '@prox4u/shared';
import { influxTsToUnix, type SqlRow } from '../../core/influx.js';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_SEC = 86_400;

const METRICS_TIMEFRAMES: MetricsTimeframe[] = ['hour', 'day', 'week', 'month'];

interface CacheEntry<T> {
  at: number;
  value: T;
}

export interface CapacityResponse {
  cpu: CapacityForecast;
  ram: CapacityForecast;
  disk: CapacityForecast;
  source: MetricSource;
}

export interface TrendsResponse {
  trend7d: TrendPoint[];
  os: OsSlice[];
  source: MetricSource;
}

/** Ligne SQL agrégée par bucket + nœud (base raw ou consolidated). */
interface NodeAggRow extends SqlRow {
  t: string | number;
  node: string;
  cpu_pct: number | null;
  ram_pct: number | null;
  disk_pct: number | null;
  /** réseau — rempli par jointure depuis node_net (voir metricsFromInflux). */
  net_in_bps: number | null;
  net_out_bps: number | null;
}

/** Ligne SQL agrégée par bucket + nœud pour le trafic réseau (mesure dédiée node_net). */
interface NetAggRow extends SqlRow {
  t: string | number;
  node: string;
  net_in_bps: number | null;
  net_out_bps: number | null;
}

/** Filtre cluster : 'all' = tous les endpoints (vue d'ensemble). */
function clusterFilterOrAll(ctx: AppContext, epId: string): string {
  return epId === 'all' ? '1=1' : clusterFilter(ctx, epId);
}

/** Bucket + fenêtre SQL par timeframe (raw ≤ 7 j, consolidated pour le mois). */
const TF_SQL: Record<MetricsTimeframe, { bucket: string; window: string; db: 'raw' | 'agg' }> = {
  hour: { bucket: '1 minute', window: '1 hour', db: 'raw' },
  day: { bucket: '5 minutes', window: '24 hours', db: 'raw' },
  week: { bucket: '1 hour', window: '7 days', db: 'raw' },
  month: { bucket: '1 day', window: '30 days', db: 'agg' },
};

/**
 * Filtre SQL par endpoint. Les lignes legacy (écrites avant l'introduction du
 * tag `cluster`) sont attribuées à l'endpoint par défaut.
 */
function clusterFilter(ctx: AppContext, epId: string): string {
  return `COALESCE(cluster, '${ctx.config.defaultEndpointId}') = '${epId}'`;
}

/** Agrège les lignes par-nœud en points cluster : moyennes %, sommes réseau. */
function aggregateNodeRows(rows: NodeAggRow[]): MetricsPoint[] {
  const byTime = new Map<
    number,
    { cpuSum: number; cpuN: number; ramSum: number; ramN: number; diskSum: number; diskN: number; netIn: number; netOut: number }
  >();
  for (const r of rows) {
    const time = influxTsToUnix(r.t);
    const e = byTime.get(time) ?? { cpuSum: 0, cpuN: 0, ramSum: 0, ramN: 0, diskSum: 0, diskN: 0, netIn: 0, netOut: 0 };
    if (typeof r.cpu_pct === 'number') {
      e.cpuSum += r.cpu_pct;
      e.cpuN += 1;
    }
    if (typeof r.ram_pct === 'number') {
      e.ramSum += r.ram_pct;
      e.ramN += 1;
    }
    if (typeof r.disk_pct === 'number') {
      e.diskSum += r.disk_pct;
      e.diskN += 1;
    }
    if (typeof r.net_in_bps === 'number') e.netIn += r.net_in_bps;
    if (typeof r.net_out_bps === 'number') e.netOut += r.net_out_bps;
    byTime.set(time, e);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, e]) => ({
      time,
      cpuPct: round1(e.cpuN ? e.cpuSum / e.cpuN : 0),
      ramPct: round1(e.ramN ? e.ramSum / e.ramN : 0),
      storagePct: round1(e.diskN ? e.diskSum / e.diskN : 0),
      netInBps: Math.round(e.netIn),
      netOutBps: Math.round(e.netOut),
    }));
}

/** Ligne SQL agrégée par bucket + endpoint pour le stockage VM (storage_metrics). */
interface StorageAggRow extends SqlRow {
  t: string | number;
  used: number | null;
  total: number | null;
}

/**
 * Usage % du stockage VM par bucket : Σ used / Σ total, pondéré par capacité
 * entre endpoints (contrairement à la moyenne non pondérée des rootfs).
 */
export function storagePctByTime(rows: StorageAggRow[]): Map<number, number> {
  const byTime = new Map<number, { used: number; total: number }>();
  for (const r of rows) {
    const time = influxTsToUnix(r.t);
    const e = byTime.get(time) ?? { used: 0, total: 0 };
    e.used += typeof r.used === 'number' ? r.used : 0;
    e.total += typeof r.total === 'number' ? r.total : 0;
    byTime.set(time, e);
  }
  const out = new Map<number, number>();
  for (const [time, s] of byTime) if (s.total > 0) out.set(time, round1((s.used / s.total) * 100));
  return out;
}

/**
 * Remplace `storagePct` des points par l'usage réel du stockage VM.
 * - bucket sans série storage_metrics → null (pas de mélange avec le rootfs) ;
 * - série absente au total (historique antérieur au déploiement) → valeurs
 *   legacy conservées pour ne pas vider le graphique.
 */
export function mergeStorageSeries(points: MetricsPoint[], rows: StorageAggRow[]): MetricsPoint[] {
  const pct = storagePctByTime(rows);
  if (pct.size === 0) return points;
  return points.map((p) => ({ ...p, storagePct: pct.get(p.time) ?? null }));
}

/** Moyenne journalière par nœud (cpu/ram/disk en %) sur une fenêtre. */
function dailyByNode(rows: NodeAggRow[]): { time: number; cpuPct: number; ramPct: number; diskPct: number }[] {
  const byDay = new Map<number, { cpu: [number, number]; ram: [number, number]; disk: [number, number] }>();
  for (const r of rows) {
    const time = influxTsToUnix(r.t);
    const e = byDay.get(time) ?? { cpu: [0, 0], ram: [0, 0], disk: [0, 0] };
    if (typeof r.cpu_pct === 'number') {
      e.cpu[0] += r.cpu_pct;
      e.cpu[1] += 1;
    }
    if (typeof r.ram_pct === 'number') {
      e.ram[0] += r.ram_pct;
      e.ram[1] += 1;
    }
    if (typeof r.disk_pct === 'number') {
      e.disk[0] += r.disk_pct;
      e.disk[1] += 1;
    }
    byDay.set(time, e);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, e]) => ({
      time,
      cpuPct: round1(e.cpu[1] ? e.cpu[0] / e.cpu[1] : 0),
      ramPct: round1(e.ram[1] ? e.ram[0] / e.ram[1] : 0),
      diskPct: round1(e.disk[1] ? e.disk[0] / e.disk[1] : 0),
    }));
}

/** InfluxDB actif pour ce contexte (réel + token configuré) ? */
function influxReady(ctx: AppContext): boolean {
  return ctx.influx.enabled && !ctx.config.mock;
}

/** Résout l'endpoint demandé (?endpoint=, défaut = endpoint par défaut). */
function resolveEndpoint(ctx: AppContext, id: string | undefined, reply: FastifyReply): EndpointRuntime | null {
  const wanted = id ?? ctx.config.defaultEndpointId;
  const ep = ctx.endpoints.find((e) => e.id === wanted);
  if (!ep) {
    reply.code(404).send({ error: `unknown endpoint: ${wanted}` });
    return null;
  }
  return ep;
}

/** Moyenne journalière d'une métrique (%) agrégée sur tous les nœuds en ligne. */
function aggregateDaily(
  series: RrddataPoint[][],
  nodes: PveNodeStatus[],
  toPct: (p: RrddataPoint, n: PveNodeStatus) => number | null,
): { time: number; value: number }[] {
  const byDay = new Map<number, { sum: number; count: number }>();
  series.forEach((points, i) => {
    const node = nodes[i];
    for (const p of points) {
      const v = toPct(p, node);
      if (v === null || !Number.isFinite(v)) continue;
      const day = Math.floor(p.time / DAY_SEC);
      const e = byDay.get(day) ?? { sum: 0, count: 0 };
      e.sum += v;
      e.count += 1;
      byDay.set(day, e);
    }
  });
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, e]) => ({ time: day * DAY_SEC, value: Math.round((e.sum / e.count) * 10) / 10 }));
}

async function computeCapacity(ctx: AppContext, poller: Poller, ep: EndpointRuntime): Promise<CapacityResponse> {
  if (influxReady(ctx)) {
    try {
      const rows = await ctx.influx.querySql<NodeAggRow>(
        ctx.influx.aggDb,
        `SELECT date_bin(INTERVAL '1 day', time) AS t, node,
                AVG(cpu_pct) AS cpu_pct, AVG(ram_pct) AS ram_pct, AVG(disk_pct) AS disk_pct
         FROM node_metrics WHERE time >= now() - INTERVAL '30 days' AND ${clusterFilter(ctx, ep.id)}
         GROUP BY t, node ORDER BY t`,
      );
      const days = dailyByNode(rows);
      if (days.length > 0) {
        // Prévision disque : stockage VM (storage_metrics, pondéré par capacité)
        // si disponible ; sinon série legacy rootfs (historique antérieur).
        let diskSeries = days.map((d) => ({ time: d.time, value: d.diskPct }));
        try {
          const srows = await ctx.influx.querySql<StorageAggRow>(
            ctx.influx.aggDb,
            `SELECT date_bin(INTERVAL '1 day', time) AS t, "cluster",
                    AVG(used_bytes) AS used, AVG(total_bytes) AS total
             FROM storage_metrics WHERE time >= now() - INTERVAL '30 days' AND ${clusterFilter(ctx, ep.id)}
             GROUP BY t, "cluster" ORDER BY t`,
          );
          const spct = storagePctByTime(srows);
          if (spct.size > 0) {
            diskSeries = days.filter((d) => spct.has(d.time)).map((d) => ({ time: d.time, value: spct.get(d.time)! }));
          }
        } catch {
          // storage_metrics indisponible → on garde la série rootfs
        }
        return {
          cpu: buildForecast('cpu', days.map((d) => ({ time: d.time, value: d.cpuPct }))),
          ram: buildForecast('ram', days.map((d) => ({ time: d.time, value: d.ramPct }))),
          disk: buildForecast('disk', diskSeries),
          source: 'influx',
        };
      }
    } catch (err) {
      ctx.logger.warn(`capacity(${ep.id}) : InfluxDB indisponible → repli RRD (${(err as Error).message})`);
    }
  }
  const nodes = (await ep.source.getNodes()).nodes.filter((n) => n.online);
  const series = await Promise.all(
    nodes.map((n) => ep.source.getRrddata('node', n.node, undefined, 'month')),
  );
  return {
    // Le `cpu` du RRD nœud est une fraction 0–1 (même échelle que le status) → ×100, pas /cpus
    cpu: buildForecast('cpu', aggregateDaily(series, nodes, (p) => (p.cpu !== null ? p.cpu * 100 : null))),
    ram: buildForecast('ram', aggregateDaily(series, nodes, (p, n) => (p.mem !== null && n.memTotal ? (p.mem / n.memTotal) * 100 : null))),
    disk: buildForecast('disk', poller.getDiskHistory(ep.id)),
    source: 'rrd',
  };
}

/**
 * Capacity planning d'un NŒUD à partir de sa série journalière (cpu/ram/disk en
 * % de la capacité du nœud). disk = rootfs du nœud (pas le stockage VM du cluster).
 * Réutilise buildForecast (shared) — même forme de réponse que le cluster.
 */
export function nodeCapacityFromDaily(
  days: { time: number; cpuPct: number; ramPct: number; diskPct: number }[],
  source: MetricSource,
): CapacityResponse {
  return {
    cpu: buildForecast('cpu', days.map((d) => ({ time: d.time, value: d.cpuPct }))),
    ram: buildForecast('ram', days.map((d) => ({ time: d.time, value: d.ramPct }))),
    disk: buildForecast('disk', days.map((d) => ({ time: d.time, value: d.diskPct }))),
    source,
  };
}

/**
 * Moyennes journalières (cpu/ram/disk en %) d'un nœud unique depuis ses points
 * RRD. cpu = fraction 0–1 → ×100 ; ram = mem/memTotal ; disk = rootfs (disk/rootfsTotal).
 */
export function nodeDailyFromRrd(
  points: RrddataPoint[],
  node: PveNodeStatus,
): { time: number; cpuPct: number; ramPct: number; diskPct: number }[] {
  const byDay = new Map<number, { cpu: [number, number]; ram: [number, number]; disk: [number, number] }>();
  for (const p of points) {
    const day = Math.floor(p.time / DAY_SEC);
    const e = byDay.get(day) ?? { cpu: [0, 0], ram: [0, 0], disk: [0, 0] };
    if (p.cpu !== null) {
      e.cpu[0] += p.cpu * 100;
      e.cpu[1] += 1;
    }
    if (p.mem !== null && node.memTotal) {
      e.ram[0] += (p.mem / node.memTotal) * 100;
      e.ram[1] += 1;
    }
    if (p.disk !== null && node.rootfsTotal) {
      e.disk[0] += (p.disk / node.rootfsTotal) * 100;
      e.disk[1] += 1;
    }
    byDay.set(day, e);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, e]) => ({
      time: day * DAY_SEC,
      cpuPct: round1(e.cpu[1] ? e.cpu[0] / e.cpu[1] : 0),
      ramPct: round1(e.ram[1] ? e.ram[0] / e.ram[1] : 0),
      diskPct: round1(e.disk[1] ? e.disk[0] / e.disk[1] : 0),
    }));
}

/**
 * Capacity planning au NIVEAU NŒUD : mêmes prévisions que le cluster mais sur la
 * série d'un seul nœud (pas d'agrégation cross-nœuds). disk = rootfs du nœud.
 * InfluxDB (node_metrics filtré sur le nœud) → repli RRD (rrddata du nœud).
 */
async function computeNodeCapacity(ctx: AppContext, ep: EndpointRuntime, nodeName: string): Promise<CapacityResponse> {
  if (influxReady(ctx)) {
    try {
      const rows = await ctx.influx.querySql<NodeAggRow>(
        ctx.influx.aggDb,
        `SELECT date_bin(INTERVAL '1 day', time) AS t, node,
                AVG(cpu_pct) AS cpu_pct, AVG(ram_pct) AS ram_pct, AVG(disk_pct) AS disk_pct
         FROM node_metrics WHERE time >= now() - INTERVAL '30 days' AND node = '${sqlQuote(nodeName)}' AND ${clusterFilter(ctx, ep.id)}
         GROUP BY t, node ORDER BY t`,
      );
      const days = dailyByNode(rows);
      if (days.length > 0) {
        return nodeCapacityFromDaily(days, 'influx');
      }
    } catch (err) {
      ctx.logger.warn(`node-capacity(${ep.id}/${nodeName}) : InfluxDB indisponible → repli RRD (${(err as Error).message})`);
    }
  }
  const nodes = (await ep.source.getNodes()).nodes.filter((n) => n.online);
  const node = nodes.find((n) => n.node === nodeName);
  if (!node) {
    return nodeCapacityFromDaily([], 'rrd');
  }
  const points = await ep.source.getRrddata('node', node.node, undefined, 'month');
  return nodeCapacityFromDaily(nodeDailyFromRrd(points, node), 'rrd');
}

async function computeTrends(ctx: AppContext, ep: EndpointRuntime): Promise<TrendsResponse> {
  let trend7d: TrendPoint[] | null = null;
  let fromInflux = false;
  if (influxReady(ctx)) {
    try {
      const rows = await ctx.influx.querySql<NodeAggRow>(
        ctx.influx.rawDb,
        `SELECT date_bin(INTERVAL '1 day', time) AS t, node,
                AVG(cpu_pct) AS cpu_pct, AVG(ram_pct) AS ram_pct
         FROM node_metrics WHERE time >= now() - INTERVAL '7 days' AND ${clusterFilter(ctx, ep.id)}
         GROUP BY t, node ORDER BY t`,
      );
      const days = dailyByNode(rows);
      if (days.length > 0) {
        trend7d = days.map((d) => ({ time: d.time, cpuPct: d.cpuPct, ramPct: d.ramPct }));
        fromInflux = true;
      }
    } catch (err) {
      ctx.logger.warn(`trends(${ep.id}) : InfluxDB indisponible → repli RRD (${(err as Error).message})`);
    }
  }
  if (!trend7d) {
    const nodes = (await ep.source.getNodes()).nodes.filter((n) => n.online);
    const series = await Promise.all(
      nodes.map((n) => ep.source.getRrddata('node', n.node, undefined, 'week')),
    );
    // cpu du RRD nœud = fraction 0–1 de la capacité → ×100 (pas /cpus)
    const cpuDays = aggregateDaily(series, nodes, (p) => (p.cpu !== null ? p.cpu * 100 : null));
    const ramDays = aggregateDaily(series, nodes, (p, n) => (p.mem !== null && n.memTotal ? (p.mem / n.memTotal) * 100 : null));
    const ramByDay = new Map(ramDays.map((d) => [d.time, d.value]));
    trend7d = cpuDays.map((d) => ({
      time: d.time,
      cpuPct: d.value,
      ramPct: ramByDay.get(d.time) ?? 0,
    }));
  }

  const vms = await ep.source.getResources();
  const byOs = new Map<string, number>();
  for (const v of vms) {
    // os inconnu (champ optionnel absent) → on retombe sur le type de VM
    const os = v.os ?? (v.type === 'lxc' ? 'LXC' : 'KVM');
    byOs.set(os, (byOs.get(os) ?? 0) + 1);
  }
  const os: OsSlice[] = [...byOs.entries()]
    .map(([os, count]) => ({ os, count }))
    .sort((a, b) => b.count - a.count);

  return { trend7d, os, source: fromInflux ? 'influx' : 'rrd' };
}

/** Échappement SQL simple pour un identifiant (nom de nœud). */
function sqlQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** Points métriques depuis InfluxDB (raw ≤ 7 j, consolidated pour le mois). */
async function metricsFromInflux(
  ctx: AppContext,
  epId: string,
  timeframe: MetricsTimeframe,
  node?: string,
): Promise<MetricsPoint[]> {
  const { bucket, window, db } = TF_SQL[timeframe];
  const dbSel = db === 'raw' ? ctx.influx.rawDb : ctx.influx.aggDb;
  const where = `WHERE time >= now() - INTERVAL '${window}' AND ${clusterFilterOrAll(ctx, epId)}${node ? ` AND node = '${sqlQuote(node)}'` : ''}`;
  // Le trafic réseau est lu depuis la mesure dédiée node_net (PVE ≥ 9 : les champs net de
  // node_metrics sont à zéro sur tout l'historique) — jointure par (bucket, nœud) avant
  // agrégation. node_net absente (installation fraîche) → réseau à zéro, pas de repli RRD.
  const [rows, netRows] = await Promise.all([
    ctx.influx.querySql<NodeAggRow>(
      dbSel,
      `SELECT date_bin(INTERVAL '${bucket}', time) AS t, node,
              AVG(cpu_pct) AS cpu_pct, AVG(ram_pct) AS ram_pct, AVG(disk_pct) AS disk_pct
       FROM node_metrics ${where}
       GROUP BY t, node ORDER BY t`,
    ),
    ctx.influx
      .querySql<NetAggRow>(
        dbSel,
        `SELECT date_bin(INTERVAL '${bucket}', time) AS t, node,
                AVG(net_in_bps) AS net_in_bps, AVG(net_out_bps) AS net_out_bps
         FROM node_net ${where}
         GROUP BY t, node ORDER BY t`,
      )
      .catch(() => [] as NetAggRow[]),
  ]);
  const netByKey = new Map(netRows.map((r) => [`${influxTsToUnix(r.t)}|${r.node}`, r]));
  for (const r of rows) {
    const n = netByKey.get(`${influxTsToUnix(r.t)}|${r.node}`);
    if (n) {
      r.net_in_bps = n.net_in_bps;
      r.net_out_bps = n.net_out_bps;
    }
  }
  let points = aggregateNodeRows(rows);
  // Série stockage VM (pondérée par capacité) — remplace la moyenne des rootfs.
  // Non applicable en vue nœud (le stockage VM est une métrique d'endpoint).
  if (!node) {
    try {
      const srows = await ctx.influx.querySql<StorageAggRow>(
        db === 'raw' ? ctx.influx.rawDb : ctx.influx.aggDb,
        `SELECT date_bin(INTERVAL '${bucket}', time) AS t, "cluster",
                AVG(used_bytes) AS used, AVG(total_bytes) AS total
         FROM storage_metrics WHERE time >= now() - INTERVAL '${window}' AND ${clusterFilterOrAll(ctx, epId)}
         GROUP BY t, "cluster" ORDER BY t`,
      );
      points = mergeStorageSeries(points, srows);
    } catch (err) {
      ctx.logger.warn(`metrics(${epId},${timeframe}) : storage_metrics indisponible → repli rootfs (${(err as Error).message})`);
    }
  }
  return points;
}

/**
 * Métriques d'un endpoint (ou de tous les endpoints : epId « all ») sur un timeframe.
 * InfluxDB en priorité (si actif), repli automatique sur les RRD Proxmox.
 * cpu/ram/storage en % (moyenne des nœuds en ligne), réseau en octets/s (somme).
 */
async function computeMetrics(
  ctx: AppContext,
  epId: string,
  timeframe: MetricsTimeframe,
  node?: string,
): Promise<MetricsResponse> {
  if (influxReady(ctx)) {
    try {
      const points = await metricsFromInflux(ctx, epId, timeframe, node);
      if (points.length > 0) return { timeframe, points, source: 'influx' };
    } catch (err) {
      ctx.logger.warn(`metrics(${epId},${timeframe}${node ? `,${node}` : ''}) : InfluxDB indisponible → repli RRD (${(err as Error).message})`);
    }
  }
  const eps = epId === 'all' ? ctx.endpoints : [ctx.endpoints.find((e) => e.id === epId)!];
  // chaque nœud est interrogé via la source de son endpoint (indispensable en mode « all »)
  const pairs: { src: EndpointRuntime['source']; node: PveNodeStatus }[] = [];
  for (const e of eps) {
    for (const n of (await e.source.getNodes()).nodes) if (n.online) pairs.push({ src: e.source, node: n });
  }
  const filtered = pairs.filter((p) => !node || p.node.node === node);
  const series = await Promise.all(
    filtered.map((p) => p.src.getRrddata('node', p.node.node, undefined, timeframe)),
  );

  interface Acc {
    cpuSum: number;
    cpuN: number;
    ramSum: number;
    ramN: number;
    diskSum: number;
    diskN: number;
    netIn: number;
    netOut: number;
  }
  const byTime = new Map<number, Acc>();
  series.forEach((points, i) => {
    const n = filtered[i].node;
    for (const p of points) {
      const e = byTime.get(p.time) ?? { cpuSum: 0, cpuN: 0, ramSum: 0, ramN: 0, diskSum: 0, diskN: 0, netIn: 0, netOut: 0 };
      if (p.cpu !== null) {
        e.cpuSum += p.cpu * 100; // fraction 0–1 du RRD nœud → ×100
        e.cpuN += 1;
      }
      if (p.mem !== null && n.memTotal) {
        e.ramSum += (p.mem / n.memTotal) * 100;
        e.ramN += 1;
      }
      if (p.disk !== null && n.rootfsTotal) {
        e.diskSum += (p.disk / n.rootfsTotal) * 100;
        e.diskN += 1;
      }
      e.netIn += p.netin ?? 0;
      e.netOut += p.netout ?? 0;
      byTime.set(p.time, e);
    }
  });

  const points: MetricsPoint[] = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, e]) => ({
      time,
      cpuPct: round1(e.cpuN ? e.cpuSum / e.cpuN : 0),
      ramPct: round1(e.ramN ? e.ramSum / e.ramN : 0),
      storagePct: round1(e.diskN ? e.diskSum / e.diskN : 0),
      netInBps: Math.round(e.netIn),
      netOutBps: Math.round(e.netOut),
    }));

  return { timeframe, points, source: 'rrd' };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** p95 par VM sur 7 jours (base raw) — null si InfluxDB indisponible. */
async function vmP95(ctx: AppContext, epId: string): Promise<Map<number, { cpuPct: number | null; memBytes: number | null }> | null> {
  if (!influxReady(ctx)) return null;
  try {
    const rows = await ctx.influx.querySql<SqlRow>(
      ctx.influx.rawDb,
      `SELECT vmid, quantile_cont(cpu_pct, 0.95) AS cpu_p95, quantile_cont(mem_bytes, 0.95) AS mem_p95
       FROM vm_metrics WHERE time >= now() - INTERVAL '7 days' AND ${clusterFilter(ctx, epId)}
       GROUP BY vmid`,
    );
    return new Map(
      rows.map((r) => [Number(r.vmid), { cpuPct: numOrNull(r.cpu_p95), memBytes: numOrNull(r.mem_p95) }]),
    );
  } catch (err) {
    ctx.logger.warn(`overcommit-risk(${epId}) : InfluxDB indisponible (${(err as Error).message})`);
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Risque de surallocation dynamique d'un endpoint :
 * - pire cas CPU = Σ (p95 cpu_pct / 100 × cœurs alloués) des VMs en marche ;
 * - pire cas RAM = Σ p95 mem_bytes des VMs en marche ;
 * - VM sans historique → usage courant (borne basse, plutôt qu'ignorée) ;
 * - aucune VM en marche → demande nulle (ok) ; VMs en marche sans aucun historique → na.
 */
async function computeOvercommitRisk(
  ctx: AppContext,
  poller: Poller,
  ep: EndpointRuntime,
): Promise<OvercommitRiskResponse> {
  const snap = poller.getMulti()?.endpoints.find((e) => e.id === ep.id)?.snapshot ?? null;
  const kpis = snap?.kpis ?? null;

  // Capacité physique : snapshot courant, repli sur interrogation live
  let capacityCores = kpis?.cpuTotalCores ?? 0;
  let capacityRam = kpis?.ramTotalBytes ?? 0;
  if (capacityCores === 0 && capacityRam === 0) {
    const nodes = (await ep.source.getNodes()).nodes.filter((n) => n.online);
    capacityCores = nodes.reduce((s, n) => s + (n.cpus ?? 0), 0);
    capacityRam = nodes.reduce((s, n) => s + (n.memTotal ?? 0), 0);
  }

  const vms = (await ep.source.getResources()).filter((v) => !v.template);
  const running = vms.filter((v) => v.status === 'running');
  const p95 = await vmP95(ctx, ep.id);

  let demandCores = 0;
  let demandRam = 0;
  const vmDetails: OvercommitRiskResponse['vms'] = [];
  for (const v of running) {
    const h = p95?.get(v.vmid) ?? null;
    const cpuP95Pct = h?.cpuPct ?? null;
    const memP95Bytes = h?.memBytes ?? null;
    // cpu_pct est un % de l'allocation → conversion en cœurs absolus.
    // Fallback sans historique : QEMU cpu en unités de cœur, LXC cpu fraction → × cœurs.
    demandCores += cpuP95Pct !== null ? (cpuP95Pct / 100) * (v.cpuAlloc ?? 0) : v.type === 'lxc' ? (v.cpu ?? 0) * (v.cpuAlloc ?? 0) : (v.cpu ?? 0);
    demandRam += memP95Bytes ?? (v.mem ?? 0);
    vmDetails.push({ vmid: v.vmid, name: v.name, cpuP95Pct, memP95Bytes });
  }

  const hasHistory = vmDetails.some((v) => v.cpuP95Pct !== null || v.memP95Bytes !== null);
  const insufficientData = running.length > 0 && !hasHistory;

  // Ratios statiques alloué/physique (mêmes formules que computeOvercommit)
  const staticReport = kpis ? computeOvercommit(kpis, ctx.config.overcommit) : null;
  const th = ctx.config.overcommit.risk;

  const usage = (demand: number, capacity: number): number | null => {
    if (insufficientData) return null;
    return capacity > 0 ? round1((demand / capacity) * 100) : null;
  };

  const storageSeverity: SeverityOrNa = kpis ? usageSeverity(kpis.storagePct, ctx.config.overcommit) : 'na';

  return {
    insufficientData,
    cpu: {
      usagePct: usage(demandCores, capacityCores),
      ratio: staticReport?.cpu.ratio ?? null,
      severity: riskSeverity(usage(demandCores, capacityCores), staticReport?.cpu.ratio ?? null, th),
      demandCores: round1(demandCores),
      capacityCores,
    },
    ram: {
      usagePct: usage(demandRam, capacityRam),
      ratio: staticReport?.ram.ratio ?? null,
      severity: riskSeverity(usage(demandRam, capacityRam), staticReport?.ram.ratio ?? null, th),
      demandRamBytes: Math.round(demandRam),
      capacityRamBytes: capacityRam,
    },
    storage: {
      usagePct: kpis?.storagePct ?? 0,
      daysTo90: kpis?.storageDaysToFull ?? null,
      severity: storageSeverity,
    },
    vms: vmDetails,
  };
}

export function registerDashboard(app: FastifyInstance, ctx: AppContext, poller: Poller): void {
  const capacityCache = new Map<string, CacheEntry<CapacityResponse>>();
  const nodeCapacityCache = new Map<string, CacheEntry<CapacityResponse>>();
  const trendsCache = new Map<string, CacheEntry<TrendsResponse>>();
  const metricsCache = new Map<string, CacheEntry<MetricsResponse>>();
  const riskCache = new Map<string, CacheEntry<OvercommitRiskResponse>>();

  app.get('/api/health', async () => ({
    status: 'ok',
    mock: ctx.config.mock,
    uptimeSec: Math.round(process.uptime()),
    // P1/P4 : état de la file d'écriture InfluxDB (abandons, profondeur) — liveness
    // + signal de backpressure sans ouvrir de session (route publique).
    influx: ctx.influx.getStats(),
  }));

  /** Snapshot multi-endpoints (même payload que le push WS). */
  app.get('/api/dashboard', async (_req, reply) => {
    const multi = poller.getMulti();
    if (!multi) return reply.code(503).send({ error: 'snapshot not ready' });
    return multi;
  });

  /** Vue compacte des endpoints (sidebar / vue d'ensemble avant le WS). */
  app.get('/api/endpoints', async (_req, reply) => {
    const multi = poller.getMulti();
    if (!multi) return reply.code(503).send({ error: 'snapshot not ready' });
    return multi.endpoints.map((e) => ({
      id: e.id,
      name: e.name,
      ok: e.ok,
      error: e.error ?? null,
      nodesOnline: e.snapshot?.cluster.nodesOnline ?? 0,
      nodesTotal: e.snapshot?.cluster.nodesTotal ?? 0,
      vmsRunning: e.snapshot?.kpis.vmsRunning ?? 0,
      vmsTotal: e.snapshot?.kpis.vmsTotal ?? 0,
      healthScore: e.snapshot ? Math.round(e.snapshot.health.score) : null,
      healthLabel: e.snapshot?.health.label ?? null,
    }));
  });

  app.get('/api/capacity', async (req, reply) => {
    const ep = resolveEndpoint(ctx, (req.query as { endpoint?: string }).endpoint, reply);
    if (!ep) return;
    const cached = capacityCache.get(ep.id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await computeCapacity(ctx, poller, ep);
    capacityCache.set(ep.id, { at: Date.now(), value });
    return value;
  });

  /**
   * Capacity planning au NIVEAU NŒUD (?endpoint=&node=) : mêmes prévisions que
   * /api/capacity mais sur la série d'un seul nœud (disk = rootfs du nœud).
   * 404 si le nœud n'existe pas sur l'endpoint.
   */
  app.get('/api/node-capacity', async (req, reply) => {
    const q = req.query as { endpoint?: string; node?: string };
    const ep = resolveEndpoint(ctx, q.endpoint, reply);
    if (!ep) return;
    const nodeName = q.node;
    if (!nodeName) {
      reply.code(400).send({ error: 'missing node param' });
      return;
    }
    const { nodes } = await ep.source.getNodes();
    if (!nodes.some((n) => n.node === nodeName)) {
      reply.code(404).send({ error: `unknown node: ${nodeName}` });
      return;
    }
    const key = `${ep.id}/${nodeName}`;
    const cached = nodeCapacityCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await computeNodeCapacity(ctx, ep, nodeName);
    nodeCapacityCache.set(key, { at: Date.now(), value });
    return value;
  });

  app.get('/api/trends', async (req, reply) => {
    const ep = resolveEndpoint(ctx, (req.query as { endpoint?: string }).endpoint, reply);
    if (!ep) return;
    const cached = trendsCache.get(ep.id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await computeTrends(ctx, ep);
    trendsCache.set(ep.id, { at: Date.now(), value });
    return value;
  });

  app.get('/api/metrics', async (req, reply) => {
    const q = req.query as { timeframe?: string; endpoint?: string; node?: string };
    if (!q.timeframe || !METRICS_TIMEFRAMES.includes(q.timeframe as MetricsTimeframe)) {
      return reply.code(400).send({ error: `timeframe must be one of ${METRICS_TIMEFRAMES.join(', ')}` });
    }
    // « all » = agrégat de tous les endpoints (graphes de la vue d'ensemble)
    const wantAll = q.endpoint === 'all';
    const ep = wantAll ? null : resolveEndpoint(ctx, q.endpoint, reply);
    if (!wantAll && !ep) return;
    const tf = q.timeframe as MetricsTimeframe;
    const node = typeof q.node === 'string' && q.node.length > 0 ? q.node : undefined;
    const epId = wantAll ? 'all' : ep!.id;
    const key = `${epId}:${tf}:${node ?? ''}`;
    const cached = metricsCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await computeMetrics(ctx, epId, tf, node);
    metricsCache.set(key, { at: Date.now(), value });
    return value;
  });

  /**
   * Risque de surallocation dynamique : pire cas = Σ p95 (7 j) par VM vs capacité physique.
   * p95 depuis raw.vm_metrics (quantile_cont) ; sans historique → insufficientData (na).
   */
  app.get('/api/overcommit-risk', async (req, reply) => {
    const ep = resolveEndpoint(ctx, (req.query as { endpoint?: string }).endpoint, reply);
    if (!ep) return;
    const cached = riskCache.get(ep.id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await computeOvercommitRisk(ctx, poller, ep);
    riskCache.set(ep.id, { at: Date.now(), value });
    return value;
  });
}
