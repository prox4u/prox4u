import { Boxes } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { ProxmoxInventoryPage } from './pages/proxmox-inventory';

/**
 * Plugin Inventaire Proxmox consolidé — une machine par ligne (QEMU + LXC),
 * multi-endpoints, avec disques par filesystem (agent invité), interfaces + IPs,
 * tags, notes. Recherche globale, filtres par colonne, tri, et export TXT/CSV/JSON
 * de la vue filtrée. Les données sont servies par GET /api/proxmox-inventory
 * (cache serveur 5 min, réutilise Prox4uClient : getResources + getAgentFsUsage +
 * getVmAgentNets/getLxcInterfaces).
 */
export const proxmoxInventoryPlugin: Plugin = {
  manifest: {
    id: 'proxmox-inventory',
    name: 'Proxmox Inventory',
    version: '0.1.0',
    routes: [
      { path: '/proxmox-inventory', element: ProxmoxInventoryPage },
    ],
    menu: [
      { id: 'proxmox-inventory', to: '/proxmox-inventory', labelKey: 'nav.proxmoxInventory', icon: Boxes, order: 50 },
    ],
  },
  init(ctx) {
    ctx.logger.info('proxmox-inventory prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
