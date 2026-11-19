import type { FastifyInstance } from 'fastify';
import type {
  MetricsTimeframe,
  NodeCpuCore,
  NodeDiskioResponse,
  NodeDiskioRow,
  NodeHostHistoryPoint,
  NodeHostHistoryResponse,
  NodeNetIface,
  NodeNetResponse,
  NodeNetRow,
  NodeHardwareResponse,
  NodeHardwareRow,
  NodeSystemResponse,
  NodeSystemRow,
  NodeTempsResponse,
  NodeTempSeries,
  SmartTempsResponse,
  SmartTempSeries,
  ZfsArcPoint,
  ZfsArcResponse,
} from '@prox4u/shared';
import { isPhysicalDevice, zfsHitRatePct } from '@prox4u/shared';
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
/** Empreinte matérielle quasi-statique → cache long (5 min). */
export const HW_CACHE_TTL_MS = 5 * 60_000;

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

/**
 * Nombre ou null — **null-safe** : `Number(null)` vaut 0 (piège classique), on
 * renvoie donc null pour null/undefined et toute valeur non finie.
 */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Chaîne ou null — `null` pour null/undefined, chaîne vide, ou la sentinelle
 * `unknown` (valeur illisible côté agent : DMI absent en VM, /proc/cpuinfo
 * sans `model name`…). Jamais de valeur inventée.
 */
function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'unknown') return null;
  return s;
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
 * Nom d'interface interne au **pare-feu PVE** : `fw(br|ln|pr)<vmid>(i|p)<n>` —
 * `fwbr102i0` = pont du pare-feu de la machine 102 (interface net0, où les
 * règles sont appliquées), `fwln102i0` = extrémité interne de la paire veth,
 * `fwpr102p0` = extrémité externe (suffixe `p` côté port, `i` ailleurs — noms
 * réels vérifiés en live). Ces devices ne sont PAS dans la config PVE
 * (/etc/network/interfaces) : ils n'arrivent que via l'union des mesures.
 */
export function parsePveFwIface(
  name: string,
): { vmid: number; ifIndex: number; role: 'bridge' | 'line' | 'port' } | null {
  const m = /^fw(br|ln|pr)(\d+)([ip])(\d+)$/.exec(name);
  if (!m) return null;
  return {
    vmid: Number(m[2]),
    ifIndex: Number(m[4]),
    role: m[1] === 'br' ? 'bridge' : m[1] === 'ln' ? 'line' : 'port',
  };
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
 *    absents de la config PVE sont ajoutés en `kind:'other'` (rien n'est
 *    perdu) — sauf si le nom matche la nomenclature du pare-feu PVE
 *    (`parsePveFwIface`) → `kind:'firewall'` + `firewall: { vmid, ifIndex, role }` ;
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
      const fw = parsePveFwIface(k);
      out.push(
        fw ? { name: k, kernels: [k], kind: 'firewall', firewall: fw, active: null } : { name: k, kernels: [k], kind: 'other', active: null },
      );
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// Historiques de jauges hôte (Monitor nœud v4 — bibliothèque complétée,
// référence ProxMenux) : températures capteurs, températures disques SMART,
// ZFS ARC, charge + swap. Jauges → max par bucket (le pic de la fenêtre) ;
// counters ARC (hits/misses) → delta max−min du bucket (pas de LAG : les bornes
// sont dans le même bucket). Raw uniquement (rétention 31 j couvre `month`).
// ---------------------------------------------------------------------------

/**
 * SQL des températures PAR CHIP (table `sensors`) — le chip regroupe plusieurs
 * features (par cœur, Tdie/Tctl…) : le max du bucket représente le chip.
 * Les features sans `temp_input` (ventilateurs, tensions) sont exclues.
 * `where` est fourni par l'appelant (toujours construit par sqlStr).
 */
export function tempsSql(where: string, bucket: string, window: string): string {
  return `SELECT chip, date_bin(INTERVAL '${bucket}', time) AS t, max(temp_input) AS temp
          FROM sensors
          WHERE ${where} AND time >= now() - INTERVAL '${window}' AND temp_input IS NOT NULL
          GROUP BY chip, t ORDER BY t`;
}

/** Lignes SQL → séries par chip (triées par nom, puis temps croissant). */
export function tempsRowsToSeries(rows: InfluxRow[]): NodeTempSeries[] {
  const m = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const chip = String(r.chip ?? '');
    if (!chip || r.temp == null) continue; // null ≠ 0 (Number(null) = 0)
    const temp = Number(r.temp);
    const t = influxTsToUnix(r.t as string | number | null);
    if (t <= 0 || !Number.isFinite(temp)) continue;
    const pts = m.get(chip) ?? new Map<number, number>();
    pts.set(t, temp);
    m.set(chip, pts);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([chip, pts]) => ({
      chip,
      points: [...pts.entries()].sort((x, y) => x[0] - y[0]).map(([t, temp]) => ({ t, temp })),
    }));
}

