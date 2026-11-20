import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuditStore } from './admin-audit.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('AdminAuditStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'admin-audit-'));
    file = path.join(dir, 'admin-audit.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('init crée le fichier vide (idempotent)', () => {
    const store = new AdminAuditStore(file, logger);
    store.init();
    expect(existsSync(file)).toBe(true);
    store.init(); // idempotent
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('append écrit une ligne JSON valide, readAll la relit', () => {
    const store = new AdminAuditStore(file, logger);
    store.init();
    store.append({ id: 'u_1', username: 'admin' }, 'user.create', 'alice', { role: 'user' });
    const raw = readFileSync(file, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    const entries = store.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: { id: 'u_1', username: 'admin' }, action: 'user.create', target: 'alice' });
    expect(entries[0].details).toEqual({ role: 'user' });
    expect(entries[0].t).toEqual(expect.any(String));
  });

  it('omet target/details quand absents', () => {
    const store = new AdminAuditStore(file, logger);
    store.init();
    store.append({ id: 'u_1', username: 'admin' }, 'group.delete', 'Auditeurs');
    store.append({ id: 'u_1', username: 'admin' }, 'catalog.sync');
    const [a, b] = store.readAll();
    expect(a.target).toBe('Auditeurs');
    expect(a.details).toBeUndefined();
    expect(b.target).toBeUndefined();
    expect(b.details).toBeUndefined();
  });

  it('plusieurs append → ordre chronologique conservé', () => {
    const store = new AdminAuditStore(file, logger);
    store.init();
    store.append({ id: 'u_1', username: 'admin' }, 'user.create', 'a');
    store.append({ id: 'u_1', username: 'admin' }, 'user.create', 'b');
    store.append({ id: 'u_1', username: 'admin' }, 'user.create', 'c');
    const entries = store.readAll();
    expect(entries.map((e) => e.target)).toEqual(['a', 'b', 'c']);
  });

  it('tronque aux N entrées les plus récentes au-delà du plafond', () => {
    const store = new AdminAuditStore(file, logger, 5);
    store.init();
    for (let i = 0; i < 8; i++) store.append({ id: 'u_1', username: 'admin' }, 'user.create', `u${i}`);
    const entries = store.readAll();
    expect(entries).toHaveLength(5);
    // conserve les plus récentes (u3..u7)
    expect(entries.map((e) => e.target)).toEqual(['u3', 'u4', 'u5', 'u6', 'u7']);
  });

  it('readAll ignore les lignes corrompues', () => {
    const store = new AdminAuditStore(file, logger);
    store.init();
    store.append({ id: 'u_1', username: 'admin' }, 'user.create', 'a');
    // ligne invalide injectée
    appendFileSync(file, '{pas du json}\n');
    store.append({ id: 'u_1', username: 'admin' }, 'user.create', 'b');
    const entries = store.readAll();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.target)).toEqual(['a', 'b']);
  });

  it('readAll sur fichier absent → []', () => {
    const store = new AdminAuditStore(path.join(dir, 'inexistant.jsonl'), logger);
    expect(store.readAll()).toEqual([]);
  });
});
