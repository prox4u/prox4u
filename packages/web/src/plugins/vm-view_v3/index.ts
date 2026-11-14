import { MonitorSmartphone } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { VmViewPage } from './pages/vm-view';

/**
 * Plugin Vue VM v3 — même périmètre que la v2 (parc VMs/LXC multi-endpoints,
 * arborescence type vCenter, tableau filtrable, détail par onglets, console web
 * PVE) + MONITORS PERSONNALISABLES PAR UTILISATEUR : les onglets « Monitor » de la
 * VM et du nœud deviennent des grilles react-grid-layout (drag/resize des cartes,
 * retrait → bibliothèque, réinsertion, réinitialisation) — persistance par compte
 * et par VM / par nœud (GET/PUT/DELETE /api/user-config).
 *
 * Convention de versionnement : toute modification d'un module crée une nouvelle
 * version `<id>_vN` — la v2 reste intacte en rollback. L'admin active la version à
 * exposer (onglet Administration → Versions).
 */
export const vmViewPluginV3: Plugin = {
  manifest: {
    id: 'vm-view_v3',
    name: 'VM View',
    version: '0.3.0',
    routes: [
      { path: '/vms', element: VmViewPage },
    ],
    menu: [
      { id: 'vm-view', to: '/vms', labelKey: 'nav.vmView', icon: MonitorSmartphone, order: 40 },
    ],
  },
  init(ctx) {
    ctx.logger.info('vm-view_v3 prêt — 1 route + 1 entrée de menu exposées au host (monitors personnalisables par user)');
  },
};
