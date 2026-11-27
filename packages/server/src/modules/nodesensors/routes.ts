import type { FastifyInstance } from 'fastify';
import type {
  NodeSensorsResponse,
  SensorThresholds,
  SensorThresholdEntry,
  SensorHistoryPoint,
  SensorHistoryResponse,
  SmartHistoryResponse,
} from '@prox4u/shared';
import { sensorKey } from '@prox4u/shared';
import { influxTsToUnix } from '../../core/influx.js';
import type { AppContext } from '../../core/poller.js';
import { fetchSensorAlarmData } from './data.js';
import type { SensorThresholdStore } from './thresholds.js';

const CACHE_TTL_MS = 60_000; // 1 min — les données Telegraf arrivent toutes les 10 s

interface CacheEntry {
  at: number;
  value: NodeSensorsResponse;
}

function influxReady(ctx: AppContext): boolean {
  return !!ctx.influx && ctx.influx.enabled;
}

/** Literal SQL (DuckDB) : échappe les guillemets simples — les noms de capteurs
 *  viennent de Telegraf, mais la requête passe par des query string : on n'ouvre
 *  jamais de SQL injection. */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * GET /api/node-sensors — métriques locales Telegraf (SMART, capteurs, ZFS, unités systemd).
 * Cache 1 min. Source : base `raw` (les mesures Telegraf arrivent directement dans raw).
 * Les requêtes sont factorisées dans data.ts (`fetchSensorAlarmData`) — partagées
 * avec le moteur d'alarmes (GitHub #4) ; chaque query y est isolée dans son
 * propre try/catch (une table absente ne fait pas perdre les autres sections).
 */
export function registerNodeSensors(app: FastifyInstance, ctx: AppContext, store: SensorThresholdStore): void {
  const cache = new Map<string, CacheEntry>();

  app.get('/api/node-sensors', async (_req, reply) => {
    // Les seuils personnalisés changent rarement : on les relit à chaque build
    // (pas de cache dédié), mais ils ne forcent pas un re-query InfluxDB.
    const thresholds = store.getThresholds();
    const cached = cache.get('all');
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      reply.send({ ...cached.value, sensorThresholds: thresholds });
      return;
    }

    let body: NodeSensorsResponse;
    try {
      const data = await fetchSensorAlarmData(ctx);
      const nodes = [...new Set([...data.smart, ...data.sensors].map((x) => x.node))].sort();
      body = {
        timeframe: '1h',
        nodes,
        smart: data.smart,
        sensors: data.sensors,
        zfs: data.zfs,
        failedUnits: data.failedUnits,
        source: nodes.length > 0 ? 'influx' : 'empty',
        sensorThresholds: thresholds,
      };
    } catch (err) {
      ctx.logger.warn(`node-sensors : données indisponibles (${(err as Error).message})`);
      body = { timeframe: '1h', nodes: [], smart: [], sensors: [], zfs: [], failedUnits: [], source: 'empty', sensorThresholds: thresholds };
    }
    cache.set('all', { at: Date.now(), value: body });
    reply.send(body);
  });
}

// ---------------------------------------------------------------------------
// Historique des valeurs — fenêtres « historique » de la page
// ---------------------------------------------------------------------------
//
// GET /api/node-sensors-history?node=&chip=&feature=&range=month|year  (table `sensors`)
// GET /api/smart-device-history?node=&device=&range=month|year         (table `smart_device`)
//
// Série de température d'UN capteur / d'UN disque, pour le graphe « Historique
// des valeurs » ouvert depuis l'icône des tables « Capteurs » et « Santé
// disques (SMART) ». Pattern du /api/storage-datastore-history : double source
// (raw haute résolution / consolidated long terme), fusion dédoublonnée,
// cache 5 min.
//
// Résolution : les tables Telegraf raw reçoivent un point toutes les 10 s —
// ~270k points sur 31 j par capteur, trop pour un graphe navigateur. On
// bucket donc en **10 min** côté raw (le consolidated est déjà en buckets
// 15 min, écrit par le consolidator) : ~2900 points sur 31 j, ~8900 sur 1 an.
// Les TROUS (nœud éteint / sans mesure) sont réels : ils ne sont pas comblés,
// la série est sparse et le front les affiche tels quels.
// Les disques à `temp_c = 0` (pas de capteur, cf. smartTempDisplay) sont
// exclus de la série — sinon un disque sans sonde tracerait une ligne à 0 °C.

