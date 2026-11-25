import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InfluxHistoryRange, InfluxHistoryResponse } from '@prox4u/shared';
import type { AppContext } from '../../core/poller.js';
import { influxTsToUnix, type InfluxQueryStats, type InfluxWriteStats } from '../../core/influx.js';

/**
 * Module « InfluxDB 3 Core » — vision + action (plan-module-influxdb.md).
 *
 * LECTURE (ouverte à toute session) :
 *  - GET /api/influxdb          : état (ping/version/bases), compteurs d'écriture,
 *                                 stats de lecture, headroom fichiers + canAct.
 *  - GET /api/influxdb/history  : série temporelle (file, abandons, latence, enfilement)
 *                                 depuis influxdb_self (base raw), buckets adaptatifs,
 *                                 cache 5 min.
 *  - GET /api/influxdb/tables   : liste des tables d'une base (défaut consolidated)
 *                                 via information_schema (filtre schema iox), cache 5 min.
 *
 * ACTIONS (guard : rôle admin OU membre d'un groupe INFLUX_ACTION_GROUPS) :
 *  - POST /api/influxdb/actions/flush               : flush immédiat de la file.
 *  - POST /api/influxdb/actions/archive/run         : cycle d'archivage immédiat.
 *  - POST /api/influxdb/actions/archive/reset       : réinitialise l'état d'archivage.
 *  - POST /api/influxdb/actions/export              : export CSV ad-hoc multi-tables
 *                                                     (tables[] + range → 1 ZIP,
 *                                                     1 CSV par table ; repli table
 *                                                     single → [table]).
 *  - GET  /api/influxdb/actions/download            : télécharge un fichier d'export
 *                                                     (file=basename, pattern export-*,
 *                                                     Content-Disposition attachment).
 *  - POST /api/influxdb/actions/database/recreate   : drop + create (rétention).
 *  - POST /api/influxdb/actions/database/drop       : supprime une base (destructif).
 *  - POST /api/influxdb/actions/table/drop          : supprime une table (destructif).
 *
 * Chaque action est loggée dans l'audit admin (action `influxdb.action`).
 * Les noms db/table sont validés (`/^[a-zA-Z0-9_-]+$/`) avant toute interpolation.
 */

function influxReady(ctx: AppContext): boolean {
  return !!ctx.influx && ctx.influx.enabled;
}

/** Noms de bases/tables : alphanumérique + `_`/`-`, borné (pas d'injection SQL/chemin). */
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
function validName(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && NAME_RE.test(s);
}

/** Rétention InfluxDB (ex. `2y`, `365d`) — absente = infinie. */
const RETENTION_RE = /^\d+(s|m|h|d|w|y)$/;

/**
 * canAct : même logique que le guard — rôle admin OU membre d'un des groupes
 * configurés (INFLUX_ACTION_GROUPS). Calculé serveur pour que le front masque/
 * affiche le panneau Actions sans connaître la liste des groupes.
 */
function canAct(ctx: AppContext, req: FastifyRequest): boolean {
  const u = req.authUser;
  if (!u) return false;
  if (u.role === 'admin') return true;
  const allowed = new Set(ctx.config.influxActionGroups);
  return u.groupIds.some((gid) => allowed.has(ctx.auth.store.groupById(gid)?.name ?? ''));
}

/** Traces une action dans l'audit admin (acteur = user de la session). */
function auditAction(ctx: AppContext, req: FastifyRequest, target: string, details?: Record<string, unknown>): void {
  const actorId = req.authUser?.id;
  if (!actorId) return;
  const username = ctx.auth.store.userById(actorId)?.username ?? actorId;
  ctx.auth.audit.append({ id: actorId, username }, 'influxdb.action', target, details);
}

// ---------- Types de réponse ----------

export interface InfluxDbResponse {
  enabled: boolean;
  ping: boolean;
  version: string | null;
  databases: Array<{ name: string; retention: string | null }>;
  write: InfluxWriteStats;
  query: InfluxQueryStats;
  fileEstimate: {
    chunkDays: number;
    chunkFiles: number;
    yearFiles: number;
    fileLimit: number;
    headroom: 'ok' | 'warn' | 'crit';
  };
  /** état d'archivage (consolidated → CSV) — null si l'archiver n'est pas monté. */
  archive: { lastArchivedTs: number; archiveDir: string; fileCount: number; totalBytes: number } | null;
  /** true si la session peut lancer les actions (admin ou groupe configuré). */
  canAct: boolean;
}

/** Buckets adaptatifs : 24 h → 5 min · 7 j → 15 min · 30 j → 1 h. */
const HISTORY_TF: Record<InfluxHistoryRange, { bucket: string; window: string }> = {
  '24h': { bucket: '5 minutes', window: '24 hours' },
  '7d': { bucket: '15 minutes', window: '7 days' },
  '30d': { bucket: '1 hour', window: '30 days' },
};
const HISTORY_CACHE_TTL_MS = 5 * 60_000;

