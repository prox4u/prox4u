import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { registerAuthGuard } from './guard.js';
import { registerAuthRoutes } from './routes.js';

/**
 * Module d'authentification multi-utilisateurs (port de l'ancienne app).
 * Enregistre le guard global (toutes les routes /api/* + rôles) et les routes
 * /api/auth/* + /api/admin/*. Le contexte (store, sessions, provider) est
 * construit au démarrage dans index.ts (ctx.auth).
 * DOIT être enregistré en premier : le hook onRequest du guard ne s'applique
 * qu'aux routes enregistrées après lui.
 */
export async function registerAuth(app: FastifyInstance, ctx: AppContext, _poller: Poller): Promise<void> {
  await app.register(fastifyCookie); // reply.setCookie / clearCookie (cookie httpOnly de session)
  registerAuthGuard(app, ctx.auth);
  registerAuthRoutes(app, ctx, Boolean(ctx.config.tls));
}
