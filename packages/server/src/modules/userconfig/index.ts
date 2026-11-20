import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { registerUserConfigRoutes } from './routes.js';

/**
 * Module personnalisation d'interface par utilisateur :
 *  - UserConfigStore : un fichier par user, data/user-configs/<userId>.json
 *    (écriture atomique, chmod 600, tolérant à la corruption). Le store est
 *    créé dans index.ts et partagé via ctx.userConfig (aussi utilisé par
 *    l'import/export admin).
 *  - GET/PUT/DELETE /api/user-config (session obligatoire via le guard global,
 *    pas de rôle admin — chacun gère sa propre config).
 */
export function registerUserConfig(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  registerUserConfigRoutes(app, ctx.userConfig);
}
