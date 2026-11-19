import { LayoutDashboard } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { EndpointFleetDot, ProxmoxNavTree } from './components/proxmox-nav-tree';
import { EndpointPage } from './pages/endpoint';
import { NodePage } from './pages/node';
import { OverviewPage } from './pages/overview';

/**
 * Plugin Hypervision v4 — vue d'ensemble du parc, détail endpoint, détail nœud.
 * v2 : vue d'ensemble PERSONNALISABLE par utilisateur (grille react-grid-layout
 * : drag/resize des cartes, retrait → bibliothèque, réinsertion,
 * réinitialisation) — persistance par compte (GET/PUT/DELETE /api/user-config).
 * v3 : bibliothèque de la Vue d'ensemble complétée (widget temp-nodes).
 *
 * Nouveauté v4 — BIBLIOTHÈQUE SUR TOUTES LES PAGES :
 *  - Page CLUSTER (/e/:endpointId) : les 17 blocs du dashboard deviennent des
 *    widgets déplaçables/retraitables (scope user-config « endpointView » —
 *    un layout par cluster).
 *  - Page NŒUD (/e/:endpointId/n/:nodeId) : grille unifiée — les 4 KPIs + la
 *    table VMs + TOUS les graphiques du Monitor nœud (système, CPU par cœur,
 *    I/O par disque, réseau par interface, températures, SMART, ZFS ARC,
 *    charge, swap — réemployés depuis vm-view_v4) sont déplaçables/retraitables
 *    (scope user-config « nodePage » — un layout par nœud).
 *  - Vue d'ensemble : inchangée (v3).
 *
 * Couplage : la page nœud réemploie les composants du Monitor nœud de
 * vm-view_v4 (import STATIQUE — bundlé au build, fonctionne quel que soit l'état
 * du plugin vm-view). Pas de `dependencies` dans le manifest : le loader évalue
 * les dépendances à l'initialisation (ordre sensible — hypervision se charge
 * avant vm-view), et l'import statique suffit au runtime.
 *
 * Convention de versionnement : toute modification d'un module crée une nouvelle
 * version `<id>_vN` — la v3 reste intacte en rollback (?v=hypervision_v3).
 */
export const hypervisionPluginV4: Plugin = {
  manifest: {
    id: 'hypervision_v4',
    name: 'Hypervision',
    version: '0.4.0',
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
    ctx.logger.info('hypervision_v4 prêt — 3 routes + 1 entrée de menu exposées au host (bibliothèque sur Vue d’ensemble + cluster + nœud)');
  },
};
