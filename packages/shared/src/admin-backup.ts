import type { AuthFile, Group, User } from './auth.js';
import type { UserConfig } from './user-config.js';

/**
 * Import/export des utilisateurs, groupes et « gestion des graphiques »
 * (layouts de grilles par user) — complément issue #2.
 *
 * Le bundle porte l'état de data/auth.json (users, groups, modules, tables de
 * jointure) + les configs de graphiques par user. L'IMPORT est une FUSION par
 * identifiant (pas un remplacement total) : les comptes/groupes locaux absents
 * du bundle sont conservés. La logique de fusion est une fonction PURE (testée
 * ici) ; la lecture/écriture des fichiers (auth.json + user-configs) est côté
 * serveur.
 */

/** Bundle de sauvegarde (rôle admin — contient les hashes argon2id). */
export interface BackupBundle {
  version: 1;
  /** Horodatage ISO de l'export. */
  exportedAt: string;
  /** État de data/auth.json. */
  auth: AuthFile;
  /**
   * Configs de graphiques par user (clé = userId AU MOMENT DE L'EXPORT,
   * null = jamais personnalisé). Remappées par username à l'import.
   */
  userConfigs: Record<string, UserConfig | null>;
}

/** Statistiques de la fusion (pour l'audit). */
export interface BackupMergeStats {
  usersCreated: number;
  usersUpdated: number;
  groupsCreated: number;
  groupsUpdated: number;
}

export interface BackupMergeResult {
  /** Nouvel état auth (le local d'origine n'est pas muté). */
  nextAuth: AuthFile;
  /** exportUserId → localUserId (remappage des jointures + userConfigs). */
  userMap: Record<string, string>;
  /** exportGroupId → localGroupId. */
  groupMap: Record<string, string>;
  stats: BackupMergeStats;
}

/** Options injectées (déterminisme des tests). */
export interface BackupMergeOptions {
  /** Génère un nouvel id (`u_…` / `g_…`). */
  newId: (prefix: string) => string;
  /** Horodatage ISO courant. */
  nowIso: () => string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Valide + normalise un bundle de sauvegarde (JSON brut → BackupBundle).
 * Retourne null si la structure est inattendue (version, tables, champs
 * requis). Fonction pure (testée) — tolérante sur les détails (les entrées
 * mal formées sont filtrées, pas rejetées).
 */
export function parseBackupBundle(raw: unknown): BackupBundle | null {
  if (!isObj(raw) || raw.version !== 1) return null;
  const auth = raw.auth;
  if (!isObj(auth)) return null;
  if (!Array.isArray(auth.users) || !Array.isArray(auth.groups) || !Array.isArray(auth.modules)) return null;
  if (!Array.isArray(auth.userGroups) || !Array.isArray(auth.userModules) || !Array.isArray(auth.groupModules)) return null;

  const users = auth.users.filter((u): u is User => isObj(u) && typeof u.id === 'string' && typeof u.username === 'string');
  const groups = auth.groups.filter((g): g is Group => isObj(g) && typeof g.id === 'string' && typeof g.name === 'string');
  const modules = auth.modules.filter(
    (m): m is AuthFile['modules'][number] => isObj(m) && typeof m.id === 'string' && typeof m.globallyEnabled === 'boolean',
  );
  const userGroups = auth.userGroups.filter(
    (ug): ug is AuthFile['userGroups'][number] => isObj(ug) && typeof ug.userId === 'string' && typeof ug.groupId === 'string',
  );
  const userModules = auth.userModules.filter(
    (um): um is AuthFile['userModules'][number] => isObj(um) && typeof um.userId === 'string' && typeof um.moduleId === 'string',
  );
  const groupModules = auth.groupModules.filter(
    (gm): gm is AuthFile['groupModules'][number] => isObj(gm) && typeof gm.groupId === 'string' && typeof gm.moduleId === 'string',
  );

  return {
    version: 1,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    auth: {
      version: 1,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: typeof u.displayName === 'string' ? u.displayName : u.username,
        role: u.role === 'admin' ? 'admin' : 'user',
        provider: u.provider === 'ad' ? 'ad' : 'local',
        passwordHash: typeof u.passwordHash === 'string' ? u.passwordHash : null,
        mustChangePassword: u.mustChangePassword === true,
        active: u.active !== false,
        createdAt: typeof u.createdAt === 'string' ? u.createdAt : '',
        updatedAt: typeof u.updatedAt === 'string' ? u.updatedAt : '',
      })),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: typeof g.description === 'string' ? g.description : '',
      })),
      modules: modules.map((m) => ({
        id: m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
        description: typeof m.description === 'string' ? m.description : '',
        globallyEnabled: m.globallyEnabled,
      })),
      userGroups,
      userModules,
      groupModules,
    },
    userConfigs: isObj(raw.userConfigs) ? (raw.userConfigs as BackupBundle['userConfigs']) : {},
  };
}

/**
 * Fusionne un bundle de sauvegarde dans l'état auth local.
 *
 * Sémantique :
 * - **users** matchés par `username` : existant → mis à jour (displayName,
 *   role, active, mustChangePassword, passwordHash — l'id local et createdAt
 *   sont conservés) ; absent → créé avec un nouvel id. Les users locaux absents
 *   du bundle sont conservés tels quels.
 * - **groups** matchés par `name` : existant → description mise à jour ; absent
 *   → créé avec un nouvel id. Les groupes locaux absents du bundle sont conservés.
 * - **modules** : l'état `globallyEnabled` du bundle est appliqué aux modules
 *   qui existent LOCALEMENT (la structure du catalogue reste du ressort du
 *   code / de la réconciliation au boot).
 * - **tables de jointure** (userGroups / userModules / groupModules) : UNION
 *   du bundle (ids remappés via userMap/groupMap) et du local, dédupliquée —
 *   rien n'est perdu. Les références vers des ids inconnus sont ignorées.
 *
 * `userConfigs` n'est PAS traité ici (fichiers séparés) — le serveur les
 * réécrit en remappant les clés via `userMap`.
 */
