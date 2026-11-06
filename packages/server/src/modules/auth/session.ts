import { randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';

/**
 * Sessions côté serveur, en mémoire : token opaque (64 hex) → userId + expiration.
 * Volontairement non persistées : un restart du serveur déconnecte tout le monde
 * (re-login) — acceptable pour un outil interne, et aucun fichier de session à protéger.
 */

export const SESSION_COOKIE = 'pvm_session';

interface SessionEntry {
  userId: string;
  expiresAt: number;
}

export class SessionStore {
  private sessions = new Map<string, SessionEntry>();

  constructor(private ttlMs_: number) {}

  /** Crée une session et renvoie le token (valeur du cookie). */
  create(userId: string): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { userId, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /** Session valide pour un token (null si absent/expiré — expiration paresseuse). */
  get(token: string | undefined): { userId: string } | null {
    if (!token) return null;
    const entry = this.sessions.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return { userId: entry.userId };
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * Révoque toutes les sessions d'un utilisateur (changement/réinitialisation
   * de mot de passe) — `exceptToken` permet de conserver la session en cours
   * (l'utilisateur qui change SON mot de passe reste connecté).
   */
  destroyAllForUser(userId: string, exceptToken?: string): void {
    for (const [token, entry] of this.sessions) {
      if (entry.userId === userId && token !== exceptToken) this.sessions.delete(token);
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  get ttlMs(): number {
    return this.ttlMs_;
  }
}

/** Options du cookie de session : httpOnly (jamais lisible par le JS), SameSite=Lax. */
export function sessionCookieOptions(secure: boolean, maxAgeSec: number): CookieSerializeOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge: maxAgeSec };
}

/** Parse minimal du header Cookie (pas de dépendance externe). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      // cookie malformé (% isolé, séquence incomplète) : ignoré — jamais d'exception
      // vers le guard (un 500 sur toutes les routes serait un DoS trivial).
      out[key] = raw;
    }
  }
  return out;
}
