/**
 * Multi-utilisateurs — modèle de données et fonctions pures (testées).
 * Source unique de la règle de visibilité des modules, partagée serveur/web.
 *
 * Règle : un utilisateur VOIT une version de module SI
 *   (version activée globalement OU famille autorisée à un de ses groupes)
 *   ET l'utilisateur l'a sélectionnée dans ses préférences (id exact de version).
 * L'état « pour tout le monde » est par VERSION : le catalogue contient une
 * entrée par version (v1 = id de famille, vN = `<famille>_vN`), chacune avec
 * son propre globallyEnabled. Les groupes autorisent toujours la famille entière.
 *
 * Port de l'ancienne app (Proxmox Manager) — les ids de modules correspondent
 * aux familles de plugins Prox4u (hypervision, network, storage, vm-inventory).
 */

import { parsePluginVersion } from './module-versions';

export type Role = 'admin' | 'user';
/** 'local' = mot de passe géré par l'app ; 'ad' = futur (compte Active Directory, sans hash local). */
export type ProviderId = 'local' | 'ad';

export interface User {
  id: string;
  /** identifiant de connexion (unique) */
  username: string;
  displayName: string;
  role: Role;
  provider: ProviderId;
  /** hash argon2id — null pour les futurs comptes AD */
  passwordHash: string | null;
  /** forçage du changement de mot de passe à la prochaine connexion */
  mustChangePassword: boolean;
  /** désactivation douce (jamais de suppression) */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Group {
  id: string;
  name: string;
  description: string;
}

export interface ModuleDef {
  /** identifiant stable = famille de plugin (idempotent avec le registre web) */
  id: string;
  name: string;
  description: string;
  /** catalogue global activé par l'admin (visible par tous) */
  globallyEnabled: boolean;
}

/** Tables de jointure (user_groups, user_modules = préférences, group_modules = autorisations). */
export interface UserGroup {
  userId: string;
  groupId: string;
}
export interface UserModule {
  userId: string;
  moduleId: string;
}
export interface GroupModule {
  groupId: string;
  moduleId: string;
}

/** Contenu de data/auth.json (fichier gitignored, chmod 600). */
export interface AuthFile {
  version: 1;
  users: User[];
  groups: Group[];
  modules: ModuleDef[];
  userGroups: UserGroup[];
  userModules: UserModule[];
  groupModules: GroupModule[];
}

/** Utilisateur exposé par l'API (jamais de hash de mot de passe). */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  provider: ProviderId;
  mustChangePassword: boolean;
  active: boolean;
  groupIds: string[];
  selectedModuleIds: string[];
}

/**
 * Payload renvoyé par POST /api/auth/login et GET /api/auth/me :
 * utilisateur + modules autorisés/visibles.
 */
export interface AuthPayload {
  user: PublicUser;
  /** Entrées du catalogue (une par version) que l'utilisateur PEUT sélectionner. */
  authorizedModules: ModuleDef[];
  /** Familles visibles (au moins une version visible) — routes (ModuleRoute). */
  visibleModuleIds: string[];
  /** Ids de versions EXACTS visibles (autorisées ∩ préférences) — menu, routes. */
  visibleVersionIds: string[];
}

/**
 * Familles AUTORISÉES à l'utilisateur : au moins une entrée du catalogue de la
 * famille activée globalement OU la famille attribuée à un de ses groupes.
 * (Préférences non prises en compte ici.) Les entrées du catalogue peuvent être
 * des versions (`<famille>_vN`) — on normalise toujours en famille.
 */
export function authorizedModuleIds(
  userId: string,
  f: Pick<AuthFile, 'modules' | 'userGroups' | 'groupModules'>,
): Set<string> {
  const myGroups = new Set(f.userGroups.filter((ug) => ug.userId === userId).map((ug) => ug.groupId));
  const out = new Set<string>();
  for (const m of f.modules) {
    if (m.globallyEnabled) out.add(parsePluginVersion(m.id).family);
  }
  for (const gm of f.groupModules) {
    if (myGroups.has(gm.groupId)) out.add(parsePluginVersion(gm.moduleId).family);
  }
  return out;
}

/**
 * Entrées du catalogue AUTORISÉES à l'utilisateur, au niveau VERSION : l'entrée
 * est activée globalement OU sa famille est attribuée à un de ses groupes.
 * C'est LA liste des lignes de « Mon profil → Modules » (servie par /me) : une
 * ligne ne sert que si la version qu'elle propose peut être visible.
 */
