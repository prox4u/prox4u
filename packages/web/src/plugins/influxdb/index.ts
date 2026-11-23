import { Database } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { InfluxDbPage } from './pages/influxdb';

/**
 * Plugin InfluxDB 3 Core — vision + action sur la base de métriques.
 * Lecture (ouverte à tous) : GET /api/influxdb + /api/influxdb/history.
 * Actions (groupes INFLUX_ACTION_GROUPS, défaut Administrateurs/Exploitations) :
 * POST /api/influxdb/actions/* (flush, archivage, recréation/suppression bases/tables).
 *
 * Famille `influxdb` — un futur module de base de données (Prometheus, etc.)
 * partagera le pattern sans toucher à cette famille.
 */
export const influxdbPlugin: Plugin = {
  manifest: {
    id: 'influxdb',
    name: 'InfluxDB',
    version: '1.0.0',
    routes: [{ path: '/influxdb', element: InfluxDbPage }],
    menu: [
      { id: 'influxdb', to: '/influxdb', labelKey: 'nav.influxdb', icon: Database, order: 80 },
    ],
  },
  init(ctx) {
    ctx.logger.info('influxdb prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