type SensorHistoryRange = 'month' | 'year';
const SENSOR_HISTORY_CACHE_TTL_MS = 5 * 60_000; // 5 min

interface SensorHistoryCacheEntry {
  at: number;
  value: SensorHistoryResponse;
}

interface SmartHistoryCacheEntry {
  at: number;
  value: SmartHistoryResponse;
}

/** Lit un champ string d'un SqlRow de DuckDB (InfluxDB 3 renvoie string|number|null). */
function rowStr(r: Record<string, string | number | null | boolean | undefined>, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Série de température fusionnée (raw buckets 10 min + consolidated buckets 15 min)
 * pour une table + une identité. Au même horodatage, le **raw prime** (plus fin) ;
 * le consolidé n'écrase jamais un point raw. `keep` filtre les valeurs
 * (ex. disque 0 °C = pas de lecture). Triée par temps croissant.
 */
async function mergedTempBuckets(
  ctx: AppContext,
  table: string,
  where: string,
  fromSec: number,
  toSec: number,
  tempField: string,
  keep: (temp: number) => boolean,
): Promise<SensorHistoryPoint[]> {
  // Bornes ISO UTC explicites (DataFusion ne coerce pas timestamp >= entier).
  const iso = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
  const [rawRows, aggRows] = await Promise.all([
    // raw : buckets 10 min (les points 10 s seraient ~270k sur 31 j). Fenêtre ≤ 31 j
    // = 4 464 fichiers < --query-file-limit → requête simple.
    ctx.influx!.querySql<Record<string, string | number | null>>(
      ctx.influx.rawDb,
      `SELECT date_bin(INTERVAL '10 minutes', time) AS t, max(${tempField}) AS temp
       FROM ${table} WHERE ${where} AND time >= '${iso(fromSec)}' AND time < '${iso(toSec)}'
         AND ${tempField} IS NOT NULL
       GROUP BY t ORDER BY t`,
    ),
    // consolidated : buckets 15 min (rétention illimitée) — l'année. Fenêtre long terme
    // (> ~69 j = --query-file-limit) → requête CHUNKÉE (P2, plan-limites-influxdb3.md).
    ctx.influx!.querySqlChunked<Record<string, string | number | null>>(
      ctx.influx.aggDb,
      (f, t) =>
        `SELECT date_bin(INTERVAL '15 minutes', time) AS t, max(${tempField}) AS temp
       FROM ${table} WHERE ${where} AND time >= '${f}' AND time < '${t}'
         AND ${tempField} IS NOT NULL
       GROUP BY t ORDER BY t`,
      fromSec,
      toSec,
    ),
  ]);
  const byTime = new Map<number, number>();
  for (const r of aggRows) {
    const temp = Number(r.temp);
    if (Number.isFinite(temp) && keep(temp)) byTime.set(influxTsToUnix(rowStr(r, 't')), temp);
  }
  for (const r of rawRows) {
    const temp = Number(r.temp);
    if (Number.isFinite(temp) && keep(temp)) byTime.set(influxTsToUnix(rowStr(r, 't')), temp);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, temp]) => ({ time, temp }));
}

/**
 * Historique de température d'un capteur (table `sensors`).
 *
 * Double source (pattern datastore-history) :
 *  - **raw** (rétention 31 j, points 10 s) → bucket **10 min** : la période récente en fine résolution ;
 *  - **consolidated** (rétention ∞, buckets 15 min écrits par le consolidator) : l'historique long terme.
 * Fusion : au même horodatage, le point **raw prime** (plus fin) ; le consolidated
 * n'écrase jamais un point raw déjà présent.
 */
