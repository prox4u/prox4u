import { LayoutDashboard } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { EndpointFleetDot, ProxmoxNavTree } from './components/proxmox-nav-tree';
import { EndpointPage } from './pages/endpoint';
import { NodePage } from './pages/node';
import { OverviewPage } from './pages/overview';

/**
 * Plugin Hypervision v3 — vue d'ensemble du parc, détail endpoint, détail nœud.
 * v2 : vue d'ensemble PERSONNALISABLE par utilisateur (grille react-grid-layout
 * : drag/resize des cartes, retrait → bibliothèque, réinsertion,
 * réinitialisation) — persistance par compte (GET/PUT/DELETE /api/user-config).
 *
 * Nouveauté v3 — BIBLIOTHÈQUE COMPLETÉE (référence ProxMenux) : 1 nouveau
 * widget dans la Vue d'ensemble :
 *  - temp-nodes : températures par nœud (carte cross-node, état courant,
 *    coloration selon le seuil effectif — même pattern que la carte Système,
 *    source /api/node-sensors).
 * Le scope user-config (pages.overview) est inchangé : les layouts v2 sont
 * réutilisés, le nouveau widget s'ajoute en bas de grille.
 *
 * Convention de versionnement : toute modification d'un module crée une nouvelle
 * version `<id>_vN` — la v2 reste intacte en rollback. L'admin active la version à
 * exposer (onglet Administration → Versions).
 */
export const hypervisionPluginV3: Plugin = {
  manifest: {
    id: 'hypervision_v3',
    name: 'Hypervision',
    version: '0.3.0',
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
    ctx.logger.info('hypervision_v3 prêt — 3 routes + 1 entrée de menu exposées au host (vue d’ensemble personnalisable par user, bibliothèque complétée)');
  },
};
