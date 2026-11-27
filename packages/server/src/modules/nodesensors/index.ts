import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { registerNodeSensors, registerSensorHistoryRoute, registerSensorThresholdRoutes, registerSmartHistoryRoute } from './routes.js';
import { registerNodeSystemRoutes } from './system-routes.js';
import { SensorThresholdStore } from './thresholds.js';

/**
 * Enregistrement du module Capteurs nœuds (node-sensors) :
 *  - registerNodeSensors : GET /api/node-sensors (métriques Telegraf, cache 1 min),
 *    avec le merge des seuils capteurs personnalisés dans la réponse.
 *  - SensorThresholdStore : data/sensor-thresholds.json (perso ≤ firmware).
 *  - registerSensorHistoryRoute : GET /api/node-sensors-history (série de
 *    température d'un capteur, 31 j / 1 an, raw 10 min + consolidated 15 min).
 *  - registerSmartHistoryRoute : GET /api/smart-device-history (id. pour un
 *    disque SMART — table smart_device, pas de seuil, 0 °C = pas de lecture).
 *  - registerSensorThresholdRoutes : GET/PUT/DELETE /api/admin/sensor-thresholds
 *    (onglet Administration « Seuils capteurs » — guard rôle admin).
 *  - registerNodeSystemRoutes : GET /api/node-system (load/swap/usage par cœur,
 *    dernier point par nœud) + GET /api/node-diskio (I/O par device physique)
 *    + GET /api/node-net (trafic PAR INTERFACE — liste des interfaces depuis
 *    l'API PVE, joint noyau via `altnames`, 1 carte graphique par interface) —
 *    Vue d'ensemble. Même source Telegraf raw, mêmes pièges (counters, trous).
 */
export function registerNodeSensorsModule(app: FastifyInstance, ctx: AppContext, poller: Poller): void {
  const dataDir = path.dirname(ctx.config.authFile);
  // Store partagé (créé dans index.ts, posé sur ctx) : l'onglet admin « Seuils
  // capteurs » ET le moteur d'alarmes (GitHub #4 — seuil effectif perso ≤
  // firmware des règles capteurs) lisent la MÊME instance (pas de cache
  // divergent). Repli : instance locale (mocks de tests sans ctx complet).
  const store = ctx.sensorThresholds ?? new SensorThresholdStore(path.join(dataDir, 'sensor-thresholds.json'), ctx.logger);
  if (!ctx.sensorThresholds) store.init();
  registerNodeSensors(app, ctx, store);
  registerSensorHistoryRoute(app, ctx, store);
  registerSmartHistoryRoute(app, ctx);
  registerSensorThresholdRoutes(app, ctx, store);
  registerNodeSystemRoutes(app, ctx, poller);
}