async function computeSensorHistory(
  ctx: AppContext,
  node: string,
  chip: string,
  feature: string,
  range: SensorHistoryRange,
  thresholds: SensorThresholds,
): Promise<SensorHistoryResponse> {
  const empty: SensorHistoryResponse = { node, chip, feature, range, points: [], threshold: null, thresholdCustom: false, thresholdFirmware: null, source: 'empty' };
  const windowDays = range === 'month' ? 31 : 365;
  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - windowDays * 86_400;
  const where = `node = ${sqlStr(node)} AND chip = ${sqlStr(chip)} AND feature = ${sqlStr(feature)}`;

  const points = await mergedTempBuckets(ctx, 'sensors', where, fromSec, toSec, 'temp_input', () => true);
  if (points.length === 0) return empty;

  // Seuil effectif (ligne de référence du graphe) : perso si défini, sinon
  // firmware (dernier `temp_crit` connu, fenêtre 1 h — le firmware ne bouge pas).
  const custom = thresholds[sensorKey({ node, chip, feature })] ?? null;
  let firmware: number | null = null;
  try {
    const fwRows = await ctx.influx!.querySql<Record<string, string | number | null>>(
      ctx.influx.rawDb,
      `SELECT max(temp_crit) AS temp_crit
       FROM sensors WHERE ${where} AND time >= now() - INTERVAL '1h'`,
    );
    const v = Number(fwRows[0]?.temp_crit);
    firmware = Number.isFinite(v) ? v : null;
  } catch (err) {
    ctx.logger.warn(`node-sensors-history : seuil firmware inconnu (${(err as Error).message})`);
  }

  return {
    ...empty,
    points,
    threshold: custom ?? firmware,
    thresholdCustom: custom !== null,
    thresholdFirmware: firmware,
    source: 'influx',
  };
}

export function registerSensorHistoryRoute(app: FastifyInstance, ctx: AppContext, store: SensorThresholdStore): void {
  const historyCache = new Map<string, SensorHistoryCacheEntry>();

  app.get('/api/node-sensors-history', async (req, reply) => {
    const q = req.query as { node?: string; chip?: string; feature?: string; range?: string };
    const node = typeof q.node === 'string' ? q.node.trim() : '';
    const chip = typeof q.chip === 'string' ? q.chip.trim() : '';
    const feature = typeof q.feature === 'string' ? q.feature.trim() : '';
    // Identité de capteur requise (clé = node/chip/feature) + longueur bornée
    // (les noms Telegraf sont courts ; au-delà = requête malformée, pas de SQL ouvert).
    if (!node || !chip || !feature || node.length > 128 || chip.length > 128 || feature.length > 128) {
      reply.code(400).send({ error: 'invalid', code: 'bad-sensor', message: 'node, chip et feature sont requis' });
      return;
    }
    const range: SensorHistoryRange = q.range === 'month' ? 'month' : 'year';
    const cacheKey = `${node}/${chip}/${feature}:${range}`;
    const cached = historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SENSOR_HISTORY_CACHE_TTL_MS) return cached.value;

    let value: SensorHistoryResponse;
    if (influxReady(ctx)) {
      try {
        // Les seuils perso sont relus ici (rarement modifiés) — pas de cache dédié.
        value = await computeSensorHistory(ctx, node, chip, feature, range, store.getThresholds());
      } catch (err) {
        ctx.logger.warn(`node-sensors-history(${node}/${chip}/${feature}) : InfluxDB indisponible (${(err as Error).message})`);
        value = { node, chip, feature, range, points: [], threshold: null, thresholdCustom: false, thresholdFirmware: null, source: 'empty' };
      }
    } else {
      value = { node, chip, feature, range, points: [], threshold: null, thresholdCustom: false, thresholdFirmware: null, source: 'empty' };
    }
    historyCache.set(cacheKey, { at: Date.now(), value });
    return value;
  });
}

