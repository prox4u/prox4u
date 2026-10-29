import { MonitorSmartphone } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { VmViewPage } from './pages/vm-view';

/**
 * Plugin Vue VM — parc VMs/LXC multi-endpoints, arborescence type vCenter
 * (Datacenter → cluster → nœud → VM), tableau filtrable et détail par onglets.
 * Lecture seule : les données transitent par le store WS du host (live 5 s)
 * et l'endpoint REST /api/vm-config pour le détail d'une VM.
 */
export const vmViewPlugin: Plugin = {
  manifest: {
    id: 'vm-view',
    name: 'VM View',
    version: '0.1.0',
    routes: [
      { path: '/vms', element: VmViewPage },
    ],
    menu: [
      { id: 'vm-view', to: '/vms', labelKey: 'nav.vmView', icon: MonitorSmartphone, order: 40 },
    ],
  },
  init(ctx) {
    ctx.logger.info('vm-view prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
