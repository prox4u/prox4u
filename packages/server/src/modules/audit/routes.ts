import type { FastifyInstance } from 'fastify';
import type { AuditAllResponse, AuditScore } from '@prox4u/shared';
import type { Poller } from '../../core/poller.js';

/**
 * GET /api/audit — audit de configuration (best-practices) par endpoint.
 *
 * L'audit est calculé par le POLLER à chaque tick (checks purs shared/audit.ts,
 * ponts via getNetwork mis en cache 5 min) et vit dans le snapshot WS
 * (`snapshot.audit`). Cette route ne fait que servir le snapshot — aucune
 * logique de calcul dupliquée, aucune nouvelle API PVE à la volée.
 *
 *  - GET /api/audit            → { endpoints: [...] } (tous les endpoints)
 *  - GET /api/audit?endpoint=  → AuditScore (un endpoint)
 */
export function registerAuditRoutes(app: FastifyInstance, poller: Poller): void {
  app.get('/api/audit', async (req, reply) => {
    const multi = poller.getMulti();
    const q = req.query as { endpoint?: string };

    // Un endpoint précis.
    if (q.endpoint) {
      const ep = multi?.endpoints.find((e) => e.id === q.endpoint);
      const value = ep?.snapshot?.audit ?? null;
      if (!value) return reply.code(404).send({ error: 'endpoint not found' });
      return value;
    }

    // Tous les endpoints.
    const endpoints: AuditAllResponse['endpoints'] = [];
    for (const ep of multi?.endpoints ?? []) {
      const value: AuditScore | null = ep.snapshot?.audit ?? null;
      if (!value) continue;
      endpoints.push({ endpointId: ep.id, endpointName: ep.name, ...value });
    }
    return { endpoints };
  });
}
