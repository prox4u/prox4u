import type { FastifyInstance } from 'fastify';
import type { AppContext, Poller } from '../core/poller.js';
import { registerAuth } from './auth/index.js';
import { registerAlarmNsca } from './centreonnsca/index.js';
import { registerDashboard } from './dashboard/routes.js';
import { registerProxInventory } from './proxinventory/routes.js';
import { registerSupervision } from './supervision/routes.js';
import { registerVmInventory } from './vmview/routes.js';
import { registerNodeSensorsModule } from './nodesensors/index.js';
import { registerAuditModule } from './audit/index.js';
import { registerUserConfig } from './userconfig/index.js';
import { registerInfluxDbModule } from './influxdb/index.js';

/**
 * Manifeste des modules : chaque module enregistre ses routes REST.
 * - auth : guard global + /api/auth/* + /api/admin/* (TOUJOURS enregistré en
 *   premier — le hook onRequest ne s'applique qu'aux routes enregistrées après)
 * - dashboard : phase 1 (KPIs, PRA, capacity planning…)
 * - supervision : phase 1B (topologie réseau), storage, backups, alarms
 * - vmview : GET /api/vm-config (détail VM)
 * - proxinventory : GET /api/proxmox-inventory (inventaire consolidé multi-endpoints)
 * - centreonnsca : /api/alarms/* (règles, cibles, config) + engine d'alarmes
 *   (tick 15 s) + provisioning Centreon (CLAPI/REST) + envoi send_nsca
 * - audit : GET /api/audit (audit best-practices — 2ᵉ score de configuration,
 *   checks purs shared/audit.ts, cache 5 min)
 * - userconfig : GET/PUT/DELETE /api/user-config (personnalisation d'interface
 *   par utilisateur — data/user-configs/<userId>.json, session obligatoire)
 * - influxdb : GET /api/influxdb (auto-monitoring InfluxDB 3 Core — état,
 *   compteurs d'écriture, stats lecture, headroom fichiers — P4)
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
  { name: 'vmview', register: registerVmInventory },
  { name: 'proxinventory', register: registerProxInventory },
  { name: 'centreonnsca', register: registerAlarmNsca },
  { name: 'nodesensors', register: registerNodeSensorsModule },
  { name: 'audit', register: registerAuditModule },
  { name: 'userconfig', register: registerUserConfig },
  { name: 'influxdb', register: registerInfluxDbModule },
];
