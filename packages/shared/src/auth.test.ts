import { describe, expect, it } from 'vitest';
import {
  authorizedModuleEntries,
  authorizedModuleIds,
  computeVisibleVersionIds,
  computeVisibleModuleIds,
  isAuthorizedModuleSelection,
  toPublicUser,
  validatePassword,
  type AuthFile,
} from './auth.js';

function fixture(over: Partial<AuthFile> = {}): AuthFile {
  return {
    version: 1,
    users: [
      {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        role: 'user',
        provider: 'local',
        passwordHash: 'x',
        mustChangePassword: false,
        active: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    groups: [{ id: 'g1', name: 'Exploitation', description: '' }],
    modules: [
      { id: 'dashboard', name: 'Dashboard', description: '', globallyEnabled: false },
      { id: 'supervision', name: 'Supervision', description: '', globallyEnabled: true },
      { id: 'backups', name: 'Backups', description: '', globallyEnabled: false },
    ],
    userGroups: [{ userId: 'u1', groupId: 'g1' }],
    userModules: [],
    groupModules: [{ groupId: 'g1', moduleId: 'dashboard' }],
    ...over,
  };
}

describe('validatePassword', () => {
  it('rejette les mots de passe trop courts', () => {
    expect(validatePassword('a1b2c3d')).toBe('too-short');
    expect(validatePassword('')).toBe('too-short');
  });
  it("rejette l'absence de lettre", () => {
    expect(validatePassword('12345678')).toBe('no-letter');
  });
  it("rejette l'absence de chiffre", () => {
    expect(validatePassword('abcdefgh')).toBe('no-digit');
  });
  it('accepte un mot de passe conforme', () => {
    expect(validatePassword('proX4u2026')).toBeNull();
    expect(validatePassword('a1b2c3d4')).toBeNull();
  });
});

describe('authorizedModuleIds', () => {
  it('autorise les modules globaux + ceux de ses groupes', () => {
    const f = fixture();
    // supervision = global, dashboard = via g1, backups = nulle part
    expect(authorizedModuleIds('u1', f)).toEqual(new Set(['supervision', 'dashboard']));
  });

  it("n'autorise que les modules globaux sans groupe", () => {
    const f = fixture({ userGroups: [] });
    expect(authorizedModuleIds('u1', f)).toEqual(new Set(['supervision']));
  });

  it("n'autorise rien avec un catalogue vide", () => {
    const f = fixture({ modules: [], groupModules: [] });
    expect(authorizedModuleIds('u1', f)).toEqual(new Set());
  });

  it('ignore les modules de groupes auxquels l\'utilisateur n\'appartient pas', () => {
    const f = fixture({ userGroups: [], groupModules: [{ groupId: 'g1', moduleId: 'dashboard' }] });
    expect(authorizedModuleIds('u1', f)).toEqual(new Set(['supervision']));
  });

  it("normalise les entrées de version en famille (v2 global → famille autorisée)", () => {
    const f = fixture({
      modules: [
        { id: 'backups', name: 'Backups', description: '', globallyEnabled: false },
        { id: 'backups_v2', name: 'Backups', description: '', globallyEnabled: true },
      ],
      userGroups: [],
      groupModules: [],
    });
    expect(authorizedModuleIds('u1', f)).toEqual(new Set(['backups']));
  });
});

describe('computeVisibleModuleIds', () => {
  it('croise autorisations ET préférences', () => {
    const f = fixture({ userModules: [{ userId: 'u1', moduleId: 'dashboard' }] });
    // dashboard : autorisé (g1) + sélectionné → visible ; supervision : autorisé (global) mais non sélectionné
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set(['dashboard']));
  });

  it("ignore une préférence sur un module non autorisé", () => {
    const f = fixture({ userModules: [{ userId: 'u1', moduleId: 'backups' }] });
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set());
  });

  it('rend tous les modules autorisés sélectionnés', () => {
    const f = fixture({
      userModules: [
        { userId: 'u1', moduleId: 'dashboard' },
        { userId: 'u1', moduleId: 'supervision' },
      ],
    });
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set(['dashboard', 'supervision']));
  });

  it("ignore les préférences d'autres utilisateurs", () => {
    const f = fixture({ userModules: [{ userId: 'u999', moduleId: 'dashboard' }] });
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set());
  });

  it('rend la famille visible si une de ses versions est sélectionnée', () => {
    const f = fixture({ userModules: [{ userId: 'u1', moduleId: 'dashboard_v2' }] });
    // dashboard_v2 → famille dashboard (autorisée via g1) → visible
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set(['dashboard']));
  });

  it("ignore une version d'une famille non autorisée", () => {
    const f = fixture({ userModules: [{ userId: 'u1', moduleId: 'backups_v3' }] });
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set());
  });

  it('cumule sélection famille + version de la même famille', () => {
    const f = fixture({
      userModules: [
        { userId: 'u1', moduleId: 'dashboard' },
        { userId: 'u1', moduleId: 'dashboard_v2' },
      ],
    });
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set(['dashboard']));
  });

  it('dérive la famille de la visibilité par version (seule v2 visible → famille visible)', () => {
    const f = fixture({
      modules: [
        { id: 'dashboard', name: 'Dashboard', description: '', globallyEnabled: false },
        { id: 'dashboard_v2', name: 'Dashboard', description: '', globallyEnabled: true },
      ],
      userGroups: [],
      groupModules: [],
      userModules: [{ userId: 'u1', moduleId: 'dashboard_v2' }],
    });
    expect(computeVisibleVersionIds('u1', f)).toEqual(new Set(['dashboard_v2']));
    expect(computeVisibleModuleIds('u1', f)).toEqual(new Set(['dashboard']));
  });
});

