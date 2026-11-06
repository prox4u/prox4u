import { LayoutDashboard } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { EndpointFleetDot, ProxmoxNavTree } from './components/proxmox-nav-tree';
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
      // « Vue d'ensemble » porte le sous-menu Proxmox (endpoints/nœuds, replié par
      // défaut) + la pastille de santé agrégée — remplace l'ancienne section
      // « PROXMOX » du sidebar.
      {
        id: 'hypervision-overview',
        to: '/',
        labelKey: 'nav.overview',
        icon: LayoutDashboard,
        order: 10,
        submenu: <ProxmoxNavTree />,
        statusDot: EndpointFleetDot,
      },
    ],
  },
  init(ctx) {
    // Rien à initialiser pour l'instant : les données transitent par le store
    // WS du host (core/data) et le client API partagé (ctx.api).
    ctx.logger.info('hypervision prêt — 3 routes + 1 entrée de menu exposées au host');
  },
};
