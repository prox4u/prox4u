import { describe, expect, it } from 'vitest';
import { parseCookies, SessionStore, sessionCookieOptions, SESSION_COOKIE } from './session.js';

describe('parseCookies', () => {
  it('parsing basique', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('décode les valeurs URI-encodées', () => {
    expect(parseCookies('x=hello%20world')).toEqual({ x: 'hello world' });
  });

  it("ne lève PAS sur un cookie malformé (DoS trivial écarté)", () => {
    // '%' isolé et séquence incomplète : decodeURIComponent lèverait une URIError
    // → avant le correctif, le guard renvoyait 500 sur TOUTES les routes protégées.
    expect(() => parseCookies('pvm_session=abc%')).not.toThrow();
    expect(parseCookies('pvm_session=abc%').pvm_session).toBe('abc%');
    expect(() => parseCookies('x=%zz')).not.toThrow();
    expect(parseCookies('x=%zz').x).toBe('%zz');
  });

  it('ignore les fragments sans « = »', () => {
    expect(parseCookies('orphan; a=1')).toEqual({ a: '1' });
  });
});

describe('SessionStore.destroyAllForUser', () => {
  const ttl = 60_000;

  it('révoque toutes les sessions d\'un utilisateur', () => {
    const s = new SessionStore(ttl);
    const a1 = s.create('user-a');
    const a2 = s.create('user-a');
    const b = s.create('user-b');
    expect(s.size).toBe(3);
    s.destroyAllForUser('user-a');
    expect(s.get(a1)).toBeNull();
    expect(s.get(a2)).toBeNull();
    expect(s.get(b)?.userId).toBe('user-b');
  });

  it('conserve la session en cours via exceptToken (changement de mdp)', () => {
    const s = new SessionStore(ttl);
    const current = s.create('user-a');
    const other = s.create('user-a');
    s.destroyAllForUser('user-a', current);
    expect(s.get(current)?.userId).toBe('user-a');
    expect(s.get(other)).toBeNull();
  });
});

describe('sessionCookieOptions', () => {
  it('httpOnly + SameSite=Lax toujours ; Secure seulement en TLS', () => {
    const lax = sessionCookieOptions(false, 3600);
    expect(lax.httpOnly).toBe(true);
    expect(lax.sameSite).toBe('lax');
    expect(lax.secure).toBe(false);
    expect(sessionCookieOptions(true, 3600).secure).toBe(true);
    expect(lax.path).toBe('/');
  });

  it('le nom du cookie est stable', () => {
    expect(SESSION_COOKIE).toBe('pvm_session');
  });
});
