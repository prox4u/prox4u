import { describe, expect, it } from 'vitest';
import { mergeBackupBundle, parseBackupBundle, type BackupBundle } from './admin-backup.js';
import type { AuthFile, User } from './auth.js';

let idCounter = 0;
const newId = (prefix: string) => `${prefix}_new${++idCounter}`;
const nowIso = () => '2026-01-01T00:00:00.000Z';
const opts = { newId, nowIso };

function user(id: string, username: string, over: Partial<User> = {}): User {
  return {
    id,
    username,
    displayName: username,
    role: 'user',
    provider: 'local',
    passwordHash: `hash-${username}`,
    mustChangePassword: false,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function authFile(over: Partial<AuthFile> = {}): AuthFile {
  return {
    version: 1,
    users: [],
    groups: [],
    modules: [{ id: 'storage', name: 'Stockage', description: '', globallyEnabled: true }],
    userGroups: [],
    userModules: [],
    groupModules: [],
    ...over,
  };
}

function bundle(auth: AuthFile, userConfigs: BackupBundle['userConfigs'] = {}): BackupBundle {
  return { version: 1, exportedAt: '2026-01-01T00:00:00.000Z', auth, userConfigs };
}

describe('mergeBackupBundle', () => {
  it('local vide + bundle → tout est créé, ids remappés', () => {
    const local = authFile();
    const b = bundle(
      authFile({
        users: [user('u_b1', 'alice'), user('u_b2', 'bob')],
        groups: [{ id: 'g_b1', name: 'Ops', description: 'ops' }],
        userGroups: [{ userId: 'u_b1', groupId: 'g_b1' }],
      }),
    );
    const res = mergeBackupBundle(local, b, opts);
    expect(res.stats).toMatchObject({ usersCreated: 2, usersUpdated: 0, groupsCreated: 1, groupsUpdated: 0 });
    // ids locaux neufs, userMap/groupMap remappés
    expect(res.nextAuth.users).toHaveLength(2);
    expect(res.nextAuth.users.every((u) => u.id.startsWith('u_new'))).toBe(true);
    expect(res.userMap['u_b1']).toBe(res.nextAuth.users.find((u) => u.username === 'alice')!.id);
    expect(res.groupMap['g_b1']).toBe(res.nextAuth.groups[0].id);
    // jointure remappée
    expect(res.nextAuth.userGroups).toHaveLength(1);
    expect(res.nextAuth.userGroups[0].userId).toBe(res.userMap['u_b1']);
    expect(res.nextAuth.userGroups[0].groupId).toBe(res.groupMap['g_b1']);
  });

  it('user existant (même username, id différent) → mis à jour, id local conservé', () => {
    const local = authFile({ users: [user('u_local', 'alice', { role: 'user', displayName: 'Ancien' })] });
    const b = bundle(authFile({ users: [user('u_bundle', 'alice', { role: 'admin', displayName: 'Nouveau', mustChangePassword: true })] }));
    const res = mergeBackupBundle(local, b, opts);
    expect(res.stats).toMatchObject({ usersCreated: 0, usersUpdated: 1 });
    const alice = res.nextAuth.users.find((u) => u.username === 'alice')!;
    expect(alice.id).toBe('u_local'); // id local conservé
    expect(alice.role).toBe('admin'); // mis à jour
    expect(alice.displayName).toBe('Nouveau');
    expect(alice.mustChangePassword).toBe(true);
    expect(res.userMap['u_bundle']).toBe('u_local');
  });

  it('users/groupes locaux absents du bundle → conservés', () => {
    const local = authFile({
      users: [user('u_local', 'carol')],
      groups: [{ id: 'g_local', name: 'Local', description: '' }],
    });
    const b = bundle(authFile({ users: [user('u_b1', 'alice')] }));
    const res = mergeBackupBundle(local, b, opts);
    const usernames = res.nextAuth.users.map((u) => u.username).sort();
    expect(usernames).toEqual(['alice', 'carol']);
    expect(res.nextAuth.groups.map((g) => g.name)).toEqual(['Local']);
  });

  it('groupe existant (même nom) → description mise à jour, id local conservé', () => {
    const local = authFile({ groups: [{ id: 'g_local', name: 'Ops', description: 'ancien' }] });
    const b = bundle(authFile({ groups: [{ id: 'g_bundle', name: 'Ops', description: 'nouveau' }] }));
    const res = mergeBackupBundle(local, b, opts);
    expect(res.stats).toMatchObject({ groupsCreated: 0, groupsUpdated: 1 });
    expect(res.nextAuth.groups[0].id).toBe('g_local');
    expect(res.nextAuth.groups[0].description).toBe('nouveau');
    expect(res.groupMap['g_bundle']).toBe('g_local');
  });

  it('modules : globallyEnabled du bundle appliqué aux modules locaux', () => {
    const local = authFile({ modules: [{ id: 'storage', name: 'S', description: '', globallyEnabled: true }] });
    const b = bundle(authFile({ modules: [{ id: 'storage', name: 'S', description: '', globallyEnabled: false }] }));
    const res = mergeBackupBundle(local, b, opts);
    expect(res.nextAuth.modules.find((m) => m.id === 'storage')!.globallyEnabled).toBe(false);
  });

  it('jointures : union bundle ∪ local (rien n’est perdu), dédupliquée', () => {
    const local = authFile({
      users: [user('u_l1', 'alice'), user('u_l2', 'dave')],
      groups: [{ id: 'g_l1', name: 'Ops', description: '' }],
      userGroups: [{ userId: 'u_l2', groupId: 'g_l1' }], // dave dans Ops (local)
    });
    const b = bundle(
      authFile({
        users: [user('u_b1', 'alice')],
        groups: [{ id: 'g_b1', name: 'Ops', description: '' }],
        userGroups: [{ userId: 'u_b1', groupId: 'g_b1' }], // alice dans Ops (bundle)
      }),
    );
    const res = mergeBackupBundle(local, b, opts);
    // alice (remappée) + dave (local) tous deux dans Ops (id local g_l1)
    const opsId = res.nextAuth.groups[0].id;
    const aliceId = res.userMap['u_b1'];
    expect(res.nextAuth.userGroups).toContainEqual({ userId: aliceId, groupId: opsId });
    expect(res.nextAuth.userGroups).toContainEqual({ userId: 'u_l2', groupId: opsId });
    expect(res.nextAuth.userGroups).toHaveLength(2);
  });

  it('références vers des ids inconnus dans le bundle → ignorées', () => {
    const local = authFile({ users: [user('u_l1', 'alice')] });
    const b = bundle(
      authFile({
        users: [user('u_b1', 'alice')],
        // userGroup vers un groupe absent du bundle ET de local
        userGroups: [{ userId: 'u_b1', groupId: 'g_inconnu' }],
        // userModule vers un module absent de local
        userModules: [{ userId: 'u_b1', moduleId: 'module-inconnu' }],
      }),
    );
    const res = mergeBackupBundle(local, b, opts);
    expect(res.nextAuth.userGroups).toHaveLength(0);
    expect(res.nextAuth.userModules).toHaveLength(0);
  });

  it('ne mute pas le local d’origine', () => {
    const local = authFile({ users: [user('u_l1', 'alice', { role: 'user' })] });
    const snapshot = JSON.stringify(local);
    const b = bundle(authFile({ users: [user('u_b1', 'alice', { role: 'admin' })] }));
    mergeBackupBundle(local, b, opts);
    expect(JSON.stringify(local)).toBe(snapshot);
  });

  it('userModules/groupModules remappés + dédupliqués', () => {
    const local = authFile({
      users: [user('u_l1', 'alice')],
      groups: [{ id: 'g_l1', name: 'Ops', description: '' }],
      modules: [{ id: 'storage', name: 'S', description: '', globallyEnabled: true }],
      userModules: [{ userId: 'u_l1', moduleId: 'storage' }],
      groupModules: [{ groupId: 'g_l1', moduleId: 'storage' }],
    });
    const b = bundle(
      authFile({
        users: [user('u_b1', 'alice')],
        groups: [{ id: 'g_b1', name: 'Ops', description: '' }],
        modules: [{ id: 'storage', name: 'S', description: '', globallyEnabled: true }],
        userModules: [{ userId: 'u_b1', moduleId: 'storage' }],
        groupModules: [{ groupId: 'g_b1', moduleId: 'storage' }],
      }),
    );
    const res = mergeBackupBundle(local, b, opts);
    // même contenu local + bundle → dédupliqué (1 entrée chacun, pas 2)
    expect(res.nextAuth.userModules).toHaveLength(1);
    expect(res.nextAuth.userModules[0]).toEqual({ userId: 'u_l1', moduleId: 'storage' });
    expect(res.nextAuth.groupModules).toHaveLength(1);
    expect(res.nextAuth.groupModules[0]).toEqual({ groupId: 'g_l1', moduleId: 'storage' });
  });
});

describe('parseBackupBundle', () => {
  it('valide un bundle bien formé', () => {
    const raw = {
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      auth: {
        version: 1,
        users: [{ id: 'u_1', username: 'alice', displayName: 'Alice', role: 'user', provider: 'local', passwordHash: 'h', mustChangePassword: false, active: true, createdAt: '', updatedAt: '' }],
        groups: [{ id: 'g_1', name: 'Ops', description: '' }],
        modules: [{ id: 'storage', name: 'S', description: '', globallyEnabled: true }],
        userGroups: [{ userId: 'u_1', groupId: 'g_1' }],
        userModules: [],
        groupModules: [],
      },
      userConfigs: { u_1: null },
    };
    const b = parseBackupBundle(raw);
    expect(b).not.toBeNull();
    expect(b!.auth.users).toHaveLength(1);
    expect(b!.auth.users[0].username).toBe('alice');
    expect(b!.userConfigs).toEqual({ u_1: null });
  });

  it('rejette version absente ou ≠ 1', () => {
    expect(parseBackupBundle({ version: 2, auth: {} })).toBeNull();
    expect(parseBackupBundle({ auth: {} })).toBeNull();
  });

  it('rejette auth absent ou tables manquantes', () => {
    expect(parseBackupBundle({ version: 1 })).toBeNull();
    expect(parseBackupBundle({ version: 1, auth: { users: [] } })).toBeNull();
  });

  it('filtre les entrées mal formées (users sans username, etc.)', () => {
    const raw = {
      version: 1,
      auth: {
        users: [{ id: 'u_1' }, { id: 'u_2', username: 'bob' }],
        groups: [{ id: 'g_1' }, { id: 'g_2', name: 'Ops' }],
        modules: [{ id: 'storage', globallyEnabled: true }, { name: 'sans id' }],
        userGroups: [{ userId: 'u_2' }, { userId: 'u_2', groupId: 'g_2' }],
        userModules: [],
        groupModules: [],
      },
    };
    const b = parseBackupBundle(raw);
    expect(b).not.toBeNull();
    expect(b!.auth.users).toHaveLength(1); // seul bob (u_1 sans username filtré)
    expect(b!.auth.groups).toHaveLength(1); // seul Ops
    expect(b!.auth.modules).toHaveLength(1); // seul storage
    expect(b!.auth.userGroups).toHaveLength(1); // seul celui avec userId+groupId
    expect(b!.userConfigs).toEqual({}); // absent → {}
  });

  it('normalise les champs par défaut (role, active, provider…)', () => {
    const raw = {
      version: 1,
      auth: {
        users: [{ id: 'u_1', username: 'carol' }],
        groups: [],
        modules: [],
        userGroups: [],
        userModules: [],
        groupModules: [],
      },
    };
    const b = parseBackupBundle(raw);
    expect(b!.auth.users[0]).toMatchObject({ role: 'user', provider: 'local', active: true, mustChangePassword: false, passwordHash: null });
  });
});