/**
 * SQL des températures SMART PAR DISQUE (table `smart_device`) — les disques à
 * `temp_c = 0` (pas de capteur, cf. smartTempDisplay) sont exclus DANS la
 * requête : ils traceraient une ligne plate à 0 °C.
 */
export function smartTempsSql(where: string, bucket: string, window: string): string {
  return `SELECT device, date_bin(INTERVAL '${bucket}', time) AS t, max(temp_c) AS temp
          FROM smart_device
          WHERE ${where} AND time >= now() - INTERVAL '${window}' AND temp_c > 0
          GROUP BY device, t ORDER BY t`;
}

/** Lignes SQL → séries par disque (le modèle est joint ensuite, 1 h glissante). */
export function smartTempsRowsToSeries(rows: InfluxRow[]): SmartTempSeries[] {
  const m = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const device = String(r.device ?? '');
    if (!device || r.temp == null) continue; // null ≠ 0 (Number(null) = 0)
    const temp = Number(r.temp);
    const t = influxTsToUnix(r.t as string | number | null);
    if (t <= 0 || !Number.isFinite(temp) || temp <= 0) continue;
    const pts = m.get(device) ?? new Map<number, number>();
    pts.set(t, temp);
    m.set(device, pts);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([device, pts]) => ({
      device,
      model: null,
      points: [...pts.entries()].sort((x, y) => x[0] - y[0]).map(([t, temp]) => ({ t, temp })),
    }));
}

/**
 * SQL ZFS ARC (table `zfs`) — mélangé : `arcstats_c` / `arcstats_c_max` sont
 * des jauges (max du bucket) ; `arcstats_hits` / `arcstats_misses` sont des
 * counters monotones → delta du bucket = max − min (les deux bornes sont dans
 * le même bucket : pas de LAG entre buckets).
 */
export function zfsArcSql(where: string, bucket: string, window: string): string {
  return `SELECT date_bin(INTERVAL '${bucket}', time) AS t,
                 max(arcstats_c) AS size_bytes, max(arcstats_c_max) AS max_bytes,
                 max(arcstats_hits) AS hmax, min(arcstats_hits) AS hmin,
                 max(arcstats_misses) AS mmax, min(arcstats_misses) AS mmin
          FROM zfs
          WHERE ${where} AND time >= now() - INTERVAL '${window}'
          GROUP BY t ORDER BY t`;
}

