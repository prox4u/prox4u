import type { FastifyInstance } from 'fastify';
import type { InfluxShardConfig } from '../../core/influx-shards.js';
import type { AppContext } from '../../core/poller.js';

/**
 * Administration des shards InfluxDB par endpoint (GitHub #18, Phase 0).
 *
 * Toutes les routes sont sous /api/admin/* → guard rôle admin (voir skill general §auth).
 * La config est persistée dans data/influx-shards.json (InfluxShardStore) et le
 * routeur est rechargé à chaud (InfluxShardRouter.reload) — sans redémarrage.
 *
 *  - GET    /api/admin/influx-shards            → shards + endpoints valides
 *  - POST   /api/admin/influx-shards            → upsert un shard (par endpointId)
 *  - DELETE /api/admin/influx-shards            → tout retirer (retour instance unique)
 *  - DELETE /api/admin/influx-shards/:endpointId → retirer un shard
 *  - POST   /api/admin/influx-shards/:endpointId/test → ping de l'instance
 *
 * Sharding dormant : liste vide → tout reste sur l'instance globale (zéro changement).
 */

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
function validName(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && NAME_RE.test(s);
}

function validUrl(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > 2048) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** EndpointId connu (clusters.json / mock) — évite les coquilles qui orphelinerait un shard. */
function knownEndpointIds(ctx: AppContext): Set<string> {
  return new Set(ctx.endpoints.map((e) => e.id));
}

/** Valide un shard (body) → { shard } ou { error, code, message }. */
function validateShard(ctx: AppContext, body: unknown): { shard?: InfluxShardConfig; error?: string; code?: string; message?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid', code: 'bad-shard', message: 'le corps doit être un objet shard' };
  }
  const o = body as Record<string, unknown>;
  const { endpointId, url, token, caCert } = o;
  if (typeof endpointId !== 'string' || endpointId.length === 0 || endpointId.length > 64) {
    return { error: 'invalid', code: 'bad-endpoint', message: '`endpointId` requis (slug de l’endpoint)' };
  }
  if (!knownEndpointIds(ctx).has(endpointId)) {
    return { error: 'unknown', code: 'unknown-endpoint', message: `endpoint inconnu : ${endpointId}` };
  }
  if (!validUrl(url)) {
    return { error: 'invalid', code: 'bad-url', message: '`url` doit être une URL http(s) valide' };
  }
  const shard: InfluxShardConfig = { endpointId, url: url.replace(/\/$/, '') };
  if (token !== undefined) {
    if (typeof token !== 'string') return { error: 'invalid', code: 'bad-token', message: '`token` doit être une chaîne' };
    shard.token = token;
  }
  for (const key of ['rawDb', 'aggDb', 'rrdDb'] as const) {
    const v = o[key];
    if (v !== undefined) {
      if (!validName(v)) return { error: 'invalid', code: `bad-${key}`, message: `\`${key}\` invalide (alphanumérique + _/-)` };
      shard[key] = v;
    }
  }
  if (caCert !== undefined) {
    if (typeof caCert !== 'string') return { error: 'invalid', code: 'bad-caCert', message: '`caCert` doit être une chaîne (chemin)' };
    if (caCert.length > 0) shard.caCert = caCert;
  }
  return { shard };
}

/** Réponse de liste : shards courants + endpoints valides (pour le formulaire). */
function listResponse(ctx: AppContext) {
  return {
    shards: ctx.influxShardStore?.getShards() ?? [],
    endpoints: ctx.endpoints.map((e) => ({ id: e.id, name: e.name })),
  };
}

export function registerInfluxShardAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Après chaque mutation : persistance (store) + rechargement à chaud (router).
  const apply = (shards: InfluxShardConfig[]): void => {
    ctx.influxShards?.reload(shards);
  };

  app.get('/api/admin/influx-shards', async (_req, reply) => {
    reply.send(listResponse(ctx));
  });

  app.post('/api/admin/influx-shards', async (req, reply) => {
    const store = ctx.influxShardStore;
    if (!store) return reply.code(503).send({ error: 'unavailable', code: 'no-store', message: 'store shards non monté' });
    const v = validateShard(ctx, req.body);
    if (!v.shard) return reply.code(v.code === 'unknown-endpoint' ? 404 : 400).send({ error: v.error, code: v.code, message: v.message });
    const shards = store.upsertShard(v.shard);
    apply(shards);
    reply.send(listResponse(ctx));
  });

  app.delete('/api/admin/influx-shards', async (_req, reply) => {
    const store = ctx.influxShardStore;
    if (!store) return reply.code(503).send({ error: 'unavailable', code: 'no-store', message: 'store shards non monté' });
    const shards = store.setShards([]);
    apply(shards);
    reply.send(listResponse(ctx));
  });

  app.delete('/api/admin/influx-shards/:endpointId', async (req, reply) => {
    const store = ctx.influxShardStore;
    if (!store) return reply.code(503).send({ error: 'unavailable', code: 'no-store', message: 'store shards non monté' });
    const { endpointId } = req.params as { endpointId: string };
    const shards = store.deleteShard(endpointId);
    apply(shards);
    reply.send(listResponse(ctx));
  });

  app.post('/api/admin/influx-shards/:endpointId/test', async (req, reply) => {
    const { endpointId } = req.params as { endpointId: string };
    // Le shard doit être SAVED (store + router) : `forEndpoint` retombe sinon sur le
    // global, ce qui donnerait un ping trompeur. On vérifie d'abord le store.
    const saved = (ctx.influxShardStore?.getShards() ?? []).find((s) => s.endpointId === endpointId);
    if (!saved) {
      return reply.code(404).send({ error: 'not-found', code: 'no-shard', message: `aucun shard configuré pour ${endpointId}` });
    }
    const client = ctx.influxShards?.forEndpoint(endpointId);
    if (!client) {
      return reply.code(503).send({ error: 'unavailable', code: 'no-router', message: 'routeur shards non monté' });
    }
    const ping = await client.ping();
    reply.send({ endpointId, url: client.url, ping });
  });
}
