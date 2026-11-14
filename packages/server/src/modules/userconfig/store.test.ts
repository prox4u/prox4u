import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_CONFIG_SCHEMA_VERSION, type UserConfig } from '@prox4u/shared';
import { UserConfigStore } from './store.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cfg = (extra?: Partial<UserConfig>): UserConfig => ({
  schemaVersion: USER_CONFIG_SCHEMA_VERSION,
  pages: { overview: { layout: [{ widgetId: 'res-cpu', x: 0, y: 0, w: 4, h: 3 }], library: ['alerts'] } },
  lastUpdated: '2026-11-14T00:00:00.000Z',
  ...extra,
});

describe('UserConfigStore', () => {
  let dir: string;
  let store: UserConfigStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'user-config-store-'));
    store = new UserConfigStore(dir, logger);
    store.init();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('dossier créé au init', () => {
    expect(existsSync(dir)).toBe(true);
  });

  it('load inconnu → null (et mis en cache)', () => {
    expect(store.load('u_aaa')).toBeNull();
    expect(existsSync(path.join(dir, 'u_aaa.json'))).toBe(false);
  });

  it('save → load round-trip (lastUpdated posé par le serveur)', () => {
    const before = Date.now();
    const saved = store.save('u_bbb', cfg());
    expect(saved.lastUpdated).toBeTypeOf('string');
    expect(new Date(saved.lastUpdated).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const loaded = store.load('u_bbb');
    expect(loaded).toEqual(saved);
  });

  it('un fichier par utilisateur — isolation', () => {
    store.save('u_1', cfg());
    store.save('u_2', cfg({ pages: {} }));
    expect(store.load('u_1')).not.toEqual(store.load('u_2'));
    expect(existsSync(path.join(dir, 'u_1.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'u_2.json'))).toBe(true);
  });

  it('reset → fichier supprimé + load null', () => {
    store.save('u_ccc', cfg());
    store.reset('u_ccc');
    expect(existsSync(path.join(dir, 'u_ccc.json'))).toBe(false);
    expect(store.load('u_ccc')).toBeNull();
  });

  it('reset sans fichier → sans erreur', () => {
    expect(() => store.reset('u_inexistant')).not.toThrow();
  });

  it('fichier corrompu (JSON) → null + warn, pas d’exception', () => {
    const file = path.join(dir, 'u_ddd.json');
    writeFileSync(file, '{pas du json');
    expect(store.load('u_ddd')).toBeNull();
  });

  it('fichier invalide (forme) → null, pas d’exception', () => {
    const file = path.join(dir, 'u_eee.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 999, pages: {} }));
    expect(store.load('u_eee')).toBeNull();
  });

  it('identifiant invalide → throw (pas de traversée de chemin possible)', () => {
    expect(() => store.load('../etc/passwd')).toThrow();
    expect(() => store.save('a/b', cfg())).toThrow();
  });

  it('recharge après « restart » (cache vide) → même config', () => {
    store.save('u_fff', cfg());
    const store2 = new UserConfigStore(dir, logger);
    store2.init();
    expect(store2.load('u_fff')).toEqual(cfg({ lastUpdated: store.load('u_fff')!.lastUpdated }));
  });
});
