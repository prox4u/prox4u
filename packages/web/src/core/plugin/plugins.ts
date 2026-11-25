import { hypervisionPlugin } from '../../plugins/hypervision';
import { hypervisionPluginV2 } from '../../plugins/hypervision_v2';
import { hypervisionPluginV3 } from '../../plugins/hypervision_v3';
import { hypervisionPluginV4 } from '../../plugins/hypervision_v4';
import { networkPlugin } from '../../plugins/network';
import { storagePlugin } from '../../plugins/storage';
import { vmViewPlugin } from '../../plugins/vm-view';
import { vmViewPluginV2 } from '../../plugins/vm-view_v2';
import { vmViewPluginV3 } from '../../plugins/vm-view_v3';
import { vmViewPluginV4 } from '../../plugins/vm-view_v4';
import { proxmoxInventoryPlugin } from '../../plugins/proxmox-inventory';
import { centreonNscaPlugin } from '../../plugins/centreon-nsca';
import { nodeSensorsPlugin } from '../../plugins/node-sensors';
import { auditPlugin } from '../../plugins/audit';
import { influxdbPlugin } from '../../plugins/influxdb';
import { docsPlugin } from '../../plugins/docs';
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
  // Famille hypervision : v1 (rollback) + v2 (vue d'ensemble personnalisable par user)
  // + v3 (bibliothèque complétée : widget températures par nœud, référence ProxMenux)
  // + v4 (bibliothèque sur TOUTES les pages : cluster + nœud — grille unifiée).
  ...(FEATURES.USE_PLUGIN_HYPERVISION ? [hypervisionPlugin, hypervisionPluginV2, hypervisionPluginV3, hypervisionPluginV4] : []),
  ...(FEATURES.USE_PLUGIN_NETWORK ? [networkPlugin] : []),
  ...(FEATURES.USE_PLUGIN_STORAGE ? [storagePlugin] : []),
  // Famille vm-view : v1 (rollback) + v2 (console web PVE) + v3 (monitors personnalisables par user)
  // + v4 (bibliothèque complétée : 6 widgets Monitor nœud, référence ProxMenux).
  ...(FEATURES.USE_PLUGIN_VM_VIEW ? [vmViewPlugin, vmViewPluginV2, vmViewPluginV3, vmViewPluginV4] : []),
  // Famille proxmox-inventory : inventaire consolidé (une machine par ligne + export).
  ...(FEATURES.USE_PLUGIN_PROXMOX_INVENTORY ? [proxmoxInventoryPlugin] : []),
  // Famille centreon-nsca : alarmes & checks passifs NSCA (règles → Centreon).
  ...(FEATURES.USE_PLUGIN_CENTREON_NSCA ? [centreonNscaPlugin] : []),
  // Famille node-sensors : métriques locales Telegraf (SMART, capteurs, ZFS, unités).
  ...(FEATURES.USE_PLUGIN_NODE_SENSORS ? [nodeSensorsPlugin] : []),
  // Famille audit : 2ᵉ score de configuration (best-practices, P3) — checks purs,
  // audit dans le snapshot WS, constats cliquables vers la VM/nœud/stockage.
  ...(FEATURES.USE_PLUGIN_AUDIT ? [auditPlugin] : []),
  // Famille influxdb : vision + action sur InfluxDB 3 Core (KPIs, graphiques,
  // bases, archivage, actions restreintes aux groupes INFLUX_ACTION_GROUPS).
  ...(FEATURES.USE_PLUGIN_INFLUXDB ? [influxdbPlugin] : []),
  // Famille docs : notices d'utilisation par module (Markdown → HTML, accès
  // par module = visibleModuleIds).
  ...(FEATURES.USE_PLUGIN_DOCS ? [docsPlugin] : []),
];
