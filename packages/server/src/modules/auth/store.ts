import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_MODULES, PLUGIN_ID_RE, parsePluginVersion, type AuthFile, type Group, type ModuleDef, type Role, type User, type UserGroup } from '@prox4u/shared';

/**
 * Stockage des données d'authentification : un seul fichier data/auth.json
 * (gitignored, chmod 600), cache en mémoire + écriture atomique (tmp → rename).
 *
 * Seed au 1er démarrage : compte admin/proX4u (changement de mot de passe forcé)
 * + catalogue des modules existants, AUCUN module activé globalement.
 */

const ADMIN_USERNAME = 'admin';
const ADMIN_INITIAL_PASSWORD = 'proX4u';

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Fichier initial : admin forcé au changement de mdp + modules du catalogue (désactivés). */
export function seedAuthFile(): AuthFile {
  const ts = nowIso();
  return {
    version: 1,
    users: [
      {
        id: newId('u'),
        username: ADMIN_USERNAME,
        displayName: 'Administrateur',
        role: 'admin',
        provider: 'local',
        passwordHash: null, // rempli par init() (hash asynchrone)
        mustChangePassword: true,
        active: true,
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    groups: [],
    modules: DEFAULT_MODULES.map((m) => ({ ...m })),
    userGroups: [],
    userModules: [],
    groupModules: [],
  };
}

export class AuthStore {
  private file: AuthFile | null = null;

  constructor(
    private filePath: string,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
  ) {}

  /** Charge (ou crée) le fichier. À appeler une fois au démarrage — fail-fast si corrompu. */
  async init(hashPassword: (pw: string) => Promise<string>): Promise<void> {
    if (existsSync(this.filePath)) {
      let raw: string;
      try {
        raw = readFileSync(this.filePath, 'utf8');
      } catch (err) {
        throw new Error(`data/auth.json illisible : ${(err as Error).message}`);
      }
      this.file = this.parse(raw);
      if (this.reconcileModules()) {
        this.persist();
        this.logger.info('auth : catalogue des modules réconcilié avec le code (modules ajoutés/retirés, références nettoyées)');
      }
      this.logger.info(`auth : ${this.file.users.length} utilisateur(s), ${this.file.groups.length} groupe(s) chargés depuis data/auth.json`);
      return;
    }
    // 1er démarrage : seed + hash du mot de passe admin initial
    const seeded = seedAuthFile();
    const admin = seeded.users[0];
    admin.passwordHash = await hashPassword(ADMIN_INITIAL_PASSWORD);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.file = seeded;
    this.persist();
    this.logger.info('auth : data/auth.json créé (compte admin initial — changement de mot de passe forcé au 1er login, catalogue vide)');
  }

  /** Validation structurelle minimale du fichier (fail-fast au boot). */
  private parse(raw: string): AuthFile {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`data/auth.json invalide (JSON) : ${(err as Error).message}`);
    }
    const f = data as AuthFile;
    if (f.version !== 1 || !Array.isArray(f.users) || !Array.isArray(f.groups) || !Array.isArray(f.modules)) {
      throw new Error('data/auth.json invalide : structure inattendue (version/users/groups/modules)');
    }
    return f;
  }

  /**
   * Réconcilie le catalogue des modules avec le code (DEFAULT_MODULES) au chargement :
   * - un module présent dans le fichier mais dont la FAMILLE n'est plus dans le
   *   code est retiré (ex. « supervision » découpé en networks/storage) et ses
   *   références sont nettoyées (groupModules, userModules) ; les entrées de
   *   version (`<famille>_vN`) d'une famille connue sont conservées ;
   * - un module par défaut absent du fichier est ajouté (globallyEnabled=false).
   * Retourne true si le fichier a été modifié.
   */
  private reconcileModules(): boolean {
    const f = this.file!;
    const defaults = new Map(DEFAULT_MODULES.map((m) => [m.id, m]));
    // Une entrée (famille OU version _vN) est connue si sa famille l'est.
    const isKnown = (id: string) => defaults.has(parsePluginVersion(id).family);
    let changed = false;

    if (f.modules.some((m) => !isKnown(m.id))) {
      f.modules = f.modules.filter((m) => isKnown(m.id));
      f.groupModules = f.groupModules.filter((gm) => isKnown(gm.moduleId));
      f.userModules = f.userModules.filter((um) => isKnown(um.moduleId));
      changed = true;
    }
    for (const def of DEFAULT_MODULES) {
      if (!f.modules.some((m) => m.id === def.id)) {
        f.modules.push({ ...def });
        changed = true;
      }
    }
    return changed;
  }

  /** Données en mémoire (non null après init). */
  get data(): AuthFile {
    if (!this.file) throw new Error('AuthStore non initialisé');
    return this.file;
  }

  /** Écriture atomique : tmp + rename, permissions 600. */
  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }

  // ---------- Utilisateurs ----------

  userByUsername(username: string): User | undefined {
    return this.data.users.find((u) => u.username === username);
  }

  userById(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  listUsers(): User[] {
    return [...this.data.users];
  }

  /** Crée un utilisateur local. Lève une erreur si l'identifiant existe déjà. */
  createUser(input: { username: string; displayName: string; passwordHash: string; role: Role; groupIds: string[] }): User {
    if (this.userByUsername(input.username)) throw new Error('username-exists');
    const ts = nowIso();
    const user: User = {
      id: newId('u'),
      username: input.username,
      displayName: input.displayName,
      role: input.role,
      provider: 'local',
      passwordHash: input.passwordHash,
      mustChangePassword: true, // mdp initial → changement forcé à la 1ʳᵉ connexion
      active: true,
      createdAt: ts,
      updatedAt: ts,
    };
    this.data.users.push(user);
    this.setUserGroups(user.id, input.groupIds);
    this.persist();
    return user;
  }

  /** Met à jour un utilisateur (displayName/role/active/groupes). */
  updateUser(id: string, patch: { displayName?: string; role?: Role; active?: boolean; groupIds?: string[] }): User {
    const user = this.userById(id);
    if (!user) throw new Error('user-not-found');
    if (patch.displayName !== undefined) user.displayName = patch.displayName;
    if (patch.role !== undefined) user.role = patch.role;
    if (patch.active !== undefined) user.active = patch.active;
    if (patch.groupIds !== undefined) this.setUserGroups(id, patch.groupIds);
    user.updatedAt = nowIso();
    this.persist();
    return user;
  }

  setMustChangePassword(id: string, value: boolean): void {
    const user = this.userById(id);
    if (!user) throw new Error('user-not-found');
    user.mustChangePassword = value;
    user.updatedAt = nowIso();
    this.persist();
  }

  setPasswordHash(id: string, passwordHash: string): void {
    const user = this.userById(id);
    if (!user) throw new Error('user-not-found');
    user.passwordHash = passwordHash;
    user.updatedAt = nowIso();
    this.persist();
  }

  // ---------- Groupes ----------

  listGroups(): Group[] {
    return [...this.data.groups];
  }

  groupById(id: string): Group | undefined {
    return this.data.groups.find((g) => g.id === id);
  }

  /** Crée un groupe. Lève une erreur si le nom existe déjà. */
  createGroup(name: string, description: string): Group {
    if (this.data.groups.some((g) => g.name === name)) throw new Error('group-name-exists');
    const group: Group = { id: newId('g'), name, description };
    this.data.groups.push(group);
    this.persist();
    return group;
  }

  updateGroup(id: string, patch: { name?: string; description?: string }): Group {
    const group = this.groupById(id);
    if (!group) throw new Error('group-not-found');
    if (patch.name !== undefined) {
      if (this.data.groups.some((g) => g.id !== id && g.name === patch.name)) throw new Error('group-name-exists');
      group.name = patch.name;
    }
    if (patch.description !== undefined) group.description = patch.description;
    this.persist();
    return group;
  }

  /** Supprime un groupe + cascade des jointures (membres, modules). */
  deleteGroup(id: string): void {
    const before = this.data.groups.length;
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    if (this.data.groups.length === before) throw new Error('group-not-found');
    this.data.userGroups = this.data.userGroups.filter((ug) => ug.groupId !== id);
    this.data.groupModules = this.data.groupModules.filter((gm) => gm.groupId !== id);
    this.persist();
  }

  /** Affecte un utilisateur à des groupes (remplace ses appartenances). */
  setUserGroups(userId: string, groupIds: string[]): void {
    const valid = new Set(this.data.groups.map((g) => g.id));
    this.data.userGroups = this.data.userGroups.filter((ug) => ug.userId !== userId);
    for (const groupId of [...new Set(groupIds)]) {
      if (valid.has(groupId)) this.data.userGroups.push({ userId, groupId });
    }
  }

  /**
   * Membres d'un groupe (remplace) : ajoute/retire dans userGroups sans toucher
   * aux appartenances des autres groupes. Les userIds inconnus sont ignorés.
   */
  setGroupMembers(groupId: string, userIds: string[]): void {
    if (!this.groupById(groupId)) throw new Error('group-not-found');
    const target = new Set(userIds);
    const next: UserGroup[] = [];
    for (const ug of this.data.userGroups) {
      if (ug.groupId === groupId && !target.has(ug.userId)) continue; // retiré de ce groupe
      next.push(ug);
    }
    const existing = new Set(next.filter((ug) => ug.groupId === groupId).map((ug) => ug.userId));
    for (const userId of target) {
      if (!existing.has(userId) && this.userById(userId)) next.push({ userId, groupId });
    }
    this.data.userGroups = next;
    this.persist();
  }

  /** Modules autorisés à un groupe (remplace). */
  setGroupModules(groupId: string, moduleIds: string[]): void {
    if (!this.groupById(groupId)) throw new Error('group-not-found');
    const valid = new Set(this.data.modules.map((m) => m.id));
    this.data.groupModules = this.data.groupModules.filter((gm) => gm.groupId !== groupId);
    for (const moduleId of [...new Set(moduleIds)]) {
      if (valid.has(moduleId)) this.data.groupModules.push({ groupId, moduleId });
    }
  }

  // ---------- Modules ----------

  listModules(): ModuleDef[] {
    return [...this.data.modules];
  }

  /**
   * Synchronisation du catalogue depuis le web (ids de TOUS les plugins
   * enregistrés, toutes versions) : crée les entrées manquantes en héritant
   * nom/description/globallyEnabled de l'entrée famille. Chaque version a ainsi
   * SON propre état « pour tout le monde » (toggles indépendants dans le
   * catalogue admin). Idempotent — retourne le nombre d'entrées créées.
   */
  syncModuleCatalog(ids: string[]): number {
    let created = 0;
    for (const id of [...new Set(ids)]) {
      if (!PLUGIN_ID_RE.test(id)) continue; // ids invalides ignorées
      if (this.data.modules.some((m) => m.id === id)) continue; // déjà présente
      const family = this.data.modules.find((m) => m.id === parsePluginVersion(id).family);
      if (!family) continue; // famille inconnue → on ne crée rien
      this.data.modules.push({
        id,
        name: family.name,
        description: family.description,
        globallyEnabled: family.globallyEnabled,
      });
      created += 1;
    }
    if (created > 0) this.persist();
    return created;
  }

  setModuleGlobal(moduleId: string, enabled: boolean): void {
    const mod = this.data.modules.find((m) => m.id === moduleId);
    if (!mod) throw new Error('module-not-found');
    mod.globallyEnabled = enabled;
    this.persist();
  }

  // ---------- Préférences utilisateur (user_modules) ----------

  /**
   * Modules sélectionnés par l'utilisateur dans ses préférences (remplace).
   * Les ids peuvent viser une version précise (`<famille>_vN`) : on valide la
   * FAMILLE, l'id stocké reste celui de la version.
   */
  setUserModules(userId: string, moduleIds: string[]): void {
    if (!this.userById(userId)) throw new Error('user-not-found');
    const valid = new Set(this.data.modules.map((m) => m.id));
    this.data.userModules = this.data.userModules.filter((um) => um.userId !== userId);
    for (const moduleId of [...new Set(moduleIds)]) {
      if (valid.has(parsePluginVersion(moduleId).family)) {
        this.data.userModules.push({ userId, moduleId });
      }
    }
    this.persist();
  }
}
