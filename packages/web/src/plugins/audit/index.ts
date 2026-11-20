import { ShieldCheck } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { AuditPage } from './pages/audit';

/**
 * Plugin Audit / best-practices (P3) — 2ᵉ score de CONFIGURATION (en complément
 * du health score qui mesure les ressources).
 *
 * Les checks sont purs (shared/audit.ts) et calculés par le poller : l'audit vit
 * dans le snapshot WS (`snapshot.audit`) — la page le lit en direct, zéro API.
 * Chaque constat est cliquable vers la VM / nœud / stockage / cluster concerné.
 *
 * Famille `audit` — un futur module (checks agent Telegraf, P3 phase 3) réutilisera
 * le même moteur sans toucher à cette famille.
 */
export const auditPlugin: Plugin = {
  manifest: {
    id: 'audit',
    name: 'Audit / best-practices',
    version: '1.0.0',
    routes: [
      { path: '/audit', element: AuditPage },
    ],
    menu: [
      { id: 'audit', to: '/audit', labelKey: 'nav.audit', icon: ShieldCheck, order: 75 },
    ],
  },
  init(ctx) {
    ctx.logger.info('audit prêt — 1 route + 1 entrée de menu exposées au host');
  },
};
