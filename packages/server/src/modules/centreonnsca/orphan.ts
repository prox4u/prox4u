import type { CentreonConfig, CentreonPoller } from '@prox4u/shared';
import { countHostServices, deleteCenteronHost } from './provision.js';
import type { NscaStore } from './store.js';

/**
 * Suppression d'hôte orphelin — COHÉRENCE Prox4u ↔ Centreon (GitHub #21).
 *
 * Règle d'or : Prox4u ne supprime un hôte Centreon que s'il l'a créé lui-même.
 * Un hôte ou une sonde mis en place directement dans Centreon par l'admin
 * (sans passer par Prox4u) est TOUJOURS préservé.
 *
 * 3 garde-fous cumulés (tous obligatoires) pour supprimer l'hôte :
 *  1. `managedHosts` : l'hôte a été AUTO-CRÉÉ par Prox4u (provisioning REST,
 *     hôte absent + IP fournie). Un hôte créé à la main par l'admin n'y figure
 *     jamais → jamais supprimé.
 *  2. Aucune règle Prox4u ne cible plus l'hôte (hors la règle en cours de
 *     suppression) → sinon d'autres services Prox4u y vivent encore.
 *  3. 0 service restant sur l'hôte dans Centreon → protège les sondes ajoutées
 *     à la main par l'admin sur un hôte créé par Prox4u.
 *
 * Tout échec de suppression (central down) est signalé via `error` → le caller
 * réessaie (suppression en attente de la règle, ou balayage périodique suivant).
 */

export interface OrphanHostOutcome {
  /** true si l'hôte a été supprimé (ou était déjà absent). */
  hostDeleted: boolean;
  /** message d'erreur si la suppression a ÉCHOUÉ (null = pas d'échec). */
  error: string | null;
  /** détail lisible (log / flash) — raison de la décision. */
  message: string;
}

/**
 * Applique les 3 garde-fous puis supprime l'hôte si tous passent.
 * `excludeRuleId` : la règle en cours de suppression (ignorée par le garde-fou
 * 2 — elle cible encore l'hôte mais va être retirée). Absent pour le balayage
 * périodique (aucune règle en cours de suppression).
 */
export async function tryDeleteOrphanHost(
  store: NscaStore,
  cfg: CentreonConfig,
  poller: CentreonPoller,
  host: string,
  excludeRuleId?: string,
): Promise<OrphanHostOutcome> {
  // Garde-fou 1 : hôte auto-créé par Prox4u (managedHosts).
  if (!store.isManagedHost(host)) {
    return { hostDeleted: false, error: null, message: `hôte « ${host} » non géré par Prox4u → conservé` };
  }
  // Garde-fou 2 : aucune autre règle ne cible l'hôte (hors la règle supprimée).
  const targeted = store.listRules().some((r) => r.id !== excludeRuleId && r.centreonHost === host);
  if (targeted) {
    return { hostDeleted: false, error: null, message: `hôte « ${host} » encore ciblé par une règle Prox4u → conservé` };
  }
  // Garde-fou 3 : 0 service restant (protection des sondes ajoutées par l'admin).
  const svcCount = await countHostServices(cfg, host);
  if (svcCount === null) {
    // Inconnu (transport CLAPI / central injoignable) → conservatif : conservé.
    return { hostDeleted: false, error: null, message: `hôte « ${host} » : nombre de services inconnu → conservé` };
  }
  if (svcCount > 0) {
    return { hostDeleted: false, error: null, message: `hôte « ${host} » a encore ${svcCount} service(s) → conservé` };
  }
  // Les 3 garde-fous passés → suppression de l'hôte.
  const del = await deleteCenteronHost(cfg, host, poller);
  if (del.status === 'deleted' || del.status === 'not-found') {
    store.removeManagedHost(host);
    return { hostDeleted: true, error: null, message: del.message };
  }
  return { hostDeleted: false, error: del.message, message: del.message };
}
