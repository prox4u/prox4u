import { MonitorSmartphone } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { VmViewPage } from './pages/vm-view';

/**
 * Plugin Vue VM v4 — même périmètre que la v3 (parc VMs/LXC multi-endpoints,
 * arborescence type vCenter, tableau filtrable, détail par onglets, console web
 * PVE, MONITORS PERSONNALISABLES PAR UTILISATEUR : grilles react-grid-layout
 * drag/resize, retrait → bibliothèque, persistance par compte et par VM / par
 * nœud — GET/PUT/DELETE /api/user-config).
 *
 * Nouveauté v4 — BIBLIOTHÈQUE COMPLETÉE (référence ProxMenux) : 6 nouveaux
 * widgets dans le Monitor NŒUD, alimentés par les tables Telegraf `raw`
 * (nouveaux endpoints /api/node-temps, /api/smart-temps, /api/zfs-arc,
 * /api/node-system-history) :
 *  - temp-cpu : températures CPU/chips (série, une courbe par chip) ;
 *  - smart-temps : températures disques SMART (série, un disque à la fois) ;
 *  - zfs-arc : taille ARC + max + hit rate (masqué si compteurs à 0) ;
 *  - load : charge moyenne 1/5/15 ;
 *  - swap : swap utilisé ;
 *  - smart-health : santé disques (état courant — /api/node-sensors).
 * Les scopes user-config (pages.vmView / pages.nodeView) sont inchangés : les
 * layouts v3 sont réutilisés, les nouveaux widgets s'ajoutent en bas de grille.
 *
 * Convention de versionnement : toute modification d'un module crée une nouvelle
 * version `<id>_vN` — la v3 reste intacte en rollback. L'admin active la version à
 * exposer (onglet Administration → Versions).
 */
export const vmViewPluginV4: Plugin = {
  manifest: {
    id: 'vm-view_v4',
    name: 'VM View',
    version: '0.4.0',
    routes: [
      { path: '/vms', element: VmViewPage },
    ],
    menu: [
      { id: 'vm-view', to: '/vms', labelKey: 'nav.vmView', icon: MonitorSmartphone, order: 40 },
    ],
  },
  init(ctx) {
    ctx.logger.info('vm-view_v4 prêt — 1 route + 1 entrée de menu exposées au host (monitors personnalisables par user, bibliothèque complétée)');
  },
};