/**
 * Historique de température d'un DISQUE (table `smart_device`, colonne `temp_c`).
 * Même pattern que l'historique capteur (double source, fusion, cache 5 min),
 * sans seuil : les disques n'exposent pas de `temp_crit` — le front trace la
 * référence fixe de la table SMART (80 °C). Les points à 0 °C (pas de capteur)
 * sont exclus — sinon un disque sans sonde tracerait une ligne plate à 0 °C.
 */
async function computeSmartHistory(
  ctx: AppContext,
  node: string,
  device: string,
  range: SensorHistoryRange,
): Promise<SmartHistoryResponse> {
  const empty: SmartHistoryResponse = { node, device, range, points: [], source: 'empty' };
  const windowDays = range === 'month' ? 31 : 365;
  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - windowDays * 86_400;
  const where = `node = ${sqlStr(node)} AND device = ${sqlStr(device)}`;
  const points = await mergedTempBuckets(ctx, 'smart_device', where, fromSec, toSec, 'temp_c', (t) => t > 0);
  if (points.length === 0) return empty;
  return { ...empty, points, source: 'influx' };
}

export function registerSmartHistoryRoute(app: FastifyInstance, ctx: AppContext): void {
  const historyCache = new Map<string, SmartHistoryCacheEntry>();

  app.get('/api/smart-device-history', async (req, reply) => {
    const q = req.query as { node?: string; device?: string; range?: string };
    const node = typeof q.node === 'string' ? q.node.trim() : '';
    const device = typeof q.device === 'string' ? q.device.trim() : '';
    // Identité disque requise (clé = node/device) + longueur bornée.
    if (!node || !device || node.length > 128 || device.length > 128) {
      reply.code(400).send({ error: 'invalid', code: 'bad-device', message: 'node et device sont requis' });
      return;
    }
    const range: SensorHistoryRange = q.range === 'month' ? 'month' : 'year';
    const cacheKey = `${node}/${device}:${range}`;
    const cached = historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SENSOR_HISTORY_CACHE_TTL_MS) return cached.value;

    let value: SmartHistoryResponse;
    if (influxReady(ctx)) {
      try {
        value = await computeSmartHistory(ctx, node, device, range);
      } catch (err) {
        ctx.logger.warn(`smart-device-history(${node}/${device}) : InfluxDB indisponible (${(err as Error).message})`);
        value = { node, device, range, points: [], source: 'empty' };
      }
    } else {
      value = { node, device, range, points: [], source: 'empty' };
    }
    historyCache.set(cacheKey, { at: Date.now(), value });
    return value;
  });
}

// ---------------------------------------------------------------------------
// Seuils capteurs personnalisés — onglet Administration
// ---------------------------------------------------------------------------
//
// GET    /api/admin/sensor-thresholds                    → seuils perso + liste des capteurs (firmware)
// PUT    /api/admin/sensor-thresholds                    → remplace le jeu de seuils (clamp perso ≤ firmware)
// DELETE /api/admin/sensor-thresholds                    → tout réinitialiser (retour firmware)
// DELETE /api/admin/sensor-thresholds/:node/:chip/:feat  → réinitialiser un capteur
//
// Toutes les routes sont sous /api/admin/* → guard rôle admin (voir skill general §auth).

interface FirmwareSensor {
  node: string;
  chip: string;
  feature: string;
  temp: number | null;
  firmware: number | null;
}

