import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../../core/poller.js';
import { fetchSensorAlarmData } from '../nodesensors/data.js';
import { AlarmEngine } from './engine.js';
import { registerAlarmRoutes } from './routes.js';
import { SensorDataCache } from './sensor-data.js';
import { NscaStore } from './store.js';

/**
 * Enregistrement du module Alarmes & Checks NSCA (centreon-nsca) :
 *  - NscaStore : data/centreon-nsca.json (seed au 1er démarrage) ;
 *  - AlarmEngine : tick 15 s, évalue les règles actives et envoie les trames
 *    NSCA aux transitions (démarré après l'initialisation du store) ;
 *  - routes /api/alarms/* (règles, cibles, config, test, provisioning).
 *
 * MÉTRIQUES CAPTEURS (GitHub #4) : les règles capteurs (SMART / température /
 * unité systemd / pool ZFS) lisent InfluxDB raw via `fetchSensorAlarmData`
 * (module node-sensors) — cache 60 s partagé (SensorDataCache), et le seuil
 * effectif perso ≤ firmware via le SensorThresholdStore partagé (ctx).
 *
 * Le module est inerte si `config.enabled=false` (l'engine ne fait rien) —
 * l'activation se fait sur la Page 3 d'administration.
 */
export function registerAlarmNsca(app: FastifyInstance, ctx: AppContext, poller: Poller): void {
  const dataDir = path.dirname(ctx.config.authFile);
  // Secrets du .env (CENTREON_*) : prévalent sur data/centreon-nsca.json (UI).
  const store = new NscaStore(path.join(dataDir, 'centreon-nsca.json'), ctx.logger, ctx.config.centreon);
  store.init();
  // Données capteurs (GitHub #4) : UNE lecture InfluxDB par minute, partagée
  // entre l'engine (tick 15 s) et les routes (cibles du formulaire).
  const sensorCache = new SensorDataCache(() => fetchSensorAlarmData(ctx));
  const engine = new AlarmEngine(
    store,
    poller,
    dataDir,
    ctx.logger,
    15_000,
    () => sensorCache.get(),
    () => ctx.sensorThresholds?.getThresholds() ?? {},
  );
  engine.start();
  registerAlarmRoutes(app, store, dataDir, poller, ctx.auth, () => sensorCache.get());
  app.addHook('onClose', async () => {
    engine.stop();
  });
}
