import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prox4u/shared';
import { parseCookies, SESSION_COOKIE } from './session.js';
import type { AuthContext } from './runtime.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Utilisateur authentifié (posé par le guard sur toutes les routes protégées). */
    authUser?: { id: string; role: Role; groupIds: string[] };
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
 * - /api/influxdb/actions/* (les ACTIONS InfluxDB — flush, archivage, recréation/
 *   suppression de bases et tables) exigent le rôle admin OU l'appartenance à un
 *   des groupes configurés (INFLUX_ACTION_GROUPS, défaut « Administrateurs,
 *   Exploitations »). La LECTURE (GET /api/influxdb, /history) reste ouverte à
 *   toute session : seul le module est visible par tous, les actions restreintes.
 * - /sample (page de design) exige une session : plus de contenu public.
 * Les routes existantes des modules (dashboard, supervision…) ne sont pas modifiées :
 * la protection est transversale.
 */
export function registerAuthGuard(app: FastifyInstance, auth: AuthContext, influxActionGroups: string[]): void {
  const allowedGroups = new Set(influxActionGroups);
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
    const groupIds = auth.store.groupIdsForUser(user.id);
    req.authUser = { id: user.id, role: user.role, groupIds };

    const needsAdmin =
      url.startsWith('/api/admin/') || (url === '/api/alarms/config' && req.method === 'PUT');
    if (needsAdmin && user.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', code: 'admin-required' });
    }

    // Actions InfluxDB : rôle admin OU membre d'un des groupes configurés.
    if (url.startsWith('/api/influxdb/actions/')) {
      const inAllowedGroup = groupIds.some((gid) => allowedGroups.has(auth.store.groupById(gid)?.name ?? ''));
      if (user.role !== 'admin' && !inAllowedGroup) {
        return reply.code(403).send({ error: 'forbidden', code: 'influx-actions-group' });
      }
    }
  });
}
