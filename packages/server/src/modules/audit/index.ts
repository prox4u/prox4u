import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { registerAuditRoutes } from './routes.js';

/**
 * Module « Audit / best-practices » (P3) — 2ᵉ score de CONFIGURATION.
 *  - GET /api/audit            : audit de tous les endpoints
 *  - GET /api/audit?endpoint=  : audit d'un endpoint
 *
 * Les checks sont purs (shared/audit.ts) et calculés par le poller : l'audit
 * vit dans le snapshot WS (`snapshot.audit`). La route ne fait que servir le
 * snapshot — aucune logique de calcul dupliquée (ctx non utilisé ici).
 */
export function registerAuditModule(app: FastifyInstance, _ctx: AppContext, poller: Poller): void {
  registerAuditRoutes(app, poller);
}
