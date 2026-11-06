import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { registerNodeSensors } from './routes.js';

export function registerNodeSensorsModule(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  registerNodeSensors(app, ctx);
}