/** Dernier point (température + seuil firmware) par capteur, sur la fenêtre 1 h. */
async function fetchFirmwareSensors(ctx: AppContext): Promise<Map<string, FirmwareSensor>> {
  const out = new Map<string, FirmwareSensor>();
  if (!influxReady(ctx)) return out;
  try {
    const rows = await ctx.influx!.querySql<Record<string, string | number | null>>(
      ctx.influx.rawDb,
      `SELECT node, chip, feature, temp_input, temp_crit, time
       FROM sensors WHERE time >= now() - INTERVAL '1h'
       ORDER BY time DESC`,
    );
    for (const r of rows) {
      const key = `${r.node}/${r.chip}/${r.feature}`;
      if (!out.has(key)) {
        out.set(key, {
          node: String(r.node ?? ''),
          chip: String(r.chip ?? ''),
          feature: String(r.feature ?? ''),
          temp: (r.temp_input as number) ?? null,
          firmware: (r.temp_crit as number) ?? null,
        });
      }
    }
  } catch (err) {
    ctx.logger.warn(`sensor-thresholds : lecture des capteurs indisponible (${(err as Error).message})`);
  }
  return out;
}

/** Construit la réponse admin : seuils perso + capteurs (temp + firmware + perso éventuel). */
async function buildThresholdsResponse(ctx: AppContext, store: SensorThresholdStore): Promise<{ thresholds: SensorThresholds; sensors: SensorThresholdEntry[] }> {
  const thresholds = store.getThresholds();
  const firmware = await fetchFirmwareSensors(ctx);
  const sensors: SensorThresholdEntry[] = [...firmware.values()].map((s) => ({
    node: s.node,
    chip: s.chip,
    feature: s.feature,
    temp: s.temp,
    firmware: s.firmware,
    custom: thresholds[sensorKey(s)] ?? null,
  }));
  // Capteurs ayant un seuil perso mais pas (plus) de lecture firmware récente :
  // on les expose quand même (le seuil perso doit rester éditable/supprimable).
  for (const key of Object.keys(thresholds)) {
    if (!firmware.has(key)) {
      const [node, chip, feature] = key.split('/');
      sensors.push({ node, chip, feature, temp: null, firmware: null, custom: thresholds[key] });
    }
  }
  sensors.sort((a, b) => sensorKey(a).localeCompare(sensorKey(b)));
  return { thresholds, sensors };
}

/** Valide + clamp un jeu de seuils : valeurs finies > 0, et perso ≤ firmware. */
function clampThresholds(
  desired: Record<string, unknown>,
  firmware: Map<string, { firmware: number | null }>,
): SensorThresholds {
  const out: SensorThresholds = {};
  for (const [key, raw] of Object.entries(desired)) {
    const v = typeof raw === 'string' ? Number(raw) : (raw as number);
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue; // valeur invalide → ignorée
    const fw = firmware.get(key)?.firmware;
    out[key] = fw !== null && fw !== undefined && v > fw ? fw : v; // clamp : jamais au-dessus du firmware
  }
  return out;
}

export function registerSensorThresholdRoutes(app: FastifyInstance, ctx: AppContext, store: SensorThresholdStore): void {
  app.get('/api/admin/sensor-thresholds', async (_req, reply) => {
    reply.send(await buildThresholdsResponse(ctx, store));
  });

  app.put('/api/admin/sensor-thresholds', async (req, reply) => {
    const body = (req.body ?? {}) as { thresholds?: Record<string, unknown> };
    if (!body.thresholds || typeof body.thresholds !== 'object' || Array.isArray(body.thresholds)) {
      reply.code(400).send({ error: 'invalid', code: 'bad-thresholds', message: '`thresholds` doit être un objet « clé → °C »' });
      return;
    }
    const firmware = await fetchFirmwareSensors(ctx);
    const clamped = clampThresholds(body.thresholds, firmware);
    store.setThresholds(clamped);
    reply.send(await buildThresholdsResponse(ctx, store));
  });

  app.delete('/api/admin/sensor-thresholds', async (_req, reply) => {
    store.clearAll();
    reply.send(await buildThresholdsResponse(ctx, store));
  });

  app.delete('/api/admin/sensor-thresholds/:node/:chip/:feature', async (req, reply) => {
    const { node, chip, feature } = req.params as { node: string; chip: string; feature: string };
    store.deleteThreshold(sensorKey({ node, chip, feature }));
    reply.send(await buildThresholdsResponse(ctx, store));
  });
}
