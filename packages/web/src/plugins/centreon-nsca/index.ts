import { Siren } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { CreateRulePage } from './pages/create-rule';
import { EditRulePage } from './pages/edit-rule';
import { RulesPage } from './pages/rules';

/**
 * Plugin Alarmes & Checks passifs NSCA (centreon-nsca) — règles de surveillance
 * sur VMs/nœuds Proxmox → alarmes → Centreon via send_nsca (checks passifs).
 *
 * - /alarms       : Page 2 — tableau des règles (filtres, recherche, tri,
 *                   activer/désactiver, Tester, Reprovisionner, indicateurs).
 * - /alarms/new   : Page 1 — formulaire de création (provisionne le service
 *                   Centreon via CLAPI ou REST v1, puis enregistre la règle).
 *
 * Page 3 (configuration du module : central, pollers, transport CLAPI/REST,
 * mapping VM→hôte) vit dans l'onglet « Centreon (NSCA) » de la page
 * Administration (components/admin/nsca-config.tsx).
 *
 * Famille `centreon-nsca` — un futur backend Zabbix partagera le namespace
 * /api/alarms/* sans toucher à cette famille.
 */
export const centreonNscaPlugin: Plugin = {
  manifest: {
    id: 'centreon-nsca',
    name: 'Alarmes & Centreon',
    version: '0.1.0',
    routes: [
      { path: '/alarms', element: RulesPage },
      { path: '/alarms/new', element: CreateRulePage },
      { path: '/alarms/edit/:id', element: EditRulePage },
    ],
    menu: [
      { id: 'centreon-nsca', to: '/alarms', labelKey: 'nav.alarms', icon: Siren, order: 60 },
    ],
  },
  init(ctx) {
    ctx.logger.info('centreon-nsca prêt — 3 routes (/alarms, /alarms/new, /alarms/edit/:id) + 1 entrée de menu exposées au host');
  },
};
