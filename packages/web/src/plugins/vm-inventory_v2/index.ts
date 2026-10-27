import { MonitorSmartphone } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { VmInventoryPage } from './pages/vm-inventory';

/**
 * Plugin Inventaire VM v2 — même périmètre que la v1 (parc VMs/LXC multi-endpoints,
 * arborescence type vCenter, tableau filtrable, détail par onglets) + bouton
 * « Console web » qui ouvre la console de la VM dans l'UI PVE (nouvel onglet).
 *
 * Convention de versionnement : toute modification d'un module crée une nouvelle
 * version `<id>_vN` — la v1 reste intacte en rollback. L'admin active la version
 * à exposer (onglet Administration → Versions).
 */
export const vmInventoryPluginV2: Plugin = {
  manifest: {
    id: 'vm-inventory_v2',
    name: 'VM Inventory',
    version: '0.2.0',
    routes: [
      { path: '/vms', element: VmInventoryPage },
    ],
    menu: [
      { id: 'vm-inventory', to: '/vms', labelKey: 'nav.vmInventory', icon: MonitorSmartphone, order: 40 },
    ],
  },
  init(ctx) {
    ctx.logger.info('vm-inventory_v2 prêt — 1 route + 1 entrée de menu exposées au host (console web PVE)');
  },
};
