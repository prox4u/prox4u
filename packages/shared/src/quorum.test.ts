import { describe, expect, it } from 'vitest';
import { deriveQdeviceState, deriveQuorumState, qdeviceStateFromCorosync } from './quorum.js';

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

describe('deriveQdeviceState (Qdevice déduit de l’API PVE)', () => {
  // Cluster 2 nœuds : seuil sans Qdevice = floor(2/2)+1 = 2.
  it('2 nœuds : tous en ligne → unknown (les nœuds suffisent, Qdevice indifférent)', () => {
    expect(deriveQdeviceState(2, 2, 'ok')).toBe('unknown');
  });

  it('2 nœuds : 1 down + quorate → Qdevice EN LIGNE (il sauve le quorum)', () => {
    expect(deriveQdeviceState(2, 1, 'ok')).toBe('up');
  });

  it('2 nœuds : 1 down + non quorate → Qdevice HORS LIGNE', () => {
    expect(deriveQdeviceState(2, 1, 'lost')).toBe('down');
  });

  it('2 nœuds : 0 en ligne + non quorate → Qdevice HORS LIGNE', () => {
    expect(deriveQdeviceState(2, 0, 'lost')).toBe('down');
  });

  // Cluster 3 nœuds : seuil sans Qdevice = floor(3/2)+1 = 2.
  it('3 nœuds : 2 en ligne → unknown (les nœuds suffisent)', () => {
    expect(deriveQdeviceState(3, 2, 'ok')).toBe('unknown');
  });

  it('3 nœuds : 1 down + quorate → Qdevice EN LIGNE (1 nœud seul ne suffit pas)', () => {
    expect(deriveQdeviceState(3, 1, 'ok')).toBe('up');
  });

  it('3 nœuds : 1 down + non quorate → Qdevice HORS LIGNE', () => {
    expect(deriveQdeviceState(3, 1, 'lost')).toBe('down');
  });

  it('quorumState inconnu (null) → unknown (pas d’avis)', () => {
    expect(deriveQdeviceState(2, 1, null)).toBe('unknown');
  });

  it('0 nœud total → unknown', () => {
    expect(deriveQdeviceState(0, 0, 'ok')).toBe('unknown');
  });
});

describe('qdeviceStateFromCorosync (Qdevice réel, table Telegraf quorum_detail)', () => {
  it('pas de Qdevice configuré → absent (peu importe l’online)', () => {
    expect(qdeviceStateFromCorosync(false, false)).toBe('absent');
    expect(qdeviceStateFromCorosync(false, true)).toBe('absent');
  });

  it('Qdevice configuré + en ligne → up', () => {
    expect(qdeviceStateFromCorosync(true, true)).toBe('up');
  });

  it('Qdevice configuré + hors ligne → down', () => {
    expect(qdeviceStateFromCorosync(true, false)).toBe('down');
  });
});
