import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from './password.js';
import { AuthStore, seedAuthFile } from './store.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('AuthStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'auth-store-'));
    file = path.join(dir, 'auth.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function freshStore(): Promise<AuthStore> {
    const store = new AuthStore(file, logger);
    await store.init(hashPassword);
    return store;
  }

  it('seed : admin/proX4u avec changement forcé + catalogue vide', async () => {
    const store = await freshStore();
    const admin = store.userByUsername('admin');
    expect(admin).toBeDefined();
    expect(admin!.role).toBe('admin');
    expect(admin!.mustChangePassword).toBe(true);
    expect(admin!.active).toBe(true);
    expect(admin!.passwordHash).toBeTruthy();
    // le mot de passe initial est bien proX4u
    const { verifyPassword } = await import('./password.js');
    expect(await verifyPassword(admin!.passwordHash!, 'proX4u')).toBe(true);
    // catalogue des familles de plugins, activé globalement par défaut
    expect(store.listModules().map((m) => m.id)).toEqual(['hypervision', 'network', 'storage', 'vm-view', 'proxmox-inventory', 'centreon-nsca']);
    expect(store.listModules().every((m) => m.globallyEnabled)).toBe(true);
  });

  it('persiste de façon lisible et rechargeable (idempotent au 2e init)', async () => {
    const store = await freshStore();
    store.createGroup('Exploitation', 'équipe exploitation');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.groups).toHaveLength(1);
    // 2e chargement : mêmes données
    const store2 = new AuthStore(file, logger);
    await store2.init(hashPassword);
    expect(store2.listGroups().map((g) => g.name)).toEqual(['Exploitation']);
    expect(store2.userByUsername('admin')).toBeDefined();
  });

  it('migration : catalogue de l’ancienne app (dashboard/networks) réconcilié au chargement', async () => {
    await freshStore();
    // Simule un fichier issu de l'ancienne app (ids « dashboard »/« networks » + supervision retiré)
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.modules = [
      { id: 'dashboard', name: 'Dashboard', description: '', globallyEnabled: true },
      { id: 'supervision', name: 'Supervision', description: '', globallyEnabled: false },
    ];
    raw.groupModules.push({ groupId: 'g1', moduleId: 'supervision' });
    raw.userModules.push({ userId: 'u1', moduleId: 'dashboard' });
    writeFileSync(file, JSON.stringify(raw));

    const store = new AuthStore(file, logger);
    await store.init(hashPassword);
    // les ids inconnus sont retirés, le catalogue Prox4u est restauré
    expect(store.listModules().map((m) => m.id)).toEqual(['hypervision', 'network', 'storage', 'vm-view', 'proxmox-inventory', 'centreon-nsca']);
    // les références aux modules retirés sont nettoyées
    expect(store.data.groupModules.some((gm) => gm.moduleId === 'supervision')).toBe(false);
    expect(store.data.userModules.some((um) => um.moduleId === 'dashboard')).toBe(false);
  });

  it('crée un utilisateur (mdp forcé) et refuse les identifiants en double', async () => {
    const store = await freshStore();
    const u = store.createUser({
      username: 'alice',
      displayName: 'Alice',
      passwordHash: await hashPassword('alice1234'),
      role: 'user',
      groupIds: [],
    });
    expect(u.mustChangePassword).toBe(true);
    expect(() =>
      store.createUser({ username: 'alice', displayName: 'x', passwordHash: 'h', role: 'user', groupIds: [] }),
    ).toThrow('username-exists');
  });

  it('met à jour un utilisateur (groupe, activation)', async () => {
    const store = await freshStore();
    const g = store.createGroup('Ops', '');
    const u = store.createUser({ username: 'bob', displayName: 'Bob', passwordHash: 'h', role: 'user', groupIds: [] });
    store.updateUser(u.id, { groupIds: [g.id], active: false });
    expect(store.userById(u.id)!.active).toBe(false);
    expect(store.data.userGroups).toEqual([{ userId: u.id, groupId: g.id }]);
  });

  it('refuse les noms de groupe en double et cascade la suppression', async () => {
    const store = await freshStore();
    const g1 = store.createGroup('Ops', '');
    expect(() => store.createGroup('Ops', 'autre')).toThrow('group-name-exists');
    const u = store.createUser({ username: 'carol', displayName: 'Carol', passwordHash: 'h', role: 'user', groupIds: [g1.id] });
    store.setGroupModules(g1.id, ['hypervision']);
    expect(store.data.userGroups).toHaveLength(1);
    expect(store.data.groupModules).toHaveLength(1);

    store.deleteGroup(g1.id);
    expect(store.listGroups()).toHaveLength(0);
    expect(store.data.userGroups).toHaveLength(0);
    expect(store.data.groupModules).toHaveLength(0);
    // l'utilisateur reste intact
    expect(store.userById(u.id)).toBeDefined();
  });

  it('setGroupMembers : ajoute/retire sans toucher aux autres groupes', async () => {
    const store = await freshStore();
    const g1 = store.createGroup('G1', '');
    const g2 = store.createGroup('G2', '');
    const u1 = store.createUser({ username: 'u1', displayName: 'U1', passwordHash: 'h', role: 'user', groupIds: [g1.id, g2.id] });
    const u2 = store.createUser({ username: 'u2', displayName: 'U2', passwordHash: 'h', role: 'user', groupIds: [g1.id] });

    // G1 ne garde que u2 → u1 perd G1 mais conserve G2
    store.setGroupMembers(g1.id, [u2.id]);
    const groupsOf = (userId: string) =>
      store.data.userGroups.filter((ug) => ug.userId === userId).map((ug) => ug.groupId).sort();
    expect(groupsOf(u1.id)).toEqual([g2.id]);
    expect(groupsOf(u2.id)).toEqual([g1.id]);

    // ré-ajout de u1 à G1
    store.setGroupMembers(g1.id, [u1.id, u2.id]);
    expect(groupsOf(u1.id).sort()).toEqual([g1.id, g2.id].sort());
  });

  it('setUserModules : préférences remplacées, ids inconnus ignorés', async () => {
    const store = await freshStore();
    const u = store.createUser({ username: 'dave', displayName: 'Dave', passwordHash: 'h', role: 'user', groupIds: [] });
    store.setUserModules(u.id, ['hypervision', 'inexistant']);
    expect(store.data.userModules).toEqual([{ userId: u.id, moduleId: 'hypervision' }]);
    store.setUserModules(u.id, ['network']);
    expect(store.data.userModules).toEqual([{ userId: u.id, moduleId: 'network' }]);
  });

  it('setUserModules : les ids de version (<famille>_vN) sont conservés', async () => {
    const store = await freshStore();
    const u = store.createUser({ username: 'dave', displayName: 'Dave', passwordHash: 'h', role: 'user', groupIds: [] });
    store.setUserModules(u.id, ['vm-view', 'vm-view_v2', 'inexistant_v3']);
    expect(store.data.userModules).toEqual([
      { userId: u.id, moduleId: 'vm-view' },
      { userId: u.id, moduleId: 'vm-view_v2' },
    ]);
  });

  it('setModuleGlobal : bascule l’activation globale', async () => {
    const store = await freshStore();
    store.setModuleGlobal('hypervision', false);
    expect(store.listModules().find((m) => m.id === 'hypervision')!.globallyEnabled).toBe(false);
    expect(() => store.setModuleGlobal('inexistant', true)).toThrow('module-not-found');
  });

  it('syncModuleCatalog : crée les entrées manquantes en héritant de la famille', async () => {
    const store = await freshStore();
    // v1 OFF, v2 ON avant sync → l'entrée v2 créée hérite de l'état famille (OFF)
    store.setModuleGlobal('vm-view', false);
    expect(store.syncModuleCatalog(['vm-view', 'vm-view_v2', 'vm-view_v3'])).toBe(2);
    const entries = store.listModules().filter((m) => m.id.startsWith('vm-view'));
    expect(entries.map((m) => m.id)).toEqual(['vm-view', 'vm-view_v2', 'vm-view_v3']);
    for (const m of entries) {
      expect(m.globallyEnabled).toBe(false);
      expect(m.name).toBe('Vue VM');
    }
  });

  it('syncModuleCatalog : idempotent, tolère les ids invalides et familles inconnues', async () => {
    const store = await freshStore();
    expect(store.syncModuleCatalog(['vm-view_v2'])).toBe(1);
    // 2e appel : rien à créer ; ids invalides / famille inconnue ignorés
    expect(store.syncModuleCatalog(['vm-view_v2', 'invalide!', 'unknown-module_v2', 'vm-view_v2'])).toBe(0);
    expect(store.listModules().map((m) => m.id).sort()).toEqual([
      'centreon-nsca',
      'hypervision',
      'network',
      'proxmox-inventory',
      'storage',
      'vm-view',
      'vm-view_v2',
    ]);
  });

  it('syncModuleCatalog : les états par version sont indépendants après sync', async () => {
    const store = await freshStore();
    expect(store.syncModuleCatalog(['vm-view_v2'])).toBe(1);
    // v1 OFF ne doit PAS toucher v2 (et réciproque)
    store.setModuleGlobal('vm-view', false);
    expect(store.listModules().find((m) => m.id === 'vm-view')!.globallyEnabled).toBe(false);
    expect(store.listModules().find((m) => m.id === 'vm-view_v2')!.globallyEnabled).toBe(true);
    store.setModuleGlobal('vm-view_v2', false);
    expect(store.listModules().find((m) => m.id === 'vm-view')!.globallyEnabled).toBe(false);
    expect(store.listModules().find((m) => m.id === 'vm-view_v2')!.globallyEnabled).toBe(false);
  });

  it('réconciliation au chargement : conserve les entrées de version et préférences _vN', async () => {
    const store = await freshStore();
    expect(store.syncModuleCatalog(['vm-view_v2'])).toBe(1);
    const u = store.createUser({ username: 'erin', displayName: 'Erin', passwordHash: 'h', role: 'user', groupIds: [] });
    store.setUserModules(u.id, ['vm-view', 'vm-view_v2']);
    // Redémarrage simulé : la réconciliation ne doit rien retirer
    const store2 = new AuthStore(file, logger);
    await store2.init(hashPassword);
    expect(store2.listModules().map((m) => m.id)).toEqual([
      'hypervision',
      'network',
      'storage',
      'vm-view',
      'proxmox-inventory',
      'centreon-nsca',
      'vm-view_v2',
    ]);
    expect(store2.data.userModules).toContainEqual({ userId: u.id, moduleId: 'vm-view_v2' });
  });

});

describe('seedAuthFile', () => {
  it('produit un fichier de version 1 sans groupes ni préférences', () => {
    const f = seedAuthFile();
    expect(f.version).toBe(1);
    expect(f.groups).toEqual([]);
    expect(f.userGroups).toEqual([]);
    expect(f.userModules).toEqual([]);
    expect(f.groupModules).toEqual([]);
  });
});
