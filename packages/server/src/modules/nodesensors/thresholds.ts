import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SensorThresholds } from '@prox4u/shared';

/**
 * Stockage des seuils capteurs personnalisés : un seul fichier
 * data/sensor-thresholds.json (gitignoré, chmod 600), cache en mémoire +
 * écriture atomique (tmp → rename). Mêmes garanties que data/centreon-nsca.json.
 *
 * Format : { "thresholds": { "node/chip/feature": seuil °C } }. Absence de clé =
 * fallback firmware. La contrainte « baisser uniquement » (perso ≤ firmware) est
 * appliquée côté routes (le store ne connaît pas le firmware — il est lu dans
 * InfluxDB).
 */
export class SensorThresholdStore {
  private file: { thresholds: SensorThresholds } | null = null;

  constructor(
    private filePath: string,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
  ) {}

  /** Charge (ou crée) le fichier. Fail-fast si corrompu. */
  init(): void {
    if (existsSync(this.filePath)) {
      let raw: string;
      try {
        raw = readFileSync(this.filePath, 'utf8');
      } catch (err) {
        throw new Error(`data/sensor-thresholds.json illisible : ${(err as Error).message}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new Error(`data/sensor-thresholds.json invalide (JSON) : ${(err as Error).message}`);
      }
      const f = data as { thresholds?: unknown };
      if (f.thresholds !== undefined && (typeof f.thresholds !== 'object' || f.thresholds === null || Array.isArray(f.thresholds))) {
        throw new Error('data/sensor-thresholds.json invalide : `thresholds` doit être un objet « clé → °C »');
      }
      this.file = { thresholds: (f.thresholds as SensorThresholds) ?? {} };
      this.logger.info(`sensor-thresholds : ${Object.keys(this.file.thresholds).length} seuil(s) personnalisé(s) chargé(s)`);
      return;
    }
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.file = { thresholds: {} };
    this.persist();
    this.logger.info('sensor-thresholds : data/sensor-thresholds.json créé (vide — seuil firmware partout)');
  }

  /** Copie des seuils personnalisés courants (jamais la référence interne). */
  getThresholds(): SensorThresholds {
    if (!this.file) throw new Error('SensorThresholdStore non initialisé');
    return { ...this.file.thresholds };
  }

  /** Remplace l'ensemble des seuils (déjà clampés côté routes). Écriture atomique. */
  setThresholds(thresholds: SensorThresholds): SensorThresholds {
    if (!this.file) throw new Error('SensorThresholdStore non initialisé');
    this.file.thresholds = { ...thresholds };
    this.persist();
    return this.getThresholds();
  }

  /** Supprime un seuil (retour au firmware). `true` si la clé existait. */
  deleteThreshold(key: string): boolean {
    if (!this.file) throw new Error('SensorThresholdStore non initialisé');
    if (!(key in this.file.thresholds)) return false;
    delete this.file.thresholds[key];
    this.persist();
    return true;
  }

  /** Efface tous les seuils (retour firmware partout). */
  clearAll(): void {
    if (!this.file) throw new Error('SensorThresholdStore non initialisé');
    this.file.thresholds = {};
    this.persist();
  }

  /** Écriture atomique : tmp + rename, permissions 600. */
  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }
}
