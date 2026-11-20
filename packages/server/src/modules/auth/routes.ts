import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  authorizedModuleEntries,
  authorizedModuleIds,
  computeVisibleModuleIds,
  computeVisibleVersionIds,
  isAuthorizedModuleSelection,
  mergeBackupBundle,
  pageAuditEntries,
  parseBackupBundle,
  toPublicUser,
  type AuthPayload,
  type BackupBundle,
  type Group,
  type Role,
  type User,
} from '@prox4u/shared';
import type { AppContext } from '../../core/poller.js';
import { checkPasswordPolicy, generateTemporaryPassword, hashPassword, verifyPassword } from './password.js';
import { parseCookies, sessionCookieOptions, SESSION_COOKIE } from './session.js';

/**
 * Routes d'authentification et d'administration.
 * - /api/auth/login : public (les autres routes sont protégées par le guard global).
 * - /api/auth/* : session valide.
 * - /api/admin/* : rôle admin (vérifié par le guard).
 */

function authPayload(ctx: AppContext, user: User): AuthPayload {
  const f = ctx.auth.store.data;
  // Lignes de « Mon profil → Modules » : entrées autorisées au niveau VERSION
  // (activées globalement OU famille attribuée à un groupe de l'utilisateur).
  return {
    user: toPublicUser(user, f),
    authorizedModules: authorizedModuleEntries(user.id, f),
    visibleModuleIds: [...computeVisibleModuleIds(user.id, f)],
    visibleVersionIds: [...computeVisibleVersionIds(user.id, f)],
  };
}

/** Anti-brute-force : 5 échecs par identifiant sur 15 min → 429. */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

class LoginThrottle {
  private attempts = new Map<string, { count: number; windowStart: number }>();

  isLocked(username: string): boolean {
    const a = this.attempts.get(username);
    if (!a) return false;
    if (Date.now() - a.windowStart > ATTEMPT_WINDOW_MS) {
      this.attempts.delete(username);
      return false;
    }
    return a.count >= MAX_ATTEMPTS;
  }

  recordFailure(username: string): void {
    const now = Date.now();
    const a = this.attempts.get(username);
    if (!a || now - a.windowStart > ATTEMPT_WINDOW_MS) {
      this.attempts.set(username, { count: 1, windowStart: now });
    } else {
      a.count += 1;
    }
  }

