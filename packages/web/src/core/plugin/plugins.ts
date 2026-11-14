import { hypervisionPlugin } from '../../plugins/hypervision';
import { hypervisionPluginV2 } from '../../plugins/hypervision_v2';
import { networkPlugin } from '../../plugins/network';
import { storagePlugin } from '../../plugins/storage';
import { vmViewPlugin } from '../../plugins/vm-view';
import { vmViewPluginV2 } from '../../plugins/vm-view_v2';
import { vmViewPluginV3 } from '../../plugins/vm-view_v3';
import { proxmoxInventoryPlugin } from '../../plugins/proxmox-inventory';
import { centreonNscaPlugin } from '../../plugins/centreon-nsca';
import { nodeSensorsPlugin } from '../../plugins/node-sensors';
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
  // Famille hypervision : v1 (rollback) + v2 (vue d'ensemble personnalisable par user).
  ...(FEATURES.USE_PLUGIN_HYPERVISION ? [hypervisionPlugin, hypervisionPluginV2] : []),
  ...(FEATURES.USE_PLUGIN_NETWORK ? [networkPlugin] : []),
  ...(FEATURES.USE_PLUGIN_STORAGE ? [storagePlugin] : []),
  // Famille vm-view : v1 (rollback) + v2 (console web PVE) + v3 (monitors personnalisables par user).
  ...(FEATURES.USE_PLUGIN_VM_VIEW ? [vmViewPlugin, vmViewPluginV2, vmViewPluginV3] : []),
  // Famille proxmox-inventory : inventaire consolidé (une machine par ligne + export).
  ...(FEATURES.USE_PLUGIN_PROXMOX_INVENTORY ? [proxmoxInventoryPlugin] : []),
  // Famille centreon-nsca : alarmes & checks passifs NSCA (règles → Centreon).
  ...(FEATURES.USE_PLUGIN_CENTREON_NSCA ? [centreonNscaPlugin] : []),
  // Famille node-sensors : métriques locales Telegraf (SMART, capteurs, ZFS, unités).
  ...(FEATURES.USE_PLUGIN_NODE_SENSORS ? [nodeSensorsPlugin] : []),
];
