import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prox4u/shared';
import { parseCookies, SESSION_COOKIE } from './session.js';
import type { AuthContext } from './runtime.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Utilisateur authentifié (posé par le guard sur toutes les routes protégées). */
    authUser?: { id: string; role: Role };
  }
}

/**
 * Garde d'API : hook onRequest global.
 * - /api/auth/login et /api/health sont publics (le health sert de liveness
 *   probe à server.sh — il ne doit PAS exiger de session) ; tout le reste de
 *   /api/* exige une session valide.
 * - /api/admin/* exige en plus le rôle admin. De même PUT /api/alarms/config
 *   (la config Centreon porte les secrets CLAPI/NSCA et les destinations réseau
 *   restUrl/clapiHost — sa modification est réservée aux admins ; la lecture
 *   masquée et les règles restent accessibles aux utilisateurs du module).
 * - /sample (page de design) exige une session : plus de contenu public.
 * Les routes existantes des modules (dashboard, supervision…) ne sont pas modifiées :
 * la protection est transversale.
 */
export function registerAuthGuard(app: FastifyInstance, auth: AuthContext): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') && url !== '/sample') return; // SPA, statiques…
    if (url === '/api/auth/login' || url === '/api/health') return; // publics (login + liveness probe)

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = auth.sessions.get(token);
    if (!session) {
      return reply.code(401).send({ error: 'unauthorized', code: 'no-session' });
    }
    const user = auth.store.userById(session.userId);
    if (!user || !user.active) {
      // compte supprimé/désactivé pendant la session → invalidation immédiate
      if (token) auth.sessions.destroy(token);
      return reply.code(401).send({ error: 'unauthorized', code: 'no-session' });
    }
    req.authUser = { id: user.id, role: user.role };

    const needsAdmin =
      url.startsWith('/api/admin/') || (url === '/api/alarms/config' && req.method === 'PUT');
    if (needsAdmin && user.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', code: 'admin-required' });
    }
  });
}
