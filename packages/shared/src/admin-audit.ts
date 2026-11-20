/**
 * Journal d'audit des actions d'administration (complément issue #2).
 *
 * Une entrée trace UNE action admin (création/modif user, groupes, catalogue,
 * reset mdp, import/export, réconciliation du catalogue). Les mots de passe ne
 * sont JAMAIS tracés — seule l'action et ses métadonnées (champs modifiés,
 * comptes, cibles) le sont.
 *
 * Le stockage (fichier JSONL append-only) est côté serveur ; ce module ne porte
 * que les types, la liste des actions connues et la pagination/filtrage purs
 * (testés ici, réutilisés par la route GET /api/admin/audit).
 */

/** Acteur d'une action admin (l'admin qui l'a effectuée). */
export interface AdminAuditActor {
  id: string;
  username: string;
}

/** Une entrée du journal d'audit admin. */
export interface AdminAuditEntry {
  /** Horodatage ISO (UTC). */
  t: string;
  /** Admin à l'origine de l'action. */
  actor: AdminAuditActor;
  /** Code machine de l'action (ex. `user.create`, `group.update`). */
  action: string;
  /** Cible de l'action (username, nom de groupe, id de module). */
  target?: string;
  /** Détails (champs modifiés, comptes, cibles). Jamais de mot de passe. */
  details?: Record<string, unknown>;
}

/** Actions admin connues (filtres + i18n). */
export const ADMIN_AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.reset-password',
  'group.create',
  'group.update',
  'group.delete',
  'group.members',
  'group.modules',
  'module.toggle',
  'catalog.sync',
  'backup.import',
  'backup.export',
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export interface AdminAuditPageOptions {
  /** Nombre d'entrées par page (défaut 50, borné ≥ 1). */
  limit?: number;
  /** Décalage depuis la PLUS RÉCENTE entrée (défaut 0). */
  offset?: number;
  /** Filtre sur l'action (égalité exacte). */
  action?: string;
  /** Filtre sur le username de l'acteur. */
  actor?: string;
}

export interface AdminAuditPage {
  /** Entrées de la page, de la plus récente à la plus ancienne. */
  entries: AdminAuditEntry[];
  /** Nombre total d'entrées correspondant aux filtres. */
  total: number;
}

/**
 * Filtre + pagin le journal d'audit. `entries` est fourni en ordre
 * chronologique (plus ancien d'abord) ; le résultat est renvoyé de la plus
 * récente à la plus ancienne, `offset` étant compté depuis la plus récente.
 * Fonction pure (testée) — la lecture du fichier est côté serveur.
 */
export function pageAuditEntries(
  entries: AdminAuditEntry[],
  opts: AdminAuditPageOptions = {},
): AdminAuditPage {
  const limit = Math.max(1, Math.floor(opts.limit ?? 50));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  let filtered = entries;
  if (opts.action) filtered = filtered.filter((e) => e.action === opts.action);
  if (opts.actor) filtered = filtered.filter((e) => e.actor.username === opts.actor);
  const newestFirst = [...filtered].reverse();
  return { entries: newestFirst.slice(offset, offset + limit), total: filtered.length };
}
