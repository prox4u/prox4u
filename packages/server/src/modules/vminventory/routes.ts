import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  MetricsTimeframe,
  PveVmSnapshot,
  VmDetailResponse,
  VmMetricsPoint,
  VmMetricsResponse,
} from '@prox4u/shared';
import { influxTsToUnix } from '../../core/influx.js';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';

const SNAP_CACHE_TTL_MS = 5 * 60 * 1000;
const METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

interface SnapCacheEntry {
  at: number;
  value: PveVmSnapshot[];
}

/**
 * Inventaire VM — détail d'une VM (GET /api/vm-config?endpoint=&vmid=).
 * - état live : snapshot courant du poller (push 5 s, pas de cache) ;
 * - config : getVmConfig (cache 1 h dans Prox4uClient) ;
 * - snapshots : appel PVE à la demande, cache 5 min par (endpoint, vmid) ;
 * - agentNets : interfaces guest agent (QEMU), cache 60 s — IPs/MAC par interface.
 */
export function registerVmInventory(app: FastifyInstance, ctx: AppContext, poller: Poller): void {
  const snapCache = new Map<string, SnapCacheEntry>();

  app.get('/api/vm-config', async (req, reply) => {
    const q = req.query as { endpoint?: string; vmid?: string };
    const ep = resolveEndpoint(ctx, q.endpoint, reply);
    if (!ep) return;

    const vmid = Number(q.vmid);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      reply.code(400).send({ error: 'vmid (entier positif) requis' });
      return;
    }

    const snap = poller.getMulti()?.endpoints.find((e) => e.id === ep.id)?.snapshot ?? null;
    if (!snap) {
      reply.code(503).send({ error: 'snapshot not ready' });
      return;
    }

    const vm = snap.vms.find((v) => v.vmid === vmid);
    if (!vm) {
      reply.code(404).send({ error: `unknown vm: ${vmid}` });
      return;
    }

    // Snapshots : à la demande, cache 5 min ; en cas d'échec, repli sur le cache périmé.
    const key = `${ep.id}/${vmid}`;
    let entry = snapCache.get(key);
    if (!entry || Date.now() - entry.at >= SNAP_CACHE_TTL_MS) {
      try {
        entry = { at: Date.now(), value: await ep.source.getVmSnapshots(vm.node, vmid, vm.type) };
        snapCache.set(key, entry);
      } catch (err) {
        if (!entry) {
          ctx.logger.warn(`vm-config: snapshots ${key} indisponibles : ${(err as Error).message}`);
          entry = { at: Date.now(), value: [] };
        }
      }
    }

    const config = await ep.source.getVmConfig(vm.node, vmid, vm.type);

    // Interfaces live par interface (VM en marche) : guest agent QEMU / netns LXC (PVE ≥ 9).
    // Cache 60 s dans Prox4uClient ; les sources gèrent les échecs (VM arrêtée → []).
    const agentNets =
      vm.status === 'running'
        ? vm.type === 'qemu'
          ? await ep.source.getVmAgentNets(vm.node, vmid)
          : await ep.source.getLxcInterfaces(vm.node, vmid)
        : [];

    const body: VmDetailResponse = { vm, config, snapshots: entry.value, agentNets };
    reply.send(body);
  });

  // --- Métriques historiques par VM (onglet Monitor) ------------------------------------

  const metricsCache = new Map<string, { at: number; value: VmMetricsResponse }>();

  app.get('/api/vm-metrics', async (req, reply) => {
    const q = req.query as { endpoint?: string; vmid?: string; timeframe?: string };
    const ep = resolveEndpoint(ctx, q.endpoint, reply);
    if (!ep) return;

    const vmid = Number(q.vmid);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      reply.code(400).send({ error: 'vmid (entier positif) requis' });
      return;
    }
    if (!q.timeframe || !VM_METRICS_TF[q.timeframe]) {
      reply.code(400).send({ error: `timeframe must be one of ${Object.keys(VM_METRICS_TF).join(', ')}` });
      return;
    }
    const tf = q.timeframe as MetricsTimeframe;

    const key = `${ep.id}/${vmid}/${tf}`;
    const cached = metricsCache.get(key);
    if (cached && Date.now() - cached.at < METRICS_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }

    let body: VmMetricsResponse;
    if (!influxReady(ctx)) {
      // Pas de repli RRD : les RRD PVE sont au niveau nœud, pas VM.
      body = { timeframe: tf, vmid, points: [], source: 'insufficientData' };
    } else {
      try {
        const { bucket, window, db } = VM_METRICS_TF[tf];
        const rows = await ctx.influx.querySql<VmMetricsRow>(
          db === 'raw' ? ctx.influx.rawDb : ctx.influx.aggDb,
          `SELECT date_bin(INTERVAL '${bucket}', time) AS t,
                  AVG(cpu_pct) AS cpu_pct, AVG(mem_bytes) AS mem_bytes,
                  AVG(disk_read_bps) AS disk_read_bps, AVG(disk_write_bps) AS disk_write_bps,
                  AVG(net_in_bps) AS net_in_bps, AVG(net_out_bps) AS net_out_bps
           FROM vm_metrics WHERE time >= now() - INTERVAL '${window}' AND ${clusterFilter(ctx, ep.id)} AND vmid = '${vmid}'
           GROUP BY t ORDER BY t`,
        );
        const points = vmMetricsRowsToPoints(rows);
        body = { timeframe: tf, vmid, points, source: points.length > 0 ? 'influx' : 'insufficientData' };
      } catch (err) {
        ctx.logger.warn(`vm-metrics(${key}) : InfluxDB indisponible (${(err as Error).message})`);
        body = { timeframe: tf, vmid, points: [], source: 'insufficientData' };
      }
    }

    metricsCache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });
}

