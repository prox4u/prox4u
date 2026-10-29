import { MonitorSmartphone } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { VmViewPage } from './pages/vm-view';

/**
 * Plugin Vue VM v2 — même périmètre que la v1 (parc VMs/LXC multi-endpoints,
 * arborescence type vCenter, tableau filtrable, détail par onglets) + bouton
 * « Console web » qui ouvre la console de la VM dans l'UI PVE (nouvel onglet).
 *
 * Convention de versionnement : toute modification d'un module crée une nouvelle
 * version `<id>_vN` — la v1 reste intacte en rollback. L'admin active la version
 * à exposer (onglet Administration → Versions).
 */
export const vmViewPluginV2: Plugin = {
  manifest: {
    id: 'vm-view_v2',
    name: 'VM View',
    version: '0.2.0',
    routes: [
      { path: '/vms', element: VmViewPage },
    ],
    menu: [
      { id: 'vm-view', to: '/vms', labelKey: 'nav.vmView', icon: MonitorSmartphone, order: 40 },
    ],
  },
  init(ctx) {
    ctx.logger.info('vm-view_v2 prêt — 1 route + 1 entrée de menu exposées au host (console web PVE)');
  },
};