/** Lignes SQL → points ARC (hit rate via zfsHitRatePct — null si compteurs à 0 / reset). */
export function zfsArcRowsToPoints(rows: InfluxRow[]): ZfsArcPoint[] {
  const out: ZfsArcPoint[] = [];
  for (const r of rows) {
    const t = influxTsToUnix(r.t as string | number | null);
    if (t <= 0) continue;
    const hmax = num(r.hmax);
    const hmin = num(r.hmin);
    const mmax = num(r.mmax);
    const mmin = num(r.mmin);
    const dh = hmax != null && hmin != null ? hmax - hmin : null;
    const dm = mmax != null && mmin != null ? mmax - mmin : null;
    out.push({ t, sizeBytes: num(r.size_bytes), maxBytes: num(r.max_bytes), hitRatePct: zfsHitRatePct(dh, dm) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** SQL de charge (table `system`) — jauges, max du bucket (pic de la fenêtre). */
export function hostHistorySystemSql(where: string, bucket: string, window: string): string {
  return `SELECT date_bin(INTERVAL '${bucket}', time) AS t,
                 max(load1) AS load1, max(load5) AS load5, max(load15) AS load15, max(n_cpus) AS ncpus
          FROM system
          WHERE ${where} AND time >= now() - INTERVAL '${window}'
          GROUP BY t ORDER BY t`;
}

/** SQL de swap (table `mem`) — pic du bucket = max(total) − min(free). */
export function hostHistoryMemSql(where: string, bucket: string, window: string): string {
  return `SELECT date_bin(INTERVAL '${bucket}', time) AS t,
                 max(swap_total) AS swap_total, min(swap_free) AS swap_free_min
          FROM mem
          WHERE ${where} AND time >= now() - INTERVAL '${window}'
          GROUP BY t ORDER BY t`;
}

/**
 * Fusion charge (`system`) + swap (`mem`) — union des horodatages de buckets ;
 * les deux sources sont **indépendantes** (une table absente laisse ses champs
 * null sans perdre l'autre). Swap utilisé = max(total) − min(free), seulement
 * si total > 0 et free dans [0, total] (sinon null — jamais de valeur négative).
 */
export function mergeHostHistory(sysRows: InfluxRow[], memRows: InfluxRow[]): NodeHostHistoryPoint[] {
  const sys = new Map<number, InfluxRow>();
  for (const r of sysRows) {
    const t = influxTsToUnix(r.t as string | number | null);
    if (t > 0) sys.set(t, r);
  }
  const mem = new Map<number, InfluxRow>();
  for (const r of memRows) {
    const t = influxTsToUnix(r.t as string | number | null);
    if (t > 0) mem.set(t, r);
  }
  const out: NodeHostHistoryPoint[] = [];
  for (const t of [...new Set<number>([...sys.keys(), ...mem.keys()])].sort((a, b) => a - b)) {
    const s = sys.get(t);
    const m = mem.get(t);
    const total = m ? num(m.swap_total) : null;
    const free = m ? num(m.swap_free_min) : null;
    const used = total != null && free != null && total > 0 && free >= 0 && free <= total ? total - free : null;
    out.push({
      t,
      load1: s ? num(s.load1) : null,
      load5: s ? num(s.load5) : null,
      load15: s ? num(s.load15) : null,
      nCpus: s ? num(s.ncpus) : null,
      swapUsedBytes: used,
      swapTotalBytes: total,
    });
  }
  return out;
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
  const hwCache = new Map<string, { at: number; value: NodeHardwareResponse }>();
  const diskioCache = new Map<string, { at: number; value: NodeDiskioResponse }>();
  const netCache = new Map<string, { at: number; value: NodeNetResponse }>();
  const tempsCache = new Map<string, { at: number; value: NodeTempsResponse }>();
  const smartTempsCache = new Map<string, { at: number; value: SmartTempsResponse }>();
  const zfsArcCache = new Map<string, { at: number; value: ZfsArcResponse }>();
  const hostHistCache = new Map<string, { at: number; value: NodeHostHistoryResponse }>();

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
   * GET /api/node-hardware — empreinte matérielle par nœud (modèle CPU + DMI) :
   * dernier point par nœud sur la table quasi-statique `node_hardware` (script
   * `exec` Telegraf, fenêtre 1 h). Cache 5 min. `source: 'empty'` si la table
   * est absente (agent pas encore (re)déployé) — le front affiche alors « — ».
   */
  app.get('/api/node-hardware', async (_req, reply) => {
    const cached = hwCache.get('all');
    if (cached && Date.now() - cached.at < HW_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    let body: NodeHardwareResponse = { nodes: [], source: 'empty' };
    if (influxReady(ctx)) {
      try {
        const rows = await ctx.influx!.querySql<InfluxRow>(
          ctx.influx!.rawDb,
          `SELECT node, cpu_model, product, vendor, board, time
           FROM node_hardware WHERE time >= now() - INTERVAL '1 hour' ORDER BY time DESC`,
        );
        const byNode = new Map<string, InfluxRow>();
        for (const r of rows) {
          const k = String(r.node ?? '');
          if (k && !byNode.has(k)) byNode.set(k, r);
        }
        const nodes: NodeHardwareRow[] = [];
        for (const [node, r] of byNode) {
          nodes.push({
            node,
            cpuModel: strOrNull(r.cpu_model),
            product: strOrNull(r.product),
            vendor: strOrNull(r.vendor),
            board: strOrNull(r.board),
          });
        }
        nodes.sort((a, b) => a.node.localeCompare(b.node));
        body = { nodes, source: nodes.length > 0 ? 'influx' : 'empty' };
      } catch (err) {
        ctx.logger.warn(`node-hardware : InfluxDB indisponible (${(err as Error).message})`);
      }
    }
    hwCache.set('all', { at: Date.now(), value: body });
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

  // ---------------------------------------------------------------------------
  // Historiques de jauges hôte (Monitor nœud v4) — mêmes conventions que
  // node-diskio / node-net : raw uniquement, buckets HOST_DISKIO_TF, cache 5 min
  // par (node, timeframe), 400 paramètre manquant / invalide.
  // ---------------------------------------------------------------------------

  /**
   * GET /api/node-temps?node=&timeframe= — températures PAR CHIP (table `sensors`,
   * max du chip par bucket) : le widget « Températures CPU & chips » du Monitor
   * nœud (équivalent prox4u du graphique « Température » + historique ProxMenux).
   */
  app.get('/api/node-temps', async (req, reply) => {
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
    const key = `temps:${node}/${tf}`;
    const cached = tempsCache.get(key);
    if (cached && Date.now() - cached.at < DISKIO_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    let body: NodeTempsResponse = { timeframe: tf, node, series: [], source: 'insufficientData' };
    if (influxReady(ctx)) {
      try {
        const { bucket, window } = HOST_DISKIO_TF[tf];
        const rows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, tempsSql(`node = ${sqlStr(node)}`, bucket, window));
        const series = tempsRowsToSeries(rows);
        body = { timeframe: tf, node, series, source: series.length > 0 ? 'influx' : 'insufficientData' };
      } catch (err) {
        ctx.logger.warn(`node-temps(${key}) : InfluxDB indisponible (${(err as Error).message})`);
      }
    }
    tempsCache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });

  /**
   * GET /api/smart-temps?node=&timeframe= — températures PAR DISQUE (table
   * `smart_device`, temp_c > 0) : le widget « Températures disques (SMART) »
   * (équivalent du graphique disques ProxMenux). Le modèle de chaque disque est
   * joint (dernier point connu, 1 h) — non bloquant en cas d'échec.
   */
  app.get('/api/smart-temps', async (req, reply) => {
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
    const key = `smarttemps:${node}/${tf}`;
    const cached = smartTempsCache.get(key);
    if (cached && Date.now() - cached.at < DISKIO_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    let body: SmartTempsResponse = { timeframe: tf, node, series: [], source: 'insufficientData' };
    if (influxReady(ctx)) {
      try {
        const where = `node = ${sqlStr(node)}`;
        const { bucket, window } = HOST_DISKIO_TF[tf];
        const rows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, smartTempsSql(where, bucket, window));
        const series = smartTempsRowsToSeries(rows);
        if (series.length > 0) {
          try {
            const modelRows = await ctx.influx!.querySql<InfluxRow>(
              ctx.influx!.rawDb,
              `SELECT device, model, time FROM smart_device WHERE ${where} AND time >= now() - INTERVAL '1h' ORDER BY time DESC`,
            );
            const models = new Map<string, string | null>();
            for (const r of modelRows) {
              const d = String(r.device ?? '');
              if (d && !models.has(d)) models.set(d, r.model ? String(r.model) : null);
            }
            for (const s of series) s.model = models.get(s.device) ?? null;
          } catch (err) {
            ctx.logger.warn(`smart-temps(${key}) : modèles inconnus (${(err as Error).message})`);
          }
        }
        body = { timeframe: tf, node, series, source: series.length > 0 ? 'influx' : 'insufficientData' };
      } catch (err) {
        ctx.logger.warn(`smart-temps(${key}) : InfluxDB indisponible (${(err as Error).message})`);
      }
    }
    smartTempsCache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });

  /**
   * GET /api/zfs-arc?node=&timeframe= — ZFS ARC (table `zfs`) : taille courante
   * (`arcstats_c`), max (`arcstats_c_max`) et hit rate (deltas de compteurs du
   * bucket — null si compteurs à 0 / reset : le front masque la série, pattern
   * ProxMenux) : le widget « ZFS ARC » du Monitor nœud (équivalent de la ligne
   * « memoryZfsArc » du graphique mémoire ProxMenux).
   */
  app.get('/api/zfs-arc', async (req, reply) => {
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
    const key = `zfsarc:${node}/${tf}`;
    const cached = zfsArcCache.get(key);
    if (cached && Date.now() - cached.at < DISKIO_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    let body: ZfsArcResponse = { timeframe: tf, node, points: [], source: 'insufficientData' };
    if (influxReady(ctx)) {
      try {
        const { bucket, window } = HOST_DISKIO_TF[tf];
        const rows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, zfsArcSql(`node = ${sqlStr(node)}`, bucket, window));
        const points = zfsArcRowsToPoints(rows);
        body = { timeframe: tf, node, points, source: points.length > 0 ? 'influx' : 'insufficientData' };
      } catch (err) {
        ctx.logger.warn(`zfs-arc(${key}) : InfluxDB indisponible (${(err as Error).message})`);
      }
    }
    zfsArcCache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });

  /**
   * GET /api/node-system-history?node=&timeframe= — charge 1/5/15 (table `system`)
   * + swap (table `mem`) : les widgets « Charge moyenne » et « Swap » du Monitor
   * nœud (équivalent de la partie « load average » du graphique CPU ProxMenux +
   * tendance swap du backlog node-sensors). Les deux requêtes sont isolées : une
   * table absente ne fait pas perdre l'autre (champs null).
   */
  app.get('/api/node-system-history', async (req, reply) => {
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
    const key = `hosthist:${node}/${tf}`;
    const cached = hostHistCache.get(key);
    if (cached && Date.now() - cached.at < DISKIO_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }
    const empty: NodeHostHistoryResponse = { timeframe: tf, node, points: [], source: 'insufficientData' };
    let body: NodeHostHistoryResponse = empty;
    if (influxReady(ctx)) {
      const { bucket, window } = HOST_DISKIO_TF[tf];
      const where = `node = ${sqlStr(node)}`;
      let sysRows: InfluxRow[] = [];
      let memRows: InfluxRow[] = [];
      try {
        sysRows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, hostHistorySystemSql(where, bucket, window));
      } catch (err) {
        ctx.logger.warn(`node-system-history(${key}) : table system indisponible (${(err as Error).message})`);
      }
      try {
        memRows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, hostHistoryMemSql(where, bucket, window));
      } catch (err) {
        ctx.logger.warn(`node-system-history(${key}) : table mem indisponible (${(err as Error).message})`);
      }
      const points = mergeHostHistory(sysRows, memRows);
      body = { timeframe: tf, node, points, source: points.length > 0 ? 'influx' : 'insufficientData' };
    }
    hostHistCache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });
}
