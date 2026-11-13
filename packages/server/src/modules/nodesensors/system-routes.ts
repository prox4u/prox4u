import type { FastifyInstance } from 'fastify';
import type {
  MetricsTimeframe,
  NodeCpuCore,
  NodeDiskioResponse,
  NodeDiskioRow,
  NodeNetIface,
  NodeNetResponse,
  NodeNetRow,
  NodeSystemResponse,
  NodeSystemRow,
} from '@prox4u/shared';
import { isPhysicalDevice } from '@prox4u/shared';
import { influxTsToUnix } from '../../core/influx.js';
import type { NodeNetwork } from '../../core/data-source.js';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';

/**
 * Métriques système hôte (Telegraf, tables `system` / `mem` / `cpu` / `diskio`) —
 * la Vue d'ensemble n'en consommait aucune avant : l'API PVE ne fournit ni
 * historique de load/swap, ni I/O par device, ni usage par cœur.
 *
 *  - GET /api/node-system   : dernier point par nœud (live, cache 1 min) ;
 *  - GET /api/node-diskio   : I/O par device physique, buckets date_bin+LAG
 *    (counters → débits), cache 5 min par (node, timeframe) ;
 *  - GET /api/node-net      : trafic réseau PAR INTERFACE hôte (Telegraf `net`),
 *    mêmes buckets, cache 5 min par (node, timeframe).
 *
 * Toutes les tables sont dans `raw` (rétention 31 j) — non consolidées :
 * les buckets 15 min de `consolidated` servent les tables de jauges
 * (SMART/capteurs/ZFS), pas les counters d'I/O.
 */

export const SYS_CACHE_TTL_MS = 60_000;
export const DISKIO_CACHE_TTL_MS = 5 * 60_000;

/** Ligne brute InfluxDB (valeurs typées au parse, jamais de SQL injection). */
export type InfluxRow = Record<string, string | number | null>;

/**
 * Bucket par timeframe — raw uniquement (rétention 31 j). `month` = 30 j,
 * couvert par raw (pas de consolidated pour diskio — counters).
 */
export const HOST_DISKIO_TF: Record<MetricsTimeframe, { bucket: string; bucketSec: number; window: string }> = {
  hour: { bucket: '1 minute', bucketSec: 60, window: '1 hour' },
  day: { bucket: '5 minutes', bucketSec: 300, window: '24 hours' },
  week: { bucket: '1 hour', bucketSec: 3600, window: '7 days' },
  month: { bucket: '1 day', bucketSec: 86400, window: '30 days' },
};

/** Literal SQL (DuckDB) : échappe les guillemets simples. */
export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Nombre fini ou null ; une valeur négative = reset de counter (reboot) → null. */
export function normRate(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, v));
}

function influxReady(ctx: AppContext): boolean {
  return !!ctx.influx && ctx.influx.enabled;
}

/**
 * SQL d'I/O par device — bucket d'abord (MIN/MAX colonaires, pas de window
 * function sur les ~60k points/device/7 j), puis LAG des counters de bucket en
 * bucket. Le débit = Δ(counter) / durée de bucket ; un delta négatif (reset de
 * counter au reboot) devient NULL via normRate, jamais un pic faux.
 * `busy_pct` = Δ(io_time, ms d'occupation réelle) / durée — 0–100, convention
 * iostat (pas le io_util Telegraf basé sur weighted_io_time, qui dépasse 100 %
 * avec de la parallélisme).
 * `where` est fourni par l'appelant (toujours construit par sqlStr).
 */
