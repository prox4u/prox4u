import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SensorThresholdStore } from './thresholds.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('SensorThresholdStore', () => {
  let dir: string;
  let file: string;
  let store: SensorThresholdStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sensor-thr-'));
    file = path.join(dir, 'sensor-thresholds.json');
    store = new SensorThresholdStore(file, logger);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('init crée un fichier vide ({} ) au 1er démarrage', () => {
    store.init();
    expect(existsSync(file)).toBe(true);
    expect(store.getThresholds()).toEqual({});
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({ thresholds: {} });
  });

  it('setThresholds persiste puis re-charge au nouvel init', () => {
    store.init();
    store.setThresholds({ 'proxmox/chip/edge': 90 });
    const reloaded = new SensorThresholdStore(file, logger);
    reloaded.init();
    expect(reloaded.getThresholds()).toEqual({ 'proxmox/chip/edge': 90 });
  });

  it('getThresholds renvoie une copie (mutation sans effet)', () => {
    store.init();
    store.setThresholds({ a: 1 });
    const copy = store.getThresholds();
    copy.a = 999;
    expect(store.getThresholds()).toEqual({ a: 1 });
  });

  it('deleteThreshold supprime la clé (true si elle existait)', () => {
    store.init();
    store.setThresholds({ 'n/c/f': 85, 'n/c/g': 95 });
    expect(store.deleteThreshold('n/c/f')).toBe(true);
    expect(store.deleteThreshold('n/c/f')).toBe(false); // déjà supprimée
    expect(store.getThresholds()).toEqual({ 'n/c/g': 95 });
  });

  it('clearAll efface tout', () => {
    store.init();
    store.setThresholds({ a: 1, b: 2 });
    store.clearAll();
    expect(store.getThresholds()).toEqual({});
  });

  it('fichier corrompu (JSON) → fail-fast', () => {
    store.init();
    writeFileSync(file, '{ pas du json ');
    expect(() => new SensorThresholdStore(file, logger).init()).toThrow(/invalide \(JSON\)/);
  });

  it('structure inattendue → fail-fast', () => {
    store.init();
    writeFileSync(file, JSON.stringify({ thresholds: [1, 2, 3] }));
    expect(() => new SensorThresholdStore(file, logger).init()).toThrow(/objet « clé → °C »/);
  });
});
