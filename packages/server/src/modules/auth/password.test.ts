import { describe, expect, it } from 'vitest';
import { validatePassword } from '@prox4u/shared';
import { checkPasswordPolicy, generateTemporaryPassword, hashPassword, verifyPassword } from './password.js';

describe('hashPassword / verifyPassword', () => {
  it('hash argon2id puis vérifie le bon mot de passe', async () => {
    const hash = await hashPassword('proX4u2026');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'proX4u2026')).toBe(true);
  });

  it('rejette un mauvais mot de passe', async () => {
    const hash = await hashPassword('proX4u2026');
    expect(await verifyPassword(hash, 'mauvais123')).toBe(false);
  });

  it('ne lève pas sur un hash corrompu', async () => {
    expect(await verifyPassword('$argon2id$casse', 'nimporte123')).toBe(false);
  });
});

describe('checkPasswordPolicy', () => {
  it('miroir de la politique shared (≥8 car., lettre + chiffre)', () => {
    expect(checkPasswordPolicy('abc')).toBe('too-short');
    expect(checkPasswordPolicy('12345678')).toBe('no-letter');
    expect(checkPasswordPolicy('abcdefgh')).toBe('no-digit');
    expect(checkPasswordPolicy('proX4u2026')).toBeNull();
  });
});

describe('generateTemporaryPassword', () => {
  it('produit 12 caractères conformes à la politique', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(12);
      expect(validatePassword(pw)).toBeNull();
    }
  });

  it('est aléatoire', () => {
    const set = new Set(Array.from({ length: 20 }, () => generateTemporaryPassword()));
    expect(set.size).toBeGreaterThan(15);
  });
});