describe('authorizedModuleEntries', () => {
  it('autorise chaque version activée globalement (pas les autres versions de la famille)', () => {
    const f = fixture({
      modules: [
        { id: 'dashboard', name: 'Dashboard', description: '', globallyEnabled: false },
        { id: 'dashboard_v2', name: 'Dashboard', description: '', globallyEnabled: true },
        { id: 'supervision', name: 'Supervision', description: '', globallyEnabled: true },
      ],
      userGroups: [],
      groupModules: [],
    });
    // dashboard OFF + dashboard_v2 ON → seule la v2 est une ligne de profil ;
    // supervision (une seule version) reste autorisée.
    expect(authorizedModuleEntries('u1', f).map((m) => m.id)).toEqual(['dashboard_v2', 'supervision']);
  });

  it("autorise TOUTES les versions quand la famille vient d'un groupe (même global OFF)", () => {
    const f = fixture({
      modules: [
        { id: 'dashboard', name: 'Dashboard', description: '', globallyEnabled: false },
        { id: 'dashboard_v2', name: 'Dashboard', description: '', globallyEnabled: false },
      ],
    });
    // g1 → famille dashboard : les deux versions sont autorisées
    expect(authorizedModuleEntries('u1', f).map((m) => m.id)).toEqual(['dashboard', 'dashboard_v2']);
  });

  it("n'autorise rien si la famille est OFF partout et sans groupe", () => {
    const f = fixture({
      modules: [{ id: 'backups', name: 'Backups', description: '', globallyEnabled: false }],
      userGroups: [],
      groupModules: [],
    });
    expect(authorizedModuleEntries('u1', f)).toEqual([]);
  });
});

describe('computeVisibleVersionIds', () => {
  it('croise état global par version ET sélection par id exact', () => {
    const f = fixture({
      modules: [
        { id: 'dashboard', name: 'Dashboard', description: '', globallyEnabled: false },
        { id: 'dashboard_v2', name: 'Dashboard', description: '', globallyEnabled: true },
        { id: 'supervision', name: 'Supervision', description: '', globallyEnabled: true },
      ],
      userModules: [
        { userId: 'u1', moduleId: 'dashboard' },
        { userId: 'u1', moduleId: 'dashboard_v2' },
      ],
    });
    // dashboard : non global mais famille autorisée via g1 + sélectionné → visible
    // dashboard_v2 : global + sélectionné → visible ; supervision : non sélectionné
    expect(computeVisibleVersionIds('u1', f)).toEqual(new Set(['dashboard', 'dashboard_v2']));
  });

  it("masque une version globalement OFF sans groupe (v1 ON / v2 OFF indépendants)", () => {
    const f = fixture({
      modules: [
        { id: 'backups', name: 'Backups', description: '', globallyEnabled: true },
        { id: 'backups_v2', name: 'Backups', description: '', globallyEnabled: false },
      ],
      userGroups: [],
      groupModules: [],
      userModules: [
        { userId: 'u1', moduleId: 'backups' },
        { userId: 'u1', moduleId: 'backups_v2' },
      ],
    });
    expect(computeVisibleVersionIds('u1', f)).toEqual(new Set(['backups']));
  });

  it("autorise toutes les versions quand la famille vient d'un groupe", () => {
    const f = fixture({
      modules: [
        { id: 'dashboard', name: 'Dashboard', description: '', globallyEnabled: false },
        { id: 'dashboard_v2', name: 'Dashboard', description: '', globallyEnabled: false },
      ],
      userModules: [
        { userId: 'u1', moduleId: 'dashboard' },
        { userId: 'u1', moduleId: 'dashboard_v2' },
      ],
    });
    // g1 → famille dashboard : les deux versions sont autorisées malgré global OFF
    expect(computeVisibleVersionIds('u1', f)).toEqual(new Set(['dashboard', 'dashboard_v2']));
  });

  it('sélection sans entrée de catalogue (pré-sync) : repli sur l\'état de la famille', () => {
    const f = fixture({ userModules: [{ userId: 'u1', moduleId: 'dashboard_v2' }] });
    // pas d'entrée dashboard_v2 → hérite de la famille (autorisée via g1)
    expect(computeVisibleVersionIds('u1', f)).toEqual(new Set(['dashboard_v2']));
  });

  it("sélection sans entrée ET famille OFF : invisible", () => {
    const f = fixture({
      userGroups: [],
      groupModules: [],
      userModules: [{ userId: 'u1', moduleId: 'backups_v3' }],
    });
    expect(computeVisibleVersionIds('u1', f)).toEqual(new Set());
  });
});

describe('isAuthorizedModuleSelection', () => {
  const authorized = new Set(['supervision', 'dashboard']);

  it('accepte l\'id de famille et ses versions dérivées', () => {
    expect(isAuthorizedModuleSelection('dashboard', authorized)).toBe(true);
    expect(isAuthorizedModuleSelection('dashboard_v2', authorized)).toBe(true);
    expect(isAuthorizedModuleSelection('supervision_v9', authorized)).toBe(true);
  });

  it("rejette une famille non autorisée (même avec suffixe de version)", () => {
    expect(isAuthorizedModuleSelection('backups', authorized)).toBe(false);
    expect(isAuthorizedModuleSelection('backups_v2', authorized)).toBe(false);
  });
});

describe('toPublicUser', () => {
  it("n'expose jamais le hash et joint groupes/préférences", () => {
    const f = fixture({ userModules: [{ userId: 'u1', moduleId: 'supervision' }] });
    const pub = toPublicUser(f.users[0], f);
    expect(pub).toEqual({
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      role: 'user',
      provider: 'local',
      mustChangePassword: false,
      active: true,
      groupIds: ['g1'],
      selectedModuleIds: ['supervision'],
    });
    expect(JSON.stringify(pub)).not.toContain('passwordHash');
  });
});