export function authorizedModuleEntries(
  userId: string,
  f: Pick<AuthFile, 'modules' | 'userGroups' | 'groupModules'>,
): ModuleDef[] {
  const myGroups = new Set(f.userGroups.filter((ug) => ug.userId === userId).map((ug) => ug.groupId));
  const groupFamilies = new Set(
    f.groupModules.filter((gm) => myGroups.has(gm.groupId)).map((gm) => parsePluginVersion(gm.moduleId).family),
  );
  return f.modules.filter((m) => m.globallyEnabled || groupFamilies.has(parsePluginVersion(m.id).family));
}

/**
 * Versions VISIBLES : l'entrée du catalogue est autorisée (activée globalement
 * OU famille attribuée à un groupe de l'utilisateur) ET sélectionnée par son id
 * EXACT dans les préférences. Les versions sélectionnées mais sans entrée
 * (avant la synchronisation du catalogue) héritent de l'autorisation de leur
 * famille.
 */
export function computeVisibleVersionIds(
  userId: string,
  f: Pick<AuthFile, 'modules' | 'userGroups' | 'groupModules' | 'userModules'>,
): Set<string> {
  const authorized = authorizedModuleEntries(userId, f);
  const selected = new Set(f.userModules.filter((um) => um.userId === userId).map((um) => um.moduleId));
  const entries = new Map(f.modules.map((m) => [m.id, m]));
  const out = new Set(authorized.filter((m) => selected.has(m.id)).map((m) => m.id));
  // Versions sélectionnées sans entrée de catalogue (état pré-synchronisation) :
  // repli sur l'autorisation de la famille, comme le ferait la création par sync.
  const authorizedFamilies = new Set(authorized.map((m) => parsePluginVersion(m.id).family));
  for (const id of selected) {
    if (entries.has(id)) continue;
    if (authorizedFamilies.has(parsePluginVersion(id).family)) out.add(id);
  }
  return out;
}

/**
 * Familles VISIBLES : dérivé des versions visibles (au moins une version de la
 * famille autorisée ET sélectionnée). Utilisé par les ModuleRoute.
 */
export function computeVisibleModuleIds(
  userId: string,
  f: Pick<AuthFile, 'modules' | 'userGroups' | 'groupModules' | 'userModules'>,
): Set<string> {
  return new Set([...computeVisibleVersionIds(userId, f)].map((id) => parsePluginVersion(id).family));
}

/**
 * Une préférence de module est valide si sa FAMILLE est autorisée — l'id peut
 * être la famille (v1) ou une version dérivée (`<famille>_vN`). Tout autre id
 * (famille inconnue) est rejeté.
 */
export function isAuthorizedModuleSelection(id: string, authorized: Set<string>): boolean {
  return authorized.has(parsePluginVersion(id).family);
}

/** Déclinaison publique d'un User (pour les réponses API). */
export function toPublicUser(user: User, f: Pick<AuthFile, 'userGroups' | 'userModules'>): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    provider: user.provider,
    mustChangePassword: user.mustChangePassword,
    active: user.active,
    groupIds: f.userGroups.filter((ug) => ug.userId === user.id).map((ug) => ug.groupId),
    selectedModuleIds: f.userModules.filter((um) => um.userId === user.id).map((um) => um.moduleId),
  };
}

/** Politique de mot de passe : ≥ 8 caractères, au moins une lettre et un chiffre. */
export type PasswordIssue = 'too-short' | 'no-letter' | 'no-digit';

export function validatePassword(pw: string): PasswordIssue | null {
  if (pw.length < 8) return 'too-short';
  if (!/[a-zA-Z]/.test(pw)) return 'no-letter';
  if (!/\d/.test(pw)) return 'no-digit';
  return null;
}

/**
 * Catalogue de modules initial (seed de data/auth.json au 1er démarrage).
 * Ids = familles de plugins Prox4u ; activés globalement par défaut
 * (l'admin peut restreindre ensuite via le catalogue ou les groupes).
 */
export const DEFAULT_MODULES: ModuleDef[] = [
  {
    id: 'hypervision',
    name: 'Général',
    description: "Vue d'ensemble, dashboards par endpoint et nœuds",
    globallyEnabled: true,
  },
  {
    id: 'network',
    name: 'Réseaux',
    description: 'Topologie réseau auto-découverte (switches, ponts, VLAN, VMs)',
    globallyEnabled: true,
  },
  {
    id: 'storage',
    name: 'Stockage',
    description: "Inventaire des datastores et des VMs qui y sont stockées",
    globallyEnabled: true,
  },
  {
    id: 'vm-inventory',
    name: 'Inventaire VM',
    description: 'Parc VMs/LXC multi-endpoints (arborescence type vCenter)',
    globallyEnabled: true,
  },
  {
    id: 'proxmox-inventory',
    name: 'Inventaire Proxmox',
    description: 'Vue consolidée d’une machine par ligne : OS, disques par filesystem, interfaces, IPs, export',
    globallyEnabled: true,
  },
];
