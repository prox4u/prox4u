import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { registerInfluxDbRoutes } from './routes.js';

/**
 * Module « InfluxDB » (P4) — auto-monitoring d'InfluxDB 3 Core.
 *  - GET /api/influxdb : état + compteurs d'écriture + stats lecture + headroom fichiers
 *
 * Les alertes InfluxDB (influxdb-down / write-drops / file-headroom) sont
 * calculées par le poller et poussées dans le snapshot WS (cf. poller.ts).
 */
export function registerInfluxDbModule(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  registerInfluxDbRoutes(app, ctx);
}
