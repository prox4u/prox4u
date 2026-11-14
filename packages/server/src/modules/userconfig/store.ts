import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseUserConfig, type UserConfig } from '@prox4u/shared';

/**
 * Persistance de la personnalisation d'interface : UN FICHIER PAR UTILISATEUR
 * `data/user-configs/<userId>.json` (dossier gitignoré comme `data/`, chmod 600).
 *
 * Mêmes garanties que data/auth.json / sensor-thresholds.json : écriture
 * atomique (tmp → rename), cache mémoire. Différence de tolérance : un fichier
 * d'un utilisateur CORROMPU ne fait pas planter le démarrage (warn + défauts
 * pour cet utilisateur) — c'est une préférence d'UI, pas une donnée critique.
 *
 * `userId` vient de la session (req.authUser.id = « u_… »), jamais de l'URL —
 * assaini défensif pour éviter toute traversée de chemin.
 */

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export class UserConfigStore {
  /** userId → config (null = jamais personnalisé) — évite les re-lectures disque. */
  private cache = new Map<string, UserConfig | null>();

  constructor(
    private dir: string,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
  ) {}

  /** Crée le dossier des configs s'il est absent. */
  init(): void {
    mkdirSync(this.dir, { recursive: true });
    this.logger.info(`user-config : dossier ${this.dir} prêt`);
  }

  private fileFor(userId: string): string {
    if (!SAFE_ID_RE.test(userId) || userId.length === 0 || userId.length > 64) {
      throw new Error(`user-config : identifiant utilisateur invalide : « ${userId} »`);
    }
    return path.join(this.dir, `${userId}.json`);
  }

  /**
   * Config de l'utilisateur (null = jamais personnalisé → le client construit
   * les défauts depuis le catalogue de la page).
   */
  load(userId: string): UserConfig | null {
    if (this.cache.has(userId)) return this.cache.get(userId)!;
    const file = this.fileFor(userId);
    let cfg: UserConfig | null = null;
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, 'utf8');
        const data: unknown = JSON.parse(raw);
        const parsed = parseUserConfig(data);
        if (parsed) {
          // parseUserConfig ignore `lastUpdated` (posé au save) — on le reprend
          // du fichier s'il est bien formé (info d'affichage, rien d'autre).
          const storedTs = (data as { lastUpdated?: unknown })?.lastUpdated;
          parsed.lastUpdated = typeof storedTs === 'string' ? storedTs : '';
          cfg = parsed;
        } else {
          this.logger.warn(`user-config(${userId}) : fichier invalide → défauts`);
        }
      } catch (err) {
        this.logger.warn(`user-config(${userId}) : lecture en échec (${(err as Error).message}) → défauts`);
      }
    }
    this.cache.set(userId, cfg);
    return cfg;
  }

  /** Sauvegarde (remplacement complet) — pose `lastUpdated`. Écriture atomique. */
  save(userId: string, config: UserConfig): UserConfig {
    const saved: UserConfig = {
      schemaVersion: config.schemaVersion,
      pages: config.pages,
      lastUpdated: new Date().toISOString(),
    };
    const file = this.fileFor(userId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    this.cache.set(userId, saved);
    return saved;
  }

  /** Réinitialisation complète de l'utilisateur (suppression du fichier). */
  reset(userId: string): void {
    const file = this.fileFor(userId);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch (err) {
        this.logger.warn(`user-config(${userId}) : suppression en échec (${(err as Error).message})`);
      }
    }
    this.cache.set(userId, null);
  }
}
