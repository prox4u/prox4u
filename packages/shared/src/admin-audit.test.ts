import { describe, expect, it } from 'vitest';
import { ADMIN_AUDIT_ACTIONS, pageAuditEntries, type AdminAuditEntry } from './admin-audit.js';

function entry(i: number, action: string, actor: string, target?: string): AdminAuditEntry {
  return {
    t: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    actor: { id: `u_${i}`, username: actor },
    action,
    ...(target ? { target } : {}),
  };
}

describe('ADMIN_AUDIT_ACTIONS', () => {
  it('liste les actions admin connues (sans doublon)', () => {
    expect(ADMIN_AUDIT_ACTIONS).toContain('user.create');
    expect(ADMIN_AUDIT_ACTIONS).toContain('backup.import');
    expect(new Set(ADMIN_AUDIT_ACTIONS).size).toBe(ADMIN_AUDIT_ACTIONS.length);
  });
});

describe('pageAuditEntries', () => {
  const entries: AdminAuditEntry[] = [
    entry(0, 'user.create', 'admin', 'alice'),
    entry(1, 'group.update', 'admin', 'Auditeurs'),
    entry(2, 'user.create', 'bob', 'carol'),
    entry(3, 'module.toggle', 'admin', 'storage'),
    entry(4, 'user.update', 'bob', 'alice'),
  ];

  it('renvoie de la plus récente à la plus ancienne', () => {
    const page = pageAuditEntries(entries, {});
    expect(page.entries.map((e) => e.t)).toEqual([...entries].reverse().map((e) => e.t));
    expect(page.total).toBe(5);
  });

  it('limite le nombre d’entrées par page', () => {
    const page = pageAuditEntries(entries, { limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0].t).toBe(entries[4].t); // la plus récente
    expect(page.total).toBe(5);
  });

  it('offset compté depuis la plus récente', () => {
    const page = pageAuditEntries(entries, { limit: 2, offset: 2 });
    expect(page.entries.map((e) => e.t)).toEqual([entries[2].t, entries[1].t]);
  });

  it('filtre sur l’action', () => {
    const page = pageAuditEntries(entries, { action: 'user.create' });
    expect(page.entries).toHaveLength(2);
    expect(page.entries.every((e) => e.action === 'user.create')).toBe(true);
  });

  it('filtre sur l’acteur (username)', () => {
    const page = pageAuditEntries(entries, { actor: 'bob' });
    expect(page.entries).toHaveLength(2);
    expect(page.entries.every((e) => e.actor.username === 'bob')).toBe(true);
  });

  it('combine filtres + pagination', () => {
    const all: AdminAuditEntry[] = Array.from({ length: 10 }, (_, i) => entry(i, 'user.update', 'admin', `u${i}`));
    const page = pageAuditEntries(all, { limit: 3, offset: 0, action: 'user.update', actor: 'admin' });
    expect(page.total).toBe(10);
    expect(page.entries).toHaveLength(3);
    expect(page.entries[0].t).toBe(all[9].t);
  });

  it('borne les valeurs négatives (limit → 1, offset → 0)', () => {
    const page = pageAuditEntries(entries, { limit: -5, offset: -3 });
    expect(page.entries).toHaveLength(1); // limit borné à ≥ 1
    expect(page.entries[0].t).toBe(entries[4].t); // la plus récente
    expect(page.total).toBe(5);
  });

  it('vide → total 0, aucune entrée', () => {
    const page = pageAuditEntries([], { limit: 10 });
    expect(page.entries).toEqual([]);
    expect(page.total).toBe(0);
  });
});
