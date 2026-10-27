import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  authorizedModuleEntries,
  authorizedModuleIds,
  computeVisibleModuleIds,
  computeVisibleVersionIds,
  isAuthorizedModuleSelection,
  toPublicUser,
  type AuthPayload,
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
    };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username)) return reply.code(400).send({ error: 'bad request', code: 'invalid-username' });
    if (!displayName) return reply.code(400).send({ error: 'bad request', code: 'missing-display-name' });
    const issue = checkPasswordPolicy(password);
    if (issue) return reply.code(400).send({ error: 'bad request', code: `weak-${issue}` });
    try {
      const user = auth.store.createUser({
        username,
        displayName,
        passwordHash: await hashPassword(password),
        role: body.role === 'admin' ? 'admin' : 'user',
        groupIds: Array.isArray(body.groupIds) ? body.groupIds.filter((id) => typeof id === 'string') : [],
      });
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
    try {
      const user = auth.store.updateUser(id, {
        displayName: typeof body.displayName === 'string' ? body.displayName.trim() : undefined,
        role: body.role === 'admin' || body.role === 'user' ? body.role : undefined,
        active: typeof body.active === 'boolean' ? body.active : undefined,
        groupIds: Array.isArray(body.groupIds) ? body.groupIds.filter((gid) => typeof gid === 'string') : undefined,
      });
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
    return { temporaryPassword };
  });

  app.post('/api/admin/groups', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; description?: string };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'bad request', code: 'missing-name' });
    try {
      const group = auth.store.createGroup(name, typeof body.description === 'string' ? body.description : '');
      return reply.code(201).send(group);
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.patch('/api/admin/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string; description?: string };
    try {
      return auth.store.updateGroup(id, {
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
      });
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

  app.delete('/api/admin/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      auth.store.deleteGroup(id);
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
    try {
      auth.store.setGroupMembers(id, body.userIds.filter((u): u is string => typeof u === 'string'));
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
    try {
      auth.store.setGroupModules(id, body.moduleIds.filter((m): m is string => typeof m === 'string'));
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
      return { ok: true };
    } catch (err) {
      if (storeError(reply, err)) return;
      throw err;
    }
  });

}
