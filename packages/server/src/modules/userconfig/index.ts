import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { UserConfigStore } from './store.js';
import { registerUserConfigRoutes } from './routes.js';

/**
 * Module personnalisation d'interface par utilisateur :
 *  - UserConfigStore : un fichier par user, data/user-configs/<userId>.json
 *    (écriture atomique, chmod 600, tolérant à la corruption).
 *  - GET/PUT/DELETE /api/user-config (session obligatoire via le guard global,
 *    pas de rôle admin — chacun gère sa propre config).
 */
export function registerUserConfig(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  const dataDir = path.dirname(ctx.config.authFile);
  const store = new UserConfigStore(path.join(dataDir, 'user-configs'), ctx.logger);
  store.init();
  registerUserConfigRoutes(app, store);
}
