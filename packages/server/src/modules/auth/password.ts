import argon2 from 'argon2';
import { validatePassword, type PasswordIssue } from '@prox4u/shared';

/**
 * Mots de passe : hash argon2id + politique commune (shared/validatePassword).
 * La politique est vérifiée côté serveur (source de vérité) ET côté web (miroir UX).
 */

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // hash corrompu/absent : échec silencieux (jamais d'exception vers l'appelant)
    return false;
  }
}

/** Politique de mot de passe — renvoie le code d'erreur i18n ou null si conforme. */
export function checkPasswordPolicy(password: string): PasswordIssue | null {
  return validatePassword(password);
}

/** Mot de passe temporaire généré (réinitialisation admin) : 12 caractères, lettre + chiffre garantis. */
export function generateTemporaryPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
  const chars: string[] = [];
  for (let i = 0; i < 10; i++) chars.push(pick(letters + digits));
  chars.push(pick(letters), pick(digits)); // garantit la présence d'une lettre et d'un chiffre
  // mélange (Fisher-Yates) pour ne pas exposer la position des caractères garantis
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
