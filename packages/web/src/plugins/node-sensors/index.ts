import { Thermometer } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { NodeSensorsPage } from './pages/node-sensors';

/**
 * Plugin Node Sensors — métriques locales Telegraf (SMART, températures, ZFS, unités systemd).
 * Données servies par GET /api/node-sensors (cache serveur 1 min, base raw).
 *
 * Famille `node-sensors` — un futur module Zabbix/Prometheus partagera le namespace
 * /api/node-sensors/* sans toucher à cette famille.
 */
export const nodeSensorsPlugin: Plugin = {
  manifest: {
    id: 'node-sensors',
    name: 'Node Sensors',
    version: '1.0.0',
    routes: [
      { path: '/node-sensors', element: NodeSensorsPage },
    ],
    menu: [
      { id: 'node-sensors', to: '/node-sensors', labelKey: 'nav.nodeSensors', icon: Thermometer, order: 70 },
    ],
  },
  init(ctx) {
    ctx.logger.info('node-sensors prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
