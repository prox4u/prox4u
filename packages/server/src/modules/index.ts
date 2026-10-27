import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../core/poller.js';
import { registerAuth } from './auth/index.js';
import { registerDashboard } from './dashboard/routes.js';
import { registerSupervision } from './supervision/routes.js';
import { registerVmInventory } from './vminventory/routes.js';

/**
 * Manifeste des modules : chaque module enregistre ses routes REST.
 * - auth : guard global + /api/auth/* + /api/admin/* (TOUJOURS enregistré en
 *   premier — le hook onRequest ne s'applique qu'aux routes enregistrées après)
 * - dashboard : phase 1 (KPIs, PRA, capacity planning…)
 * - supervision : phase 1B (topologie réseau), storage, backups, alarms
 * - vminventory : GET /api/vm-config (détail VM)
 * `register` peut être asynchrone (initialisation de dépendances).
 */
export interface Module {
  name: string;
  register(app: FastifyInstance, ctx: AppContext, poller: Poller): void | Promise<void>;
}

export const modules: Module[] = [
  { name: 'auth', register: registerAuth },
  { name: 'dashboard', register: registerDashboard },
  { name: 'supervision', register: registerSupervision },
  { name: 'vminventory', register: registerVmInventory },
];
