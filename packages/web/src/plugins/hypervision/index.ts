import { LayoutDashboard } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { EndpointPage } from './pages/endpoint';
import { NodePage } from './pages/node';
import { OverviewPage } from './pages/overview';

/**
 * Plugin Hypervision — vue d'ensemble du parc, détail endpoint, détail nœud.
 * Migrated from legacy/hypervision (Strangler Fig, étape 2).
 */
export const hypervisionPlugin: Plugin = {
  manifest: {
    id: 'hypervision',
    name: 'Hypervision',
    version: '0.1.0',
    routes: [
      { path: '/', element: OverviewPage },
      { path: '/e/:endpointId', element: EndpointPage },
      { path: '/e/:endpointId/n/:nodeId', element: NodePage },
    ],
    menu: [
      { id: 'hypervision-overview', to: '/', labelKey: 'nav.overview', icon: LayoutDashboard, order: 10 },
    ],
  },
  init(ctx) {
    // Rien à initialiser pour l'instant : les données transitent par le store
    // WS du host (core/data) et le client API partagé (ctx.api).
    ctx.logger.info('hypervision prêt — 3 routes + 1 entrée de menu exposées au host');
  },
};