// --- Aides métriques par VM (pures, testées) --------------------------------------------

/**
 * Bucket SQL par timeframe — même granularité que /api/metrics (TF_SQL du dashboard) :
 * raw couvre 31 j (hour/day/week), consolidated pour le mois.
 */
export const VM_METRICS_TF: Record<MetricsTimeframe, { bucket: string; window: string; db: 'raw' | 'agg' }> = {
  hour: { bucket: '1 minute', window: '1 hour', db: 'raw' },
  day: { bucket: '5 minutes', window: '24 hours', db: 'raw' },
  week: { bucket: '1 hour', window: '7 days', db: 'raw' },
  month: { bucket: '1 day', window: '30 days', db: 'agg' },
};

/** Ligne SQL du /api/vm-metrics (date_bin + AVG). */
interface VmMetricsRow {
  t: string | number | null;
  cpu_pct: unknown;
  mem_bytes: unknown;
  disk_read_bps: unknown;
  disk_write_bps: unknown;
  net_in_bps: unknown;
  net_out_bps: unknown;
}

/** Lignes SQL (date_bin + AVG) → points triés ; buckets sans horodatage écartés. */
export function vmMetricsRowsToPoints(rows: VmMetricsRow[]): VmMetricsPoint[] {
  return rows
    .map((r) => ({
      time: influxTsToUnix(r.t),
      cpuPct: numOrNull(r.cpu_pct),
      memBytes: r.mem_bytes == null ? null : Math.round(num(r.mem_bytes)),
      // champs absents sur les données pré-extension → AVG NULL → null (le graphe démarre plus tard, pas à 0)
      diskReadBps: r.disk_read_bps == null ? null : Math.round(num(r.disk_read_bps)),
      diskWriteBps: r.disk_write_bps == null ? null : Math.round(num(r.disk_write_bps)),
      netInBps: r.net_in_bps == null ? null : Math.round(num(r.net_in_bps)),
      netOutBps: r.net_out_bps == null ? null : Math.round(num(r.net_out_bps)),
    }))
    .filter((p) => p.time > 0)
    .sort((a, b) => a.time - b.time);
}

/** InfluxDB actif pour ce contexte (réel + token configuré) ? */
function influxReady(ctx: AppContext): boolean {
  return ctx.influx.enabled && !ctx.config.mock;
}

/** Filtre SQL par endpoint (mêmes lignes legacy que /api/metrics : tag cluster absent → endpoint par défaut). */
function clusterFilter(ctx: AppContext, epId: string): string {
  return `COALESCE(cluster, '${ctx.config.defaultEndpointId}') = '${epId}'`;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function resolveEndpoint(ctx: AppContext, id: string | undefined, reply: FastifyReply): EndpointRuntime | null {
  const wanted = id ?? ctx.config.defaultEndpointId;
  const ep = ctx.endpoints.find((e) => e.id === wanted);
  if (!ep) {
    reply.code(404).send({ error: `unknown endpoint: ${wanted}` });
    return null;
  }
  return ep;
}
