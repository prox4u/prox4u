import { describe, expect, it } from 'vitest';
import { deriveQuorumState } from './quorum.js';

describe('deriveQuorumState', () => {
  it('préfère l’état rapporté par PVE (quorum_state, PVE 8+)', () => {
    expect(deriveQuorumState(1, 3, 'lost')).toBe('lost');
    expect(deriveQuorumState(5, 3, 'ok')).toBe('ok');
  });

  it('dérive : en ligne < quorum → lost, sinon ok', () => {
    expect(deriveQuorumState(2, 3)).toBe('lost');
    expect(deriveQuorumState(3, 3)).toBe('ok');
    expect(deriveQuorumState(5, 3)).toBe('ok');
    expect(deriveQuorumState(0, 1)).toBe('lost');
  });

  it('quorum inconnu (null / 0) → null (pas d’avis)', () => {
    expect(deriveQuorumState(3, null)).toBeNull();
    expect(deriveQuorumState(3, 0)).toBeNull();
  });
});
