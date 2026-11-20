import type { QdeviceState, QuorumState } from './types.js';

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

/**
 * État du Qdevice (vote de quorum externe, ex. `pvecm status` → membership
 * « 0x00000000 Qdevice ») — **déduit des données API PVE** (l'API n'expose pas
 * le Qdevice, seulement `quorate` + `nodes`).
 *
 * Principe : le quorum d'un cluster de N nœuds SANS Qdevice = `floor(N/2)+1`.
 *  - Nœuds en ligne ≥ ce seuil → les nœuds suffisent : l'état du Qdevice n'a
 *    aucun impact sur le quorum → `'unknown'` (indéterminé, indifférent).
 *  - Nœuds en ligne < ce seuil MAIS cluster quorate → le **Qdevice est en
 *    ligne** (il fournit les votes manquants — c'est lui qui sauve le quorum).
 *  - Nœuds en ligne < ce seuil ET cluster non quorate → le **Qdevice est hors
 *    ligne** (ou absent).
 *
 * Cas typique 2 nœuds + Qdevice (seuil sans Qdevice = 2) : 1 nœud down +
 * quorate → Qdevice en ligne ; 1 nœud down + non quorate → Qdevice hors ligne.
 */
export function deriveQdeviceState(
  nodesTotal: number,
  nodesOnline: number,
  quorumState: QuorumState | null,
): QdeviceState {
  if (nodesTotal <= 0 || quorumState == null) return 'unknown';
  const noQdeviceQuorum = Math.floor(nodesTotal / 2) + 1;
  if (nodesOnline >= noQdeviceQuorum) return 'unknown';
  return quorumState === 'ok' ? 'up' : 'down';
}

/**
 * État du Qdevice à partir des données **corosync** (table Telegraf
 * `quorum_detail`, issue de `pvecm status`) — source d'autorité, plus précise
 * que la déduction API : elle distingue l'absence d'un Qdevice configuré
 * (`'absent'`) de l'indéterminé API (`'unknown'`), et donne l'état réel même
 * quand les nœuds seuls suffisent au quorum (cas 2/2).
 *
 *  - `hasQdevice=false` → `'absent'` (pas de Qdevice configuré).
 *  - `hasQdevice=true` + `qdeviceOnline=true` → `'up'` (en ligne).
 *  - `hasQdevice=true` + `qdeviceOnline=false` → `'down'` (configuré mais hors ligne).
 */
export function qdeviceStateFromCorosync(hasQdevice: boolean, qdeviceOnline: boolean): QdeviceState {
  if (!hasQdevice) return 'absent';
  return qdeviceOnline ? 'up' : 'down';
}
