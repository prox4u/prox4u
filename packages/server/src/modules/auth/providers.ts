import type { User } from '@prox4u/shared';
import { verifyPassword } from './password.js';
import type { AuthStore } from './store.js';

/**
 * Abstraction du fournisseur d'authentification.
 * - LocalProvider : mot de passe argon2id dans data/auth.json (actif).
 * - AdProvider (à venir) : bind LDAP/Active Directory. Les comptes AD seront
 *   stockés avec provider='ad' et passwordHash=null (provisionnement JIT à la
 *   1ʳᵉ connexion, changement de mdp géré par l'AD).
 */

export type AuthFailure = 'invalid-credentials' | 'disabled';
export type AuthResult = { ok: true; user: User } | { ok: false; failure: AuthFailure };

export interface AuthProvider {
  readonly id: 'local' | 'ad';
  authenticate(username: string, password: string): Promise<AuthResult>;
}

/** Fournisseur local : vérifie le hash argon2id du fichier data/auth.json. */
export class LocalProvider implements AuthProvider {
  readonly id = 'local' as const;

  constructor(private store: AuthStore) {}

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const user = this.store.userByUsername(username);
    // même échec que compte inconnu (pas d'énumération des comptes)
    if (!user || !user.passwordHash) return { ok: false, failure: 'invalid-credentials' };
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) return { ok: false, failure: 'invalid-credentials' };
    if (!user.active) return { ok: false, failure: 'disabled' };
    return { ok: true, user };
  }
}
