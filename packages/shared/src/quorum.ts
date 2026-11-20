import type { QuorumState } from './types.js';

/**
 * Dérive l'état du quorum d'un cluster.
 *
 * Préfère l'état rapporté par PVE (`quorum_state` de l'entrée cluster de
 * /cluster/status, PVE 8+) ; à défaut, dérive du nombre de nœuds en ligne :
 * `en ligne < quorum requis → 'lost'` (sinon 'ok').
 *
 * Renvoie null si inconnu (quorum absent — ex. entrée cluster manquée).
 * Le quorum perdu bloque toute opération du cluster (guests toujours actifs).
 */
export function deriveQuorumState(
  onlineNodes: number,
  quorum: number | null,
  reported: QuorumState | null = null,
): QuorumState | null {
  if (reported) return reported;
  if (quorum == null || quorum <= 0) return null;
  return onlineNodes < quorum ? 'lost' : 'ok';
}
