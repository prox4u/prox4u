import { Network } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { TopologyPage } from './pages/topology';

/**
 * Plugin Network — topologie réseau, simulation de pannes, inventaire.
 * Migrated from legacy/network (Strangler Fig, étape 3).
 */
export const networkPlugin: Plugin = {
  manifest: {
    id: 'network',
    name: 'Network',
    version: '0.1.0',
    routes: [
      { path: '/topology', element: TopologyPage },
    ],
    menu: [
      { id: 'network-topology', to: '/topology', labelKey: 'nav.topology', icon: Network, order: 20 },
    ],
  },
  init(ctx) {
    // Rien à initialiser pour l'instant : les données transitent par le client
    // API partagé (ctx.api) et le store WS du host (core/data).
    ctx.logger.info('network prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
