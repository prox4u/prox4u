import type { FastifyInstance } from 'fastify';
import { parseUserConfig } from '@prox4u/shared';
import type { UserConfigStore } from './store.js';

/**
 * Personnalisation d'interface par utilisateur :
 *
 * GET    /api/user-config  → { userId, config: UserConfig | null, lastUpdated }
 * PUT    /api/user-config  → config complète (validation stricte shared/parseUserConfig)
 * DELETE /api/user-config  → réinitialisation (retour aux défauts de la page)
 *
 * Authentification : le GUARD GLOBAL pose req.authUser sur tout /api/* (session
 * obligatoire) — aucune route n'exige le rôle admin : chacun gère SA config.
 * `userId` = req.authUser.id (jamais pris de l'URL).
 *
 * Conventions Fastify 5 : `reply.code(400).send(…)` (le retour d'un objet avec
 * `statusCode` ne set PAS le code HTTP — piège documenté).
 */
export function registerUserConfigRoutes(app: FastifyInstance, store: UserConfigStore): void {
  app.get('/api/user-config', async (req, reply) => {
    const user = req.authUser;
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'no-session' });
    const config = store.load(user.id);
    reply.send({ userId: user.id, config, lastUpdated: config?.lastUpdated ?? null });
  });

  app.put('/api/user-config', async (req, reply) => {
    const user = req.authUser;
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'no-session' });
    const parsed = parseUserConfig(req.body);
    if (!parsed) {
      reply.code(400).send({ error: 'invalid', code: 'bad-config', message: 'config invalide (forme, ids ou bornes)' });
      return;
    }
    const saved = store.save(user.id, parsed);
    reply.send({ userId: user.id, config: saved, lastUpdated: saved.lastUpdated });
  });

  app.delete('/api/user-config', async (req, reply) => {
    const user = req.authUser;
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'no-session' });
    store.reset(user.id);
    reply.send({ userId: user.id, config: null, lastUpdated: null });
  });
}
