import type { FailedUnit, SensorReading, SensorAlarmData, SmartDevice, ZfsStatus } from '@prox4u/shared';
import { influxTsToUnix, type SqlRow } from '../../core/influx.js';
import type { AppContext } from '../../core/poller.js';

/**
 * Source de données capteurs (InfluxDB raw) — partagée entre :
 *  - la route GET /api/node-sensors (état courant, cache 1 min, routes.ts) ;
 *  - le MOTEUR D'ALARMES (GitHub #4) — règles capteurs SMART / température /
 *    unité systemd / pool ZFS (centreonnsca, cache 60 s).
 *
 * Chaque query est isolée dans son propre try/catch : une table absente ou une
 * colonne inconnue ne fait pas perdre les autres sections (robustesse).
 * InfluxDB désactivé → données vides (pas d'échantillon, pas d'erreur).
 */

function influxReady(ctx: AppContext): boolean {
  return !!ctx.influx && ctx.influx.enabled;
}

/**
 * Santé SMART — tri-state. `null` (champ absent / NULL) = INCONNUE, pas un
 * échec : sur du vrai matériel, un volume logique RAID ou un disque sans SMART
 * renvoie aussi NULL — le mapper en `false` afficherait « CRITIQUE » à tort
 * (faux positif). InfluxDB 3 renvoie un boolean `true`/`false`, avec repli sur
 * `1`/`0`/`'true'`/`'false'` (représentations possibles selon la source).
 */
function parseHealthOk(v: string | number | boolean | null | undefined): boolean | null {
  if (v === true || v === 1 || v === 'true' || v === 'True') return true;
  if (v === false || v === 0 || v === 'false' || v === 'False') return false;
  return null; // NULL / absent / valeur inattendue → inconnu
}

/**
 * État courant des capteurs (dernier point par cible, fenêtre 1 h).
 * 6 requêtes : SMART, capteurs, ZFS ARC, pools ZFS (table `zpool`), unités
 * systemd en échec, TOUTES les unités (sans filtre — l'engine d'alarmes en a
 * besoin pour distinguer « unité saine » de « unité inconnue »).
 */
export async function fetchSensorAlarmData(ctx: AppContext): Promise<SensorAlarmData> {
  const empty: SensorAlarmData = { smart: [], sensors: [], zfs: [], zfsPools: [], failedUnits: [], units: [] };
  if (!influxReady(ctx)) return empty;
  const db = ctx.influx.rawDb;

  // --- SMART : dernier point par (node, device) ---
  let smart: SmartDevice[] = [];
  try {
    const smartRows = await ctx.influx!.querySql<SqlRow>(
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
          healthOk: parseHealthOk(r.health_ok),
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
    const sensorRows = await ctx.influx!.querySql<SqlRow>(
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
    const zfsRows = await ctx.influx!.querySql<SqlRow>(
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

  // --- Pools ZFS : dernier point par (node, pool) — table `zpool` (plugin
  // Telegraf zfs : ARC dans `zfs`, état des pools dans `zpool`). ---
  let zfsPools: ZfsStatus[] = [];
  try {
    const poolRows = await ctx.influx!.querySql<SqlRow>(
      db,
      `SELECT node, pool, state, time
       FROM zpool WHERE time >= now() - INTERVAL '1h'
       ORDER BY time DESC`,
    );
    const poolMap = new Map<string, ZfsStatus>();
    for (const r of poolRows) {
      const key = `${r.node}/${r.pool}`;
      if (!poolMap.has(key)) {
        poolMap.set(key, {
          node: String(r.node ?? ''),
          arcHits: null,
          arcMisses: null,
          arcSize: null,
          arcCacheSize: null,
          poolName: String(r.pool ?? ''),
          poolState: (r.state == null ? null : String(r.state)) || null,
          poolSize: null,
          poolAllocated: null,
          poolFree: null,
          lastSeen: influxTsToUnix(r.time as string),
        });
      }
    }
    zfsPools = [...poolMap.values()];
  } catch (err) {
    ctx.logger.warn(`node-sensors : pools ZFS indisponibles (${(err as Error).message})`);
  }

  // --- Unités systemd en échec ---
  // SEULES les vraies alertes : active='failed' (unité échouée) ou load='error'
  // (fichier unit illisible/erroné). On NE filtre PAS sur sub='dead' : « inactive
  // (dead) » est l'état de repos NORMAL des one-shots (terminés au boot / par
  // timer), des unités à la demande (rescue, hibernate…) et des non-installées
  // (load='not-found') — avec sub='dead', la section serait noyée (~170 lignes
  // par nœud d'états sains, le vrai échec enfoui).
  let failedUnits: FailedUnit[] = [];
  try {
    const unitRows = await ctx.influx!.querySql<SqlRow>(
      db,
      `SELECT node, name, active, sub, load, time
       FROM systemd_units WHERE time >= now() - INTERVAL '1h'
         AND (active = 'failed' OR load = 'error')
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

  // --- TOUTES les unités (dernier point par (node, name), SANS filtre) ---
  // Sert à l'engine d'alarmes (GitHub #4) : une règle « unité échouée » ne doit
  // pas passer en faux OK quand l'unité est inconnue (agent down / mauvais nom)
  // — l'absence dans `failedUnits` seule ne distingue pas « saine » de « inconnue ».
  // Sert aussi aux suggestions du formulaire de règle (~170 unités/nœud).
  let units: FailedUnit[] = [];
  try {
    const allUnitRows = await ctx.influx!.querySql<SqlRow>(
      db,
      `SELECT node, name, active, sub, load, time
       FROM systemd_units WHERE time >= now() - INTERVAL '1h'
       ORDER BY time DESC`,
    );
    const allUnitMap = new Map<string, FailedUnit>();
    for (const r of allUnitRows) {
      const key = `${r.node}/${r.name}`;
      if (!allUnitMap.has(key)) {
        allUnitMap.set(key, {
          node: String(r.node ?? ''),
          name: String(r.name ?? ''),
          active: String(r.active ?? ''),
          sub: String(r.sub ?? ''),
          load: String(r.load ?? ''),
          lastSeen: influxTsToUnix(r.time as string),
        });
      }
    }
    units = [...allUnitMap.values()];
  } catch (err) {
    ctx.logger.warn(`node-sensors : unités systemd indisponibles (${(err as Error).message})`);
  }

  return { smart, sensors, zfs, zfsPools, failedUnits, units };
}
