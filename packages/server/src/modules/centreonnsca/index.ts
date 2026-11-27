import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { AlarmEngine } from './engine.js';
import { registerAlarmRoutes } from './routes.js';
import { NscaStore } from './store.js';

/**
 * Enregistrement du module Alarmes & Checks NSCA (centreon-nsca) :
 *  - NscaStore : data/centreon-nsca.json (seed au 1er démarrage) ;
 *  - AlarmEngine : tick 15 s, évalue les règles actives et envoie les trames
 *    NSCA aux transitions (démarré après l'initialisation du store) ;
 *  - routes /api/alarms/* (règles, cibles, config, test, provisioning).
 *
 * Le module est inerte si `config.enabled=false` (l'engine ne fait rien) —
 * l'activation se fait sur la Page 3 d'administration.
 */
export function registerAlarmNsca(app: FastifyInstance, ctx: AppContext, poller: Poller): void {
  const dataDir = path.dirname(ctx.config.authFile);
  // Secrets du .env (CENTREON_*) : prévalent sur data/centreon-nsca.json (UI).
  const store = new NscaStore(path.join(dataDir, 'centreon-nsca.json'), ctx.logger, ctx.config.centreon);
  store.init();
  const engine = new AlarmEngine(store, poller, dataDir, ctx.logger);
  engine.start();
  registerAlarmRoutes(app, store, dataDir, poller, ctx.auth);
  app.addHook('onClose', async () => {
    engine.stop();
  });
}