export function diskioRateSql(where: string, bucket: string, bucketSec: number, window: string): string {
  return `WITH b AS (
    SELECT name, date_bin(INTERVAL '${bucket}', time) AS t,
           MAX(read_bytes) AS rb, MAX(write_bytes) AS wb,
           MAX(reads) AS r, MAX(writes) AS w,
           MAX(io_time) AS it, AVG(io_await) AS await_ms
    FROM diskio
    WHERE ${where} AND time >= now() - INTERVAL '${window}'
    GROUP BY name, t
  )
  SELECT t, name,
         (rb - LAG(rb) OVER w) / ${bucketSec}.0 AS read_bps,
         (wb - LAG(wb) OVER w) / ${bucketSec}.0 AS write_bps,
         ((r - LAG(r) OVER w) + (w - LAG(w) OVER w)) / ${bucketSec}.0 AS iops,
         (it - LAG(it) OVER w) / (${bucketSec}000.0) * 100 AS busy_pct,
         await_ms
  FROM b
  WINDOW w AS (PARTITION BY name ORDER BY t)
  ORDER BY t`;
}

/**
 * SQL de débit réseau par interface — même principe que `diskioRateSql` :
 * bucket d'abord (MAX colonaires des counters, pas de window function sur les
 * ~50k points/iface/7 j), puis LAG des counters de bucket en bucket. Le débit =
 * Δ(counter) / durée de bucket (octets/s) ; un delta négatif (reset de counter
 * au reboot) devient NULL via normRate, jamais un pic faux.
 * `where` est fourni par l'appelant (toujours construit par sqlStr) — pour
 * /api/node-net, les tap des VMs (vnet* / tap* / veth*) et lo sont exclus
 * (ce trafic est montré dans le Monitor de chaque VM — double-comptage).
 */
export function netRateSql(where: string, bucket: string, bucketSec: number, window: string): string {
  return `WITH b AS (
    SELECT "interface" AS iface, date_bin(INTERVAL '${bucket}', time) AS t,
           MAX(bytes_recv) AS rb, MAX(bytes_sent) AS sb
    FROM net
    WHERE ${where} AND time >= now() - INTERVAL '${window}'
    GROUP BY "interface", t
  )
  SELECT t, iface,
         (rb - LAG(rb) OVER w) / ${bucketSec}.0 AS in_bps,
         (sb - LAG(sb) OVER w) / ${bucketSec}.0 AS out_bps
  FROM b
  WINDOW w AS (PARTITION BY iface ORDER BY t)
  ORDER BY t`;
}

/**
 * Lignes SQL → points par device. Filtre les PARTITIONS côté TS (sda1,
 * nvme0n1p1…) — le disques ENTIER porte déjà toute l'I/O ; dm-N / loop / md sont
 * exclus dans le SQL (double-comptage / bruit).
 */
export function diskioRowsToDevices(rows: InfluxRow[]): NodeDiskioRow[] {
  const out: NodeDiskioRow[] = [];
  for (const r of rows) {
    const device = String(r.name ?? '');
    if (!isPhysicalDevice(device)) continue;
    const t = influxTsToUnix(r.t as string | number | null);
    if (t <= 0) continue;
    out.push({
      t,
      device,
      readBps: normRate(r.read_bps),
      writeBps: normRate(r.write_bps),
      iops: normRate(r.iops),
      busyPct: normRate(r.busy_pct),
      awaitMs: normRate(r.await_ms),
    });
  }
  return out.sort((a, b) => a.t - b.t || a.device.localeCompare(b.device));
}

/**
 * Liste des interfaces d'un nœud pour la vue « 1 carte graphique par
 * interface » (même liste que la page Réseau de Proxmox) :
 *  - source : `GET /nodes/{n}/network` (noms PVE + `altnames` = noms
 *    alternatifs du device noyau, ex. le nom dérivé du MAC) ;
 *  - joint nom PVE ↔ noyau : SUR UN NŒUD PVE le device noyau est renommé
 *    selon /etc/network/interfaces → le nom que Telegraf rapporte est le NOM
 *    PVE (cas courant, vérifié en live : `nic2` et non `enx9c6b00dd220c`).
 *    Les `altnames` restent en candidats de secours (nœuds non renommés).
 *    `kernels = [name, ...altnames]` — les mesures se joignent sur n'importe
 *    lequel ;
 *  - union : les devices noyau vus seulement dans les mesures `rows` mais
 *    absents de la config PVE (ex. fw* internes au firewall PVE) sont ajoutés
 *    en `kind:'other'` (rien n'est perdu) ;
 *  - tri par nom (ordre numérique — nic0 < nic1 < … < nic10).
 */
