import { LayoutDashboard } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { EndpointFleetDot, ProxmoxNavTree } from './components/proxmox-nav-tree';
import { EndpointPage } from './pages/endpoint';
import { NodePage } from './pages/node';
import { OverviewPage } from './pages/overview';

/**
 * Plugin Hypervision v2 — vue d'ensemble du parc, détail endpoint, détail nœud.
 * Nouveauté v2 : vue d'ensemble PERSONNALISABLE par utilisateur (grille
 * react-grid-layout : drag/resize des cartes, retrait → bibliothèque,
 * réinsertion, réinitialisation) — persistance par compte (GET/PUT/DELETE
 * /api/user-config). La v1 (hypervision) reste disponible en rollback.
 *
 * Convention de versionnement : toute modification d'un module crée une nouvelle
 * version `<id>_vN` — la v1 reste intacte. L'admin active la version à exposer
 * (onglet Administration → Versions).
 */
export const hypervisionPluginV2: Plugin = {
  manifest: {
    id: 'hypervision_v2',
    name: 'Hypervision',
    version: '0.2.0',
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
    ctx.logger.info('hypervision_v2 prêt — 3 routes + 1 entrée de menu exposées au host (vue d’ensemble personnalisable par user)');
  },
};