/** Convertit une valeur SQL en nombre (0 si null/NaN). */
function num(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function registerInfluxDbRoutes(app: FastifyInstance, ctx: AppContext): void {
  const historyCache = new Map<string, { at: number; value: InfluxHistoryResponse }>();
  const tablesCache = new Map<string, { at: number; value: string[] }>();

  // ---------- LECTURE ----------

  app.get('/api/influxdb', async (req, _reply): Promise<InfluxDbResponse> => {
    const influx = ctx.influx;
    const can = canAct(ctx, req);
    const archive = ctx.archiver ? ctx.archiver.getState() : null;
    if (!influx.enabled) {
      return {
        enabled: false,
        ping: false,
        version: null,
        databases: [],
        write: influx.getStats(),
        query: influx.getQueryStats(),
        fileEstimate: influx.fileEstimate(),
        archive,
        canAct: can,
      };
    }
    // Sous-lectures indépendantes et bornées : une qui échoue ne casse pas la route.
    const [ping, info, databases] = await Promise.all([influx.ping(), influx.getServerInfo(), influx.listDatabases()]);
    return {
      enabled: true,
      ping,
      version: info.version,
      databases,
      write: influx.getStats(),
      query: influx.getQueryStats(),
      fileEstimate: influx.fileEstimate(),
      archive,
      canAct: can,
    };
  });

  app.get('/api/influxdb/history', async (req, _reply): Promise<InfluxHistoryResponse> => {
    const q = req.query as { range?: string };
    const range: InfluxHistoryRange = q.range === '7d' ? '7d' : q.range === '30d' ? '30d' : '24h';
    const cached = historyCache.get(range);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL_MS) return cached.value;

    let value: InfluxHistoryResponse;
    if (influxReady(ctx)) {
      try {
        const { bucket, window } = HISTORY_TF[range];
        const rows = await ctx.influx.querySql<Record<string, string | number | null>>(
          ctx.influx.rawDb,
          `SELECT date_bin(INTERVAL '${bucket}', time) AS t,
                  max(queue_depth) AS queue_depth,
                  max(dropped_total) AS dropped_total,
                  avg(last_query_ms) AS query_ms,
                  max(enqueued_total) AS enqueued_total
           FROM influxdb_self
           WHERE time >= now() - INTERVAL '${window}'
           GROUP BY t ORDER BY t`,
        );
        value = {
          range,
          points: rows.map((r) => ({
            t: influxTsToUnix(r.t),
            queueDepth: num(r.queue_depth),
            dropped: num(r.dropped_total),
            queryMs: num(r.query_ms),
            enqueued: num(r.enqueued_total),
          })),
          source: rows.length > 0 ? 'influx' : 'empty',
        };
      } catch (err) {
        ctx.logger.warn(`influxdb-history(${range}) : InfluxDB indisponible (${(err as Error).message})`);
        value = { range, points: [], source: 'empty' };
      }
    } else {
      value = { range, points: [], source: 'disabled' };
    }
    historyCache.set(range, { at: Date.now(), value });
    return value;
  });

  app.get('/api/influxdb/tables', async (req, reply) => {
    if (!influxReady(ctx)) return reply.code(404).send({ error: 'not-found', code: 'influx-disabled' });
    const db = (req.query as { db?: string }).db ?? ctx.influx.aggDb;
    if (!validName(db)) return reply.code(400).send({ error: 'invalid', code: 'bad-db' });
    const cached = tablesCache.get(db);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL_MS) return { db, tables: cached.value };
    // Défensif : InfluxDB indispo en cours de requête → [] (pas de crash de la route).
    const tables = await ctx.influx.listTables(db);
    tablesCache.set(db, { at: Date.now(), value: tables });
    return { db, tables };
  });

  // ---------- ACTIONS (guard : admin ou groupe configuré) ----------

  app.post('/api/influxdb/actions/flush', async (req, reply) => {
    if (!influxReady(ctx)) return reply.code(404).send({ error: 'not-found', code: 'influx-disabled' });
    await ctx.influx.flush();
    const s = ctx.influx.getStats();
    auditAction(ctx, req, 'flush');
    return { ok: true, queueDepth: s.queueDepth, flushed: s.flushed };
  });

  app.post('/api/influxdb/actions/archive/run', async (req, reply) => {
    if (!ctx.archiver) return reply.code(503).send({ error: 'unavailable', code: 'archiver-missing' });
    const archived = await ctx.archiver.runNow();
    auditAction(ctx, req, 'archive/run', { archived });
    return { ok: true, archived };
  });

  app.post('/api/influxdb/actions/archive/reset', async (req, reply) => {
    if (!ctx.archiver) return reply.code(503).send({ error: 'unavailable', code: 'archiver-missing' });
    const lastArchivedTs = ctx.archiver.resetState();
    auditAction(ctx, req, 'archive/reset', { lastArchivedTs });
    return { ok: true, lastArchivedTs };
  });

  app.post('/api/influxdb/actions/export', async (req, reply) => {
    if (!ctx.archiver) return reply.code(503).send({ error: 'unavailable', code: 'archiver-missing' });
    const body = (req.body ?? {}) as { tables?: string[]; table?: string; from?: number; to?: number };
    // tables[] (multi-export → ZIP) ; repli legacy table (string) → [table].
    const tables =
      Array.isArray(body.tables) && body.tables.length > 0
        ? [...new Set(body.tables)]
        : validName(body.table)
          ? [body.table]
          : null;
    if (!tables) return reply.code(400).send({ error: 'invalid', code: 'bad-table' });
    if (!tables.every((t) => validName(t))) return reply.code(400).send({ error: 'invalid', code: 'bad-table' });
    const from = Number(body.from);
    const to = Number(body.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0 || from >= to) {
      return reply.code(400).send({ error: 'invalid', code: 'bad-range' });
    }
    const { file, exports } = await ctx.archiver.exportTablesZip(tables, from, to);
    auditAction(ctx, req, 'export', { tables, from, to, rows: exports.reduce((s, e) => s + e.rows, 0) });
    return { ok: true, file, exports };
  });

  app.get('/api/influxdb/actions/download', async (req, reply) => {
    if (!ctx.archiver) return reply.code(503).send({ error: 'unavailable', code: 'archiver-missing' });
    const file = (req.query as { file?: string }).file ?? '';
    // Fichiers d'export ad-hoc uniquement (ZIP multi-tables / CSV single) :
    // basename + pattern fixe → pas de path traversal (aucun « / » possible).
    if (!/^export-[\w.-]+\.(zip|csv)$/.test(file)) {
      return reply.code(400).send({ error: 'invalid', code: 'bad-file' });
    }
    const archiveDir = path.resolve(ctx.config.influx.archiveDir);
    const full = path.join(archiveDir, file);
    if (!full.startsWith(archiveDir + path.sep)) {
      return reply.code(400).send({ error: 'invalid', code: 'bad-file' });
    }
    if (!existsSync(full)) return reply.code(404).send({ error: 'not-found', code: 'file-not-found' });
    reply.header('Content-Type', file.endsWith('.zip') ? 'application/zip' : 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${file}"`);
    return reply.send(readFileSync(full));
  });

  app.post('/api/influxdb/actions/database/recreate', async (req, reply) => {
    if (!influxReady(ctx)) return reply.code(404).send({ error: 'not-found', code: 'influx-disabled' });
    const body = (req.body ?? {}) as { db?: string; retention?: string };
    if (!validName(body.db)) return reply.code(400).send({ error: 'invalid', code: 'bad-db' });
    if (body.retention !== undefined && !RETENTION_RE.test(body.retention)) {
      return reply.code(400).send({ error: 'invalid', code: 'bad-retention' });
    }
    const dbs = await ctx.influx.listDatabases();
    if (!dbs.some((d) => d.name === body.db)) return reply.code(404).send({ error: 'not-found', code: 'db-not-found' });
    await ctx.influx.dropDatabase(body.db);
    await ctx.influx.createDatabase(body.db, body.retention);
    auditAction(ctx, req, 'database/recreate', { db: body.db, retention: body.retention ?? null });
    return { ok: true, db: body.db, retention: body.retention ?? null };
  });

  app.post('/api/influxdb/actions/database/drop', async (req, reply) => {
    if (!influxReady(ctx)) return reply.code(404).send({ error: 'not-found', code: 'influx-disabled' });
    const body = (req.body ?? {}) as { db?: string };
    if (!validName(body.db)) return reply.code(400).send({ error: 'invalid', code: 'bad-db' });
    const dbs = await ctx.influx.listDatabases();
    if (!dbs.some((d) => d.name === body.db)) return reply.code(404).send({ error: 'not-found', code: 'db-not-found' });
    await ctx.influx.dropDatabase(body.db);
    auditAction(ctx, req, 'database/drop', { db: body.db });
    return { ok: true, db: body.db };
  });

  app.post('/api/influxdb/actions/table/drop', async (req, reply) => {
    if (!influxReady(ctx)) return reply.code(404).send({ error: 'not-found', code: 'influx-disabled' });
    const body = (req.body ?? {}) as { db?: string; table?: string };
    if (!validName(body.db) || !validName(body.table)) return reply.code(400).send({ error: 'invalid', code: 'bad-name' });
    await ctx.influx.dropTable(body.db, body.table);
    auditAction(ctx, req, 'table/drop', { db: body.db, table: body.table });
    return { ok: true, db: body.db, table: body.table };
  });
}
