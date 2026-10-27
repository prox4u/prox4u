import { HardDrive } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { StoragePage } from './pages/storage';

/**
 * Plugin Storage — inventaire des pools de stockage, overcommit.
 * Migrated from legacy/storage (Strangler Fig, étape 4).
 */
export const storagePlugin: Plugin = {
  manifest: {
    id: 'storage',
    name: 'Storage',
    version: '0.1.0',
    routes: [
      { path: '/storage', element: StoragePage },
    ],
    menu: [
      { id: 'storage-inventory', to: '/storage', labelKey: 'nav.storage', icon: HardDrive, order: 30 },
    ],
  },
  init(ctx) {
    // Rien à initialiser pour l'instant : les données transitent par le client
    // API partagé (ctx.api) et le store WS du host (core/data).
    ctx.logger.info('storage prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