export function buildNodeNetIfaces(net: NodeNetwork | null, rows: Array<{ iface?: unknown }>): NodeNetIface[] {
  const out: NodeNetIface[] = [];
  if (net && net.online) {
    for (const b of net.bridges) {
      out.push({ name: b.name, kernels: [b.name, ...(b.altnames ?? [])], kind: 'bridge', active: b.active ?? null });
    }
    for (const n of net.nics) {
      out.push({ name: n.name, kernels: [n.name, ...(n.altnames ?? [])], kind: 'nic', active: n.active ?? null });
    }
  }
  const covered = new Set(out.flatMap((i) => i.kernels));
  for (const r of rows) {
    const k = String(r.iface ?? '');
    if (k && !covered.has(k)) {
      covered.add(k);
      out.push({ name: k, kernels: [k], kind: 'other', active: null });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Nœud → endpoint dont le dernier snapshot connaît ce nœud (null si introuvable / pas de snapshot). */
export function nodeEndpoint(ctx: AppContext, poller: Poller, node: string): EndpointRuntime | null {
  const multi = poller.getMulti();
  if (!multi) return null;
  for (const e of ctx.endpoints) {
    const snap = multi.endpoints.find((m) => m.id === e.id)?.snapshot ?? null;
    if (snap?.nodes.some((n) => n.node === node)) return e;
  }
  return null;
}

/**
 * GET /api/node-system — dernier point par nœud : load 1/5/15 + nb cœurs +
 * uptime (`system`), swap (`mem`), usage CPU global + par cœur (`cpu`).
 * Les 3 requêtes sont isolées (une table absente ne fait pas perdre les
 * autres) ; les lignes sont triées time DESC → le premier point par clé gagne.
 */
export function registerNodeSystemRoutes(app: FastifyInstance, ctx: AppContext, poller: Poller): void {
  const sysCache = new Map<string, { at: number; value: NodeSystemResponse }>();
  const diskioCache = new Map<string, { at: number; value: NodeDiskioResponse }>();
  const netCache = new Map<string, { at: number; value: NodeNetResponse }>();

  app.get('/api/node-system', async (_req, reply) => {
    const cached = sysCache.get('all');
    if (cached && Date.now() - cached.at < SYS_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    let body: NodeSystemResponse = { nodes: [], source: 'empty' };
    if (influxReady(ctx)) {
      try {
        const [sysRows, memRows, cpuRows] = await Promise.all([
          ctx.influx!.querySql<InfluxRow>(
            ctx.influx!.rawDb,
            `SELECT node, load1, load5, load15, n_cpus, uptime, time
             FROM system WHERE time >= now() - INTERVAL '10 minutes' ORDER BY time DESC`,
          ),
          ctx.influx!.querySql<InfluxRow>(
            ctx.influx!.rawDb,
            `SELECT node, swap_total, swap_free, time
             FROM mem WHERE time >= now() - INTERVAL '10 minutes' ORDER BY time DESC`,
          ),
          ctx.influx!.querySql<InfluxRow>(
            ctx.influx!.rawDb,
            `SELECT node, cpu, usage_user, usage_system, usage_iowait, usage_idle, time
             FROM cpu WHERE time >= now() - INTERVAL '10 minutes' ORDER BY time DESC`,
          ),
        ]);

        const sysByNode = new Map<string, InfluxRow>();
        for (const r of sysRows) {
          const k = String(r.node ?? '');
          if (k && !sysByNode.has(k)) sysByNode.set(k, r);
        }
        const memByNode = new Map<string, InfluxRow>();
        for (const r of memRows) {
          const k = String(r.node ?? '');
          if (k && !memByNode.has(k)) memByNode.set(k, r);
        }
        const cpuLatest = new Map<string, InfluxRow>();
        for (const r of cpuRows) {
          const k = `${r.node}/${r.cpu}`;
          if (!cpuLatest.has(k)) cpuLatest.set(k, r);
        }
        const totalByNode = new Map<string, InfluxRow>();
        const coresByNode = new Map<string, NodeCpuCore[]>();
        for (const [k, r] of cpuLatest) {
          const sep = k.indexOf('/');
          const node = k.slice(0, sep);
          const cpu = k.slice(sep + 1);
          if (cpu === 'cpu-total') {
            totalByNode.set(node, r);
            continue;
          }
          const idle = num(r.usage_idle) ?? 100;
          const iowait = num(r.usage_iowait) ?? 0;
          const user = num(r.usage_user) ?? 0;
          const system = num(r.usage_system) ?? 0;
          const list = coresByNode.get(node) ?? [];
          list.push({ core: cpu, usagePct: clamp(100 - idle - iowait), iowaitPct: iowait, userPct: user, systemPct: system });
          coresByNode.set(node, list);
        }

        const nodes: NodeSystemRow[] = [];
        for (const [node, r] of sysByNode) {
          const mem = memByNode.get(node);
          const total = totalByNode.get(node);
          const swapTotal = num(mem?.swap_total) ?? 0;
          const swapFree = num(mem?.swap_free) ?? 0;
          const swapUsed = Math.max(0, swapTotal - swapFree);
          nodes.push({
            node,
            nCpus: num(r.n_cpus) ?? 0,
            load1: num(r.load1) ?? 0,
            load5: num(r.load5) ?? 0,
            load15: num(r.load15) ?? 0,
            uptimeSec: num(r.uptime) ?? 0,
            iowaitPct: total ? num(total.usage_iowait) : null,
            userPct: total ? num(total.usage_user) : null,
            systemPct: total ? num(total.usage_system) : null,
            swapTotalBytes: swapTotal,
            swapUsedBytes: swapUsed,
            swapPct: swapTotal > 0 ? clamp((swapUsed / swapTotal) * 100) : null,
            cores: (coresByNode.get(node) ?? []).sort((a, b) => a.core.localeCompare(b.core, undefined, { numeric: true })),
          });
        }
        nodes.sort((a, b) => a.node.localeCompare(b.node));
        body = { nodes, source: nodes.length > 0 ? 'influx' : 'empty' };
      } catch (err) {
        ctx.logger.warn(`node-system : InfluxDB indisponible (${(err as Error).message})`);
      }
    }
    sysCache.set('all', { at: Date.now(), value: body });
    reply.send(body);
  });

  /**
   * GET /api/node-diskio?node=&timeframe= — I/O des devices PHYSIQUES du nœud
   * (disques entiers : nvme0n1, sda…). dm-N / loop / md / sr / ram exclus dans le SQL,
   * partitions filtrées côté TS (isPhysicalDevice).
   */
  app.get('/api/node-diskio', async (req, reply) => {
    const q = req.query as { node?: string; timeframe?: string };
    const node = q.node?.trim();
    if (!node) {
      reply.code(400).send({ error: 'node requis' });
      return;
    }
    const tf = q.timeframe as MetricsTimeframe;
    if (!HOST_DISKIO_TF[tf]) {
      reply.code(400).send({ error: `timeframe must be one of ${Object.keys(HOST_DISKIO_TF).join(', ')}` });
      return;
    }
    const key = `${node}/${tf}`;
    const cached = diskioCache.get(key);
    if (cached && Date.now() - cached.at < DISKIO_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    let body: NodeDiskioResponse = { timeframe: tf, node, devices: [], source: 'insufficientData' };
    if (influxReady(ctx)) {
      try {
        const { bucket, bucketSec, window } = HOST_DISKIO_TF[tf];
        const where = `node = ${sqlStr(node)} AND name NOT LIKE 'dm-%' AND name NOT LIKE 'loop%'
          AND name NOT LIKE 'md%' AND name NOT LIKE 'sr%' AND name NOT LIKE 'ram%' AND name NOT LIKE 'zram%'`;
        const rows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, diskioRateSql(where, bucket, bucketSec, window));
        const devices = diskioRowsToDevices(rows);
        body = { timeframe: tf, node, devices, source: devices.length > 0 ? 'influx' : 'insufficientData' };
      } catch (err) {
        ctx.logger.warn(`node-diskio(${key}) : InfluxDB indisponible (${(err as Error).message})`);
      }
    }
    diskioCache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });

  /**
   * GET /api/node-net?node=&timeframe= — trafic réseau PAR INTERFACE hôte
   * (Telegraf `net`, counters bytes_recv/bytes_sent → débits par delta) :
   * NICs physiques + ponts (vmbr*). Les tap des VMs (vnet* / tap* / veth*)
   * et lo sont exclus dans le SQL — leur trafic est montré dans le Monitor
   * de chaque VM (vue /api/vm-net), pas ici (double-comptage).
   */
  app.get('/api/node-net', async (req, reply) => {
    const q = req.query as { node?: string; timeframe?: string };
    const node = q.node?.trim();
    if (!node) {
      reply.code(400).send({ error: 'node requis' });
      return;
    }
    const tf = q.timeframe as MetricsTimeframe;
    if (!HOST_DISKIO_TF[tf]) {
      reply.code(400).send({ error: `timeframe must be one of ${Object.keys(HOST_DISKIO_TF).join(', ')}` });
      return;
    }
    const key = `net:${node}/${tf}`;
    const cached = netCache.get(key);
    if (cached && Date.now() - cached.at < DISKIO_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    let body: NodeNetResponse = { timeframe: tf, node, interfaces: [], rows: [], source: 'insufficientData' };
    if (influxReady(ctx)) {
      try {
        const { bucket, bucketSec, window } = HOST_DISKIO_TF[tf];
        const where = `node = ${sqlStr(node)} AND "interface" NOT LIKE 'vnet%' AND "interface" NOT LIKE 'tap%'
          AND "interface" NOT LIKE 'veth%' AND "interface" <> 'lo'`;
        const rows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, netRateSql(where, bucket, bucketSec, window));
        const out: NodeNetRow[] = [];
        for (const r of rows) {
          const iface = String(r.iface ?? '');
          if (!iface) continue;
          const t = influxTsToUnix(r.t as string | number | null);
          if (t <= 0) continue;
          out.push({ t, iface, inBps: normRate(r.in_bps), outBps: normRate(r.out_bps) });
        }
        out.sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }) || a.t - b.t);
        body = { timeframe: tf, node, interfaces: [], rows: out, source: out.length > 0 ? 'influx' : 'insufficientData' };
      } catch (err) {
        ctx.logger.warn(`node-net(${key}) : InfluxDB indisponible (${(err as Error).message})`);
      }
    }
    // Liste des interfaces (API PVE /nodes/{n}/network) — dispo AVANT le
    // redéploiement de l'agent : joint nom PVE ↔ noyau (altnames) + union des
    // devices noyau vus seulement dans les mesures (kind:'other').
    try {
      const ep = nodeEndpoint(ctx, poller, node);
      let net: NodeNetwork | null = null;
      if (ep) net = (await ep.source.getNetwork()).find((n) => n.node === node) ?? null;
      body.interfaces = buildNodeNetIfaces(net, body.rows);
    } catch (err) {
      ctx.logger.warn(`node-net(${key}) : réseau PVE indisponible (${(err as Error).message})`);
    }
    netCache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });
}