  reset(username: string): void {
    this.attempts.delete(username);
  }
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

/** Traduit les erreurs connues du store en codes HTTP (true = réponse déjà envoyée). */
function storeError(reply: FastifyReply, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'username-exists' || msg === 'group-name-exists') {
    reply.code(409).send({ error: 'conflict', code: msg });
    return true;
  }
  if (msg === 'user-not-found' || msg === 'group-not-found' || msg === 'module-not-found') {
    reply.code(404).send({ error: 'not found', code: msg });
    return true;
  }
  if (msg === 'bad-version-id') {
    reply.code(400).send({ error: 'bad request', code: msg });
    return true;
  }
  return false;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, secureCookies: boolean): void {
  const auth = ctx.auth;
  const throttle = new LoginThrottle();
  const maxAgeSec = Math.round(auth.sessions.ttlMs / 1000);

  /**
   * Trace une action admin dans le journal d'audit (acteur = user de la
   * session). Ne lève pas d'exception (un journal indisponible ne doit pas
   * faire échouer l'action). Jamais de mot de passe dans `details`.
   */
  function audit(req: FastifyRequest, action: string, target?: string, details?: Record<string, unknown>): void {
    const actorId = req.authUser?.id;
    if (!actorId) return;
    const username = auth.store.userById(actorId)?.username ?? actorId;
    auth.audit.append({ id: actorId, username }, action, target, details);
  }

  // ---------- Public ----------

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return reply.code(400).send({ error: 'bad request', code: 'missing-fields' });

    if (throttle.isLocked(username)) {
      return reply.code(429).send({ error: 'too many requests', code: 'rate-limited' });
    }
    const result = await auth.provider.authenticate(username, password);
    if (!result.ok) {
      throttle.recordFailure(username);
      const status = result.failure === 'disabled' ? 403 : 401;
      return reply.code(status).send({ error: 'unauthorized', code: result.failure });
    }
    throttle.reset(username);
    const token = auth.sessions.create(result.user.id);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(secureCookies, maxAgeSec));
    return authPayload(ctx, result.user);
  });

  // ---------- Session ----------

  app.post('/api/auth/logout', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) auth.sessions.destroy(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = auth.store.userById(req.authUser!.id);
    if (!user) throw new Error('user-not-found'); // guard : ne devrait pas arriver
    return authPayload(ctx, user);
  });

  /**
   * Synchronisation du catalogue des modules : le web envoie les ids de tous
   * ses plugins enregistrés (toutes versions) ; le serveur crée les entrées
   * manquantes (état hérité de la famille) pour que chaque version ait son
   * propre toggle « pour tout le monde ». Idempotent, sans session = 401.
   */
  app.put('/api/auth/catalog-sync', async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'bad request', code: 'bad-ids' });
    }
    const created = auth.store.syncModuleCatalog(body.ids as string[]);
    if (created > 0) audit(req, 'catalog.sync', undefined, { created });
    return { ok: true, created };
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const user = auth.store.userById(req.authUser!.id);
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'no-session' });
    if (user.provider !== 'local') {
      // comptes AD (futurs) : le mot de passe est géré par l'annuaire
      return reply.code(400).send({ error: 'bad request', code: 'not-supported' });
    }
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      return reply.code(401).send({ error: 'unauthorized', code: 'wrong-current' });
    }
    const issue = checkPasswordPolicy(newPassword);
    if (issue) return reply.code(400).send({ error: 'bad request', code: `weak-${issue}` });

    user.passwordHash = await hashPassword(newPassword);
    auth.store.setMustChangePassword(user.id, false);
    // Révocation des AUTRES sessions de l'utilisateur (sa session courante est
    // conservée via exceptToken) — un mdp changé invalide les connexions antérieures.
    auth.sessions.destroyAllForUser(user.id, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    return { ok: true };
  });

  /** Préférences de modules (user_modules) : uniquement parmi les modules autorisés. */
  app.put('/api/auth/preferences', async (req, reply) => {
    const user = auth.store.userById(req.authUser!.id);
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'no-session' });
    const body = (req.body ?? {}) as { moduleIds?: unknown };
    if (!Array.isArray(body.moduleIds) || body.moduleIds.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'bad request', code: 'bad-module-ids' });
    }
    // Validation par FAMILLE : l'id peut être la famille (v1) ou une version
    // dérivée (<famille>_vN) — les deux sont des préférences légitimes.
    const authorized = authorizedModuleIds(user.id, auth.store.data);
    const invalid = (body.moduleIds as string[]).filter((id) => !isAuthorizedModuleSelection(id, authorized));
    if (invalid.length > 0) {
      return reply.code(400).send({ error: 'bad request', code: 'not-authorized', moduleIds: invalid });
    }
    auth.store.setUserModules(user.id, body.moduleIds as string[]);
    return authPayload(ctx, user);
  });

  // ---------- Administration (rôle admin, vérifié par le guard) ----------

  app.get('/api/admin/state', async () => {
    const f = auth.store.data;
    const groups: Array<Group & { memberIds: string[]; moduleIds: string[] }> = f.groups.map((g) => ({
      ...g,
      memberIds: f.userGroups.filter((ug) => ug.groupId === g.id).map((ug) => ug.userId),
      moduleIds: f.groupModules.filter((gm) => gm.groupId === g.id).map((gm) => gm.moduleId),
    }));
    return {
      users: f.users.map((u) => toPublicUser(u, f)),
      groups,
      modules: f.modules,
    };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const body = (req.body ?? {}) as {
      username?: string; displayName?: string; password?: string; role?: Role; groupIds?: string[];
      moduleIds?: string[];
    };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username)) return reply.code(400).send({ error: 'bad request', code: 'invalid-username' });
    if (!displayName) return reply.code(400).send({ error: 'bad request', code: 'missing-display-name' });
    const issue = checkPasswordPolicy(password);
    if (issue) return reply.code(400).send({ error: 'bad request', code: `weak-${issue}` });
    const role: Role = body.role === 'admin' ? 'admin' : 'user';
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds.filter((id) => typeof id === 'string') : [];
    try {
      const user = auth.store.createUser({
        username,
        displayName,
        passwordHash: await hashPassword(password),
        role,
        groupIds,
        // Absent → le store pré-sélectionne tous les modules activés globalement
        // (pas de menu vide au 1er login).
        moduleIds: Array.isArray(body.moduleIds) ? body.moduleIds.filter((id) => typeof id === 'string') : undefined,
      });
      audit(req, 'user.create', user.username, { role, groupIds });
      return reply.code(201).send(authPayload(ctx, user));
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { displayName?: string; role?: Role; active?: boolean; groupIds?: string[] };
    // Anti-verrouillage : un admin ne peut pas se désactiver ni se dégrader lui-même.
    if (id === req.authUser!.id && (body.active === false || body.role === 'user')) {
      return reply.code(400).send({ error: 'bad request', code: 'self-modification' });
    }
    const patch = {
      displayName: typeof body.displayName === 'string' ? body.displayName.trim() : undefined,
      role: body.role === 'admin' || body.role === 'user' ? body.role : undefined,
      active: typeof body.active === 'boolean' ? body.active : undefined,
      groupIds: Array.isArray(body.groupIds) ? body.groupIds.filter((gid) => typeof gid === 'string') : undefined,
    };
    try {
      const user = auth.store.updateUser(id, patch);
      // Champs effectivement transmis (jamais le mot de passe ici).
      const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
      audit(req, 'user.update', user.username, { changed });
      return authPayload(ctx, user);
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = auth.store.userById(id);
    if (!user) return reply.code(404).send({ error: 'not found', code: 'user-not-found' });
    if (user.provider !== 'local') {
      return reply.code(400).send({ error: 'bad request', code: 'not-supported' });
    }
    const body = (req.body ?? {}) as { newPassword?: string };
    let temporaryPassword: string;
    if (typeof body.newPassword === 'string' && body.newPassword.length > 0) {
      const issue = checkPasswordPolicy(body.newPassword);
      if (issue) return reply.code(400).send({ error: 'bad request', code: `weak-${issue}` });
      temporaryPassword = body.newPassword;
    } else {
      temporaryPassword = generateTemporaryPassword();
    }
    auth.store.setPasswordHash(id, await hashPassword(temporaryPassword));
    auth.store.setMustChangePassword(id, true); // changement forcé à la prochaine connexion
    // Un reset admin invalide toutes les sessions de l'utilisateur cible.
    auth.sessions.destroyAllForUser(id);
    audit(req, 'user.reset-password', user.username, { provided: typeof body.newPassword === 'string' && body.newPassword.length > 0 });
    return { temporaryPassword };
  });

  app.post('/api/admin/groups', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; description?: string };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'bad request', code: 'missing-name' });
    try {
      const group = auth.store.createGroup(name, typeof body.description === 'string' ? body.description : '');
      audit(req, 'group.create', group.name);
      return reply.code(201).send(group);
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.patch('/api/admin/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string; description?: string };
    const patch = {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
    };
    try {
      const group = auth.store.updateGroup(id, patch);
      const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
      audit(req, 'group.update', group.name, { changed });
      return group;
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  /**
   * Sauvegarde ATOMIQUE d'un groupe : nom + description + membres + modules en
   * UNE seule écriture (le web « Enregistrer le groupe » n'appelle plus 3
   * endpoints séquentiels — plus d'état partiel si un appel échoue).
   */
  app.put('/api/admin/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      name?: string; description?: string; memberIds?: unknown; moduleIds?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (name !== undefined && !name) {
      return reply.code(400).send({ error: 'bad request', code: 'missing-name' });
    }
    const patch = {
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      memberIds: Array.isArray(body.memberIds) ? body.memberIds.filter((u): u is string => typeof u === 'string') : undefined,
      moduleIds: Array.isArray(body.moduleIds) ? body.moduleIds.filter((m): m is string => typeof m === 'string') : undefined,
    };
    try {
      const group = auth.store.saveGroup(id, patch);
      const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
      audit(req, 'group.update', group.name, { changed, atomic: true });
      return group;
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.delete('/api/admin/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const groupName = auth.store.groupById(id)?.name;
    try {
      auth.store.deleteGroup(id);
      audit(req, 'group.delete', groupName ?? id);
      return { ok: true };
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.put('/api/admin/groups/:id/members', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { userIds?: unknown };
    if (!Array.isArray(body.userIds)) return reply.code(400).send({ error: 'bad request', code: 'bad-user-ids' });
    const group = auth.store.groupById(id);
    if (!group) return reply.code(404).send({ error: 'not found', code: 'group-not-found' });
    const before = auth.store.data.userGroups.filter((ug) => ug.groupId === id).map((ug) => ug.userId);
    const knownUsers = new Set(auth.store.listUsers().map((u) => u.id));
    const after = body.userIds.filter((u): u is string => typeof u === 'string').filter((u) => knownUsers.has(u));
    try {
      auth.store.setGroupMembers(id, after);
      audit(req, 'group.members', group.name, {
        added: after.filter((u) => !before.includes(u)),
        removed: before.filter((u) => !after.includes(u)),
      });
      return { ok: true };
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.put('/api/admin/groups/:id/modules', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { moduleIds?: unknown };
    if (!Array.isArray(body.moduleIds)) return reply.code(400).send({ error: 'bad request', code: 'bad-module-ids' });
    const group = auth.store.groupById(id);
    if (!group) return reply.code(404).send({ error: 'not found', code: 'group-not-found' });
    const before = auth.store.data.groupModules.filter((gm) => gm.groupId === id).map((gm) => gm.moduleId);
    const knownModules = new Set(auth.store.listModules().map((m) => m.id));
    const after = body.moduleIds.filter((m): m is string => typeof m === 'string').filter((m) => knownModules.has(m));
    try {
      auth.store.setGroupModules(id, after);
      audit(req, 'group.modules', group.name, {
        added: after.filter((m) => !before.includes(m)),
        removed: before.filter((m) => !after.includes(m)),
      });
      return { ok: true };
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.patch('/api/admin/modules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { globallyEnabled?: boolean };
    if (typeof body.globallyEnabled !== 'boolean') {
      return reply.code(400).send({ error: 'bad request', code: 'bad-globally-enabled' });
    }
    try {
      auth.store.setModuleGlobal(id, body.globallyEnabled);
      audit(req, 'module.toggle', id, { globallyEnabled: body.globallyEnabled });
      return { ok: true };
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  /**
   * Journal d'audit des actions admin (lecture) : paginé depuis la plus
   * récente, filtres action/acteur. Rôle admin (guard).
   */
  app.get('/api/admin/audit', async (req) => {
    const q = req.query as { limit?: string; offset?: string; action?: string; actor?: string };
    const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;
    const offset = q.offset !== undefined ? Number.parseInt(q.offset, 10) : undefined;
    return pageAuditEntries(auth.audit.readAll(), {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      action: typeof q.action === 'string' && q.action ? q.action : undefined,
      actor: typeof q.actor === 'string' && q.actor ? q.actor : undefined,
    });
  });

  // ---------- Sauvegarde : export / import (users + groupes + graphiques) ----------

  /**
   * Export : bundle JSON = état de data/auth.json (users, groupes, modules,
   * jointures — dont les hashes argon2id) + configs de graphiques par user
   * (data/user-configs). Rôle admin (contient les hashes).
   */
  app.get('/api/admin/export', async (req) => {
    const f = auth.store.data;
    const userConfigs: BackupBundle['userConfigs'] = {};
    for (const u of auth.store.listUsers()) {
      userConfigs[u.id] = ctx.userConfig.load(u.id);
    }
    const bundle: BackupBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      auth: f,
      userConfigs,
    };
    audit(req, 'backup.export', undefined, {
      users: f.users.length,
      groups: f.groups.length,
      userConfigs: Object.values(userConfigs).filter((c) => c !== null).length,
    });
    return bundle;
  });

  /**
   * Import : fusion par username/nom (les comptes/groupes locaux absents du
   * bundle sont conservés) + réécriture des configs de graphiques remappées.
   * Le bundle est validé (parseBackupBundle) puis fusionné (mergeBackupBundle,
   * fonction pure testée).
   */
  app.post('/api/admin/import', async (req, reply) => {
    const bundle = parseBackupBundle(req.body);
    if (!bundle) return reply.code(400).send({ error: 'bad request', code: 'bad-bundle' });
    const result = mergeBackupBundle(auth.store.data, bundle, {
      newId: (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`,
      nowIso: () => new Date().toISOString(),
    });
    auth.store.replaceState(result.nextAuth);
    // Configs de graphiques : remappées par username → id local, réécrites.
    let userConfigsRestored = 0;
    for (const [bundleUserId, config] of Object.entries(bundle.userConfigs)) {
      if (!config) continue; // null = jamais personnalisé → on ne touche pas au local
      const localUserId = result.userMap[bundleUserId];
      if (localUserId) {
        ctx.userConfig.save(localUserId, config);
        userConfigsRestored += 1;
      }
    }
    audit(req, 'backup.import', undefined, { ...result.stats, userConfigsRestored });
    return { ok: true, ...result.stats, userConfigsRestored };
  });

}
