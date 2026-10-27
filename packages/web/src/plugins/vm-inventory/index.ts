import { MonitorSmartphone } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { VmInventoryPage } from './pages/vm-inventory';

/**
 * Plugin Inventaire VM — parc VMs/LXC multi-endpoints, arborescence type vCenter
 * (Datacenter → cluster → nœud → VM), tableau filtrable et détail par onglets.
 * Lecture seule : les données transitent par le store WS du host (live 5 s)
 * et l'endpoint REST /api/vm-config pour le détail d'une VM.
 */
export const vmInventoryPlugin: Plugin = {
  manifest: {
    id: 'vm-inventory',
    name: 'VM Inventory',
    version: '0.1.0',
    routes: [
      { path: '/vms', element: VmInventoryPage },
    ],
    menu: [
      { id: 'vm-inventory', to: '/vms', labelKey: 'nav.vmInventory', icon: MonitorSmartphone, order: 40 },
    ],
  },
  init(ctx) {
    ctx.logger.info('vm-inventory prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
