import type { FastifyInstance } from 'fastify';
import type { NodeSensorsResponse, SmartDevice, SensorReading, ZfsStatus, FailedUnit } from '@prox4u/shared';
import { influxTsToUnix } from '../../core/influx.js';
import type { AppContext } from '../../core/poller.js';

const CACHE_TTL_MS = 60_000; // 1 min — les données Telegraf arrivent toutes les 10 s

interface CacheEntry {
  at: number;
  value: NodeSensorsResponse;
}

function influxReady(ctx: AppContext): boolean {
  return !!ctx.influx && ctx.influx.enabled;
}

/**
 * GET /api/node-sensors — métriques locales Telegraf (SMART, capteurs, ZFS, unités systemd).
 * Cache 1 min. Source : base `raw` (les mesures Telegraf arrivent directement dans raw).
 * Chaque query est isolée dans son propre try/catch : une table absente ou une
 * colonne inconnue ne fait pas perdre les autres sections.
 */
export function registerNodeSensors(app: FastifyInstance, ctx: AppContext): void {
  const cache = new Map<string, CacheEntry>();

  app.get('/api/node-sensors', async (_req, reply) => {
    const cached = cache.get('all');
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }

    if (!influxReady(ctx)) {
      const empty: NodeSensorsResponse = { timeframe: '1h', nodes: [], smart: [], sensors: [], zfs: [], failedUnits: [], source: 'empty' };
      cache.set('all', { at: Date.now(), value: empty });
      reply.send(empty);
      return;
    }

    const db = ctx.influx.rawDb;

    // --- SMART : dernier point par (node, device) ---
    let smart: SmartDevice[] = [];
    try {
      const smartRows = await ctx.influx!.querySql<Record<string, string | number | null>>(
        db,
        `SELECT node, device, model, serial_no, health_ok, temp_c, power_on_hours, power_cycle_count,
                reallocated_sectors_count, pending_sector_count, uncorrectable_sector_count, udma_crc_errors,
                percentage_used, available_spare, critical_warning, time
         FROM smart_device WHERE time >= now() - INTERVAL '1h'
         ORDER BY time DESC`,
      );
      const smartMap = new Map<string, SmartDevice>();
      for (const r of smartRows) {
        const key = `${r.node}/${r.device}`;
        if (!smartMap.has(key)) {
          smartMap.set(key, {
            node: String(r.node ?? ''),
            device: String(r.device ?? ''),
            model: (r.model as string) ?? null,
            serialNo: (r.serial_no as string) ?? null,
            healthOk: (r.health_ok as unknown) === true || r.health_ok === 1 || r.health_ok === 'true' || r.health_ok === 'True',
            tempC: (r.temp_c as number) ?? null,
            powerOnHours: (r.power_on_hours as number) ?? null,
            powerCycleCount: (r.power_cycle_count as number) ?? null,
            reallocatedSectors: (r.reallocated_sectors_count as number) ?? null,
            pendingSectors: (r.pending_sector_count as number) ?? null,
            uncorrectableSectors: (r.uncorrectable_sector_count as number) ?? null,
            udmaCrcErrors: (r.udma_crc_errors as number) ?? null,
            percentageUsed: (r.percentage_used as number) ?? null,
            availableSpare: (r.available_spare as number) ?? null,
            criticalWarning: (r.critical_warning as number) ?? null,
            lastSeen: influxTsToUnix(r.time as string),
          });
        }
      }
      smart = [...smartMap.values()];
    } catch (err) {
      ctx.logger.warn(`node-sensors : SMART indisponible (${(err as Error).message})`);
    }

    // --- Capteurs : dernier point par (node, chip, feature) ---
    let sensors: SensorReading[] = [];
    try {
      const sensorRows = await ctx.influx!.querySql<Record<string, string | number | null>>(
        db,
        `SELECT node, chip, feature, temp_input, temp_crit, fan_input, in_input, time
         FROM sensors WHERE time >= now() - INTERVAL '1h'
         ORDER BY time DESC`,
      );
      const sensorMap = new Map<string, SensorReading>();
      for (const r of sensorRows) {
        const key = `${r.node}/${r.chip}/${r.feature}`;
        if (!sensorMap.has(key)) {
          sensorMap.set(key, {
            node: String(r.node ?? ''),
            chip: String(r.chip ?? ''),
            feature: String(r.feature ?? ''),
            tempInput: (r.temp_input as number) ?? null,
            tempCrit: (r.temp_crit as number) ?? null,
            fanInput: (r.fan_input as number) ?? null,
            inInput: (r.in_input as number) ?? null,
            lastSeen: influxTsToUnix(r.time as string),
          });
        }
      }
      sensors = [...sensorMap.values()];
    } catch (err) {
      ctx.logger.warn(`node-sensors : capteurs indisponibles (${(err as Error).message})`);
    }

    // --- ZFS ARC : dernier point par node (colonnes arcstats_*) ---
    let zfs: ZfsStatus[] = [];
    try {
      const zfsRows = await ctx.influx!.querySql<Record<string, string | number | null>>(
        db,
        `SELECT node, arcstats_hits, arcstats_misses, arcstats_size, time
         FROM zfs WHERE time >= now() - INTERVAL '1h'
         ORDER BY time DESC`,
      );
      const zfsMap = new Map<string, ZfsStatus>();
      for (const r of zfsRows) {
        const key = String(r.node ?? '');
        if (!zfsMap.has(key)) {
          zfsMap.set(key, {
            node: key,
            arcHits: (r.arcstats_hits as number) ?? null,
            arcMisses: (r.arcstats_misses as number) ?? null,
            arcSize: (r.arcstats_size as number) ?? null,
            arcCacheSize: null,
            poolName: null,
            poolState: null,
            poolSize: null,
            poolAllocated: null,
            poolFree: null,
            lastSeen: influxTsToUnix(r.time as string),
          });
        }
      }
      zfs = [...zfsMap.values()];
    } catch (err) {
      ctx.logger.warn(`node-sensors : ZFS indisponible (${(err as Error).message})`);
    }

    // --- Unités systemd en échec ---
    let failedUnits: FailedUnit[] = [];
    try {
      const unitRows = await ctx.influx!.querySql<Record<string, string | number | null>>(
        db,
        `SELECT node, name, active, sub, load, time
         FROM systemd_units WHERE time >= now() - INTERVAL '1h'
           AND (active = 'failed' OR load = 'error' OR sub = 'dead')
         ORDER BY time DESC`,
      );
      const unitMap = new Map<string, FailedUnit>();
      for (const r of unitRows) {
        const key = `${r.node}/${r.name}`;
        if (!unitMap.has(key)) {
          unitMap.set(key, {
            node: String(r.node ?? ''),
            name: String(r.name ?? ''),
            active: String(r.active ?? ''),
            sub: String(r.sub ?? ''),
            load: String(r.load ?? ''),
            lastSeen: influxTsToUnix(r.time as string),
          });
        }
      }
      failedUnits = [...unitMap.values()];
    } catch (err) {
      ctx.logger.warn(`node-sensors : systemd_units indisponibles (${(err as Error).message})`);
    }

    const nodes = [...new Set([...smart, ...sensors].map((x) => x.node))].sort();
    const body: NodeSensorsResponse = {
      timeframe: '1h',
      nodes,
      smart,
      sensors,
      zfs,
      failedUnits,
      source: nodes.length > 0 ? 'influx' : 'empty',
    };
    cache.set('all', { at: Date.now(), value: body });
    reply.send(body);
  });
}