export function mergeBackupBundle(local: AuthFile, bundle: BackupBundle, opts: BackupMergeOptions): BackupMergeResult {
  const { newId, nowIso } = opts;
  const ts = nowIso();

  // Copie profonde du local (le local d'origine n'est pas muté).
  const next: AuthFile = {
    version: 1,
    users: local.users.map((u) => ({ ...u })),
    groups: local.groups.map((g) => ({ ...g })),
    modules: local.modules.map((m) => ({ ...m })),
    userGroups: local.userGroups.map((ug) => ({ ...ug })),
    userModules: local.userModules.map((um) => ({ ...um })),
    groupModules: local.groupModules.map((gm) => ({ ...gm })),
  };

  const userMap: Record<string, string> = {};
  const groupMap: Record<string, string> = {};
  const stats: BackupMergeStats = { usersCreated: 0, usersUpdated: 0, groupsCreated: 0, groupsUpdated: 0 };

  // --- users (par username) ---
  const localUserByUsername = new Map(next.users.map((u) => [u.username, u]));
  for (const bu of bundle.auth.users) {
    const existing = localUserByUsername.get(bu.username);
    if (existing) {
      existing.displayName = bu.displayName;
      existing.role = bu.role;
      existing.active = bu.active;
      existing.mustChangePassword = bu.mustChangePassword;
      existing.passwordHash = bu.passwordHash;
      existing.updatedAt = ts;
      userMap[bu.id] = existing.id;
      stats.usersUpdated += 1;
    } else {
      const nu: User = {
        id: newId('u'),
        username: bu.username,
        displayName: bu.displayName,
        role: bu.role,
        provider: bu.provider,
        passwordHash: bu.passwordHash,
        mustChangePassword: bu.mustChangePassword,
        active: bu.active,
        createdAt: ts,
        updatedAt: ts,
      };
      next.users.push(nu);
      localUserByUsername.set(bu.username, nu);
      userMap[bu.id] = nu.id;
      stats.usersCreated += 1;
    }
  }

  // --- groups (par name) ---
  const localGroupByName = new Map(next.groups.map((g) => [g.name, g]));
  for (const bg of bundle.auth.groups) {
    const existing = localGroupByName.get(bg.name);
    if (existing) {
      existing.description = bg.description;
      groupMap[bg.id] = existing.id;
      stats.groupsUpdated += 1;
    } else {
      const ng: Group = { id: newId('g'), name: bg.name, description: bg.description };
      next.groups.push(ng);
      localGroupByName.set(bg.name, ng);
      groupMap[bg.id] = ng.id;
      stats.groupsCreated += 1;
    }
  }

  // --- modules : état globallyEnabled du bundle sur les modules locaux ---
  const localModuleById = new Map(next.modules.map((m) => [m.id, m]));
  for (const bm of bundle.auth.modules) {
    const lm = localModuleById.get(bm.id);
    if (lm) lm.globallyEnabled = bm.globallyEnabled;
  }

  // --- tables de jointure : union (bundle remappé) ∪ local, dédupliquée ---
  const validUserIds = new Set(next.users.map((u) => u.id));
  const validGroupIds = new Set(next.groups.map((g) => g.id));
  const validModuleIds = new Set(next.modules.map((m) => m.id));

  const ugSeen = new Set(next.userGroups.map((ug) => `${ug.userId}\u0000${ug.groupId}`));
  for (const bu of bundle.auth.userGroups) {
    const userId = userMap[bu.userId];
    const groupId = groupMap[bu.groupId];
    if (!userId || !groupId || !validUserIds.has(userId) || !validGroupIds.has(groupId)) continue;
    const k = `${userId}\u0000${groupId}`;
    if (!ugSeen.has(k)) {
      ugSeen.add(k);
      next.userGroups.push({ userId, groupId });
    }
  }

  const umSeen = new Set(next.userModules.map((um) => `${um.userId}\u0000${um.moduleId}`));
  for (const bu of bundle.auth.userModules) {
    const userId = userMap[bu.userId];
    if (!userId || !validUserIds.has(userId) || !validModuleIds.has(bu.moduleId)) continue;
    const k = `${userId}\u0000${bu.moduleId}`;
    if (!umSeen.has(k)) {
      umSeen.add(k);
      next.userModules.push({ userId, moduleId: bu.moduleId });
    }
  }

  const gmSeen = new Set(next.groupModules.map((gm) => `${gm.groupId}\u0000${gm.moduleId}`));
  for (const bg of bundle.auth.groupModules) {
    const groupId = groupMap[bg.groupId];
    if (!groupId || !validGroupIds.has(groupId) || !validModuleIds.has(bg.moduleId)) continue;
    const k = `${groupId}\u0000${bg.moduleId}`;
    if (!gmSeen.has(k)) {
      gmSeen.add(k);
      next.groupModules.push({ groupId, moduleId: bg.moduleId });
    }
  }

  return { nextAuth: next, userMap, groupMap, stats };
}
