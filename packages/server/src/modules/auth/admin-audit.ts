import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdminAuditActor, AdminAuditEntry } from '@prox4u/shared';

/**
 * Journal d'audit des actions d'administration : fichier JSONL append-only
 * (data/admin-audit.jsonl, chmod 600). Une entrée JSON par ligne.
 *
 * Append-only = pas de read-modify-write : une écriture ne peut pas écraser une
 * entrée concurrente. Rétention : au-delà de MAX_ENTRIES, les entrées les plus
 * anciennes sont tronquées (rotation simple en réécrivant la queue).
 *
 * Les mots de passe ne sont JAMAIS tracés — seule l'action et ses métadonnées.
 */

const MAX_ENTRIES = 20_000;

export class AdminAuditStore {
  constructor(
    private filePath: string,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
    /** Plafond d'entrées (défaut 20 000) — injectable pour les tests. */
    private maxEntries: number = MAX_ENTRIES,
  ) {}

  /** Crée le fichier vide (chmod 600) s'il n'existe pas. Idempotent. */
  init(): void {
    if (existsSync(this.filePath)) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, '');
    chmodSync(this.filePath, 0o600);
  }

  /**
   * Ajoute une entrée au journal. `target`/`details` optionnels. Ne lève pas
   * d'exception sur une erreur d'écriture (un journal plein/droits ne doit pas
   * faire échouer l'action admin) — loggue en warning.
   */
  append(actor: AdminAuditActor, action: string, target?: string, details?: Record<string, unknown>): void {
    const entry: AdminAuditEntry = {
      t: new Date().toISOString(),
      actor,
      action,
      ...(target !== undefined ? { target } : {}),
      ...(details ? { details } : {}),
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
      this.enforceCap();
    } catch (err) {
      this.logger.warn(`admin-audit : écriture du journal impossible — ${(err as Error).message}`);
    }
  }

  /** Rétention : au-delà de MAX_ENTRIES, conserve les entrées les plus récentes. */
  private enforceCap(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length <= this.maxEntries) return;
    const kept = lines.slice(-this.maxEntries);
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, kept.join('\n') + '\n');
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
    this.logger.info(`admin-audit : journal tronqué aux ${this.maxEntries} entrées les plus récentes`);
  }

  /** Lit toutes les entrées (ordre chronologique, plus ancien d'abord). */
  readAll(): AdminAuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const out: AdminAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as AdminAuditEntry);
      } catch {
        // ligne corrompue : ignorée (jamais d'exception vers la route)
      }
    }
    return out;
  }
}
