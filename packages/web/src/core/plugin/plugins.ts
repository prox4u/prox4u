import { hypervisionPlugin } from '../../plugins/hypervision';
import { networkPlugin } from '../../plugins/network';
import { storagePlugin } from '../../plugins/storage';
import { vmViewPlugin } from '../../plugins/vm-view';
import { vmViewPluginV2 } from '../../plugins/vm-view_v2';
import { proxmoxInventoryPlugin } from '../../plugins/proxmox-inventory';
import { FEATURES } from '../config/features';
import type { Plugin } from './types';

/**
 * Tableau statique des plugins (imports explicites).
 * Un plugin n'est chargé que si son feature flag est ON (défaut) ; un flag OFF
 * désactive proprement le module (disjoncteur, voir core/config/features.ts).
 *
 * Versionnement : les versions d'une même famille sont listées côte à côte
 * (`vm-view` + `vm-view_v2`) — le loader initialise TOUTES les
 * versions ; la plus récente porte la route canonique de la famille.
 */
export const PLUGINS: Plugin[] = [
  ...(FEATURES.USE_PLUGIN_HYPERVISION ? [hypervisionPlugin] : []),
  ...(FEATURES.USE_PLUGIN_NETWORK ? [networkPlugin] : []),
  ...(FEATURES.USE_PLUGIN_STORAGE ? [storagePlugin] : []),
  // Famille vm-view : v1 (rollback) + v2 (console web PVE).
  ...(FEATURES.USE_PLUGIN_VM_VIEW ? [vmViewPlugin, vmViewPluginV2] : []),
  // Famille proxmox-inventory : inventaire consolidé (une machine par ligne + export).
  ...(FEATURES.USE_PLUGIN_PROXMOX_INVENTORY ? [proxmoxInventoryPlugin] : []),
];
