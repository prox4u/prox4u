/**
 * Feature flags des plugins (disjoncteurs) :
 * - flag ON  (défaut) → le module est servi par son plugin ;
 * - flag OFF → le module est désactivé proprement (écran de repli ModuleDisabled,
 *   pas d'entrée de menu, pas de route morte).
 *
 * Bascule sans modifier le code, via variables d'environnement Vite :
 *   VITE_USE_PLUGIN_STORAGE=false pnpm dev
 */
const env = import.meta.env;

export const FEATURES = {
  // Legacy supprimé après validation (étape 2) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_HYPERVISION: env.VITE_USE_PLUGIN_HYPERVISION !== 'false',
  // Legacy supprimé après validation (étape 3) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_NETWORK: env.VITE_USE_PLUGIN_NETWORK !== 'false',
  // Legacy supprimé après validation (étape 4) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_STORAGE: env.VITE_USE_PLUGIN_STORAGE !== 'false',
  // Vue VMs/LXC (arborescence vCenter + détail) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_VM_VIEW: env.VITE_USE_PLUGIN_VM_VIEW !== 'false',
  // Inventaire Proxmox consolidé (une machine par ligne, export) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_PROXMOX_INVENTORY: env.VITE_USE_PLUGIN_PROXMOX_INVENTORY !== 'false',
  // Alarmes & Checks passifs NSCA (règles → Centreon via send_nsca) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_CENTREON_NSCA: env.VITE_USE_PLUGIN_CENTREON_NSCA !== 'false',
  // Métriques locales Telegraf (SMART, capteurs, ZFS, unités systemd) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_NODE_SENSORS: env.VITE_USE_PLUGIN_NODE_SENSORS !== 'false',
  // Audit / best-practices (2ᵉ score de configuration, P3) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_AUDIT: env.VITE_USE_PLUGIN_AUDIT !== 'false',
  // InfluxDB 3 Core (vision + action sur la base de métriques) : défaut ON, disjoncteur opt-out.
  USE_PLUGIN_INFLUXDB: env.VITE_USE_PLUGIN_INFLUXDB !== 'false',
} as const;

export type FeatureFlag = keyof typeof FEATURES;
