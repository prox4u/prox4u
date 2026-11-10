import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { registerNodeSensors, registerSensorThresholdRoutes } from './routes.js';
import { SensorThresholdStore } from './thresholds.js';

/**
 * Enregistrement du module Capteurs nœuds (node-sensors) :
 *  - registerNodeSensors : GET /api/node-sensors (métriques Telegraf, cache 1 min),
 *    avec le merge des seuils capteurs personnalisés dans la réponse.
 *  - SensorThresholdStore : data/sensor-thresholds.json (perso ≤ firmware).
 *  - registerSensorThresholdRoutes : GET/PUT/DELETE /api/admin/sensor-thresholds
 *    (onglet Administration « Seuils capteurs » — guard rôle admin).
 */
export function registerNodeSensorsModule(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  const dataDir = path.dirname(ctx.config.authFile);
  const store = new SensorThresholdStore(path.join(dataDir, 'sensor-thresholds.json'), ctx.logger);
  store.init();
  registerNodeSensors(app, ctx, store);
  registerSensorThresholdRoutes(app, ctx, store);
}
