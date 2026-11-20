import { describe, expect, it } from 'vitest';
import { computeHealthScore } from './health.js';
import type { KpiSummary, NodeHealth, PraReport } from './types.js';

const okNode = (node: string): NodeHealth => ({
  node,
  online: true,
  siteId: null,
  cpuPct: 20,
  ramPct: 30,
  diskPct: 40,
  uptimeSec: 1000,
  severity: 'ok',
  cpus: 32,
  memUsedBytes: 1,
  memTotalBytes: 2,
  rootfsUsedBytes: 1,
  rootfsTotalBytes: 2,
  loadavg: [1, 1, 1],
  cpuAllocCores: 0,
  ramAllocBytes: 0,
});

const okKpis = (over: Partial<KpiSummary> = {}): KpiSummary => ({
  nodes: { online: 2, total: 2 },
  cpuTotalCores: 64,
  cpuUsedCores: 13,
  cpuPct: 20,
  cpuAllocatedCores: 0,
  ramUsedBytes: 1,
  ramTotalBytes: 2,
  ramPct: 30,
  ramAllocatedBytes: 0,
  diskAllocatedBytes: 0,
  diskThinAllocatedBytes: 0,
  diskThinTotalBytes: 0,
  storageUsedBytes: 1,
  storageTotalBytes: 2,
  storagePct: 40,
  storageDaysToFull: null,
  vmsRunning: 3,
  vmsStopped: 1,
  vmsTotal: 4,
  vmsAgentDown: 0,
  ...over,
});

const okPra = (globalSeverity: PraReport['globalSeverity'] = 'ok'): PraReport => ({
  sites: [],
  globalSeverity,
  affectedVms: [],
});

describe('computeHealthScore', () => {
  it('100 / nominal quand tout est vert', () => {
    const h = computeHealthScore([okNode('a'), okNode('b')], okKpis(), okPra());
    expect(h.score).toBe(100);
    expect(h.label).toBe('nominal');
    expect(h.penalties).toHaveLength(0);
  });

  it('−25 par nœud hors ligne', () => {
    const h = computeHealthScore([{ ...okNode('a'), online: false }], okKpis(), okPra());
    expect(h.score).toBe(75);
    expect(h.penalties[0].reasonKey).toBe('health.penalty.nodeDown');
  });

  it('CPU > 90 % → −20, ≥ 70 % → −10', () => {
    expect(computeHealthScore([], okKpis({ cpuPct: 95 }), okPra()).score).toBe(80);
    expect(computeHealthScore([], okKpis({ cpuPct: 75 }), okPra()).score).toBe(90);
    expect(computeHealthScore([], okKpis({ cpuPct: 69 }), okPra()).score).toBe(100);
  });

  it('RAM et stockage pénalisés de la même façon', () => {
    expect(computeHealthScore([], okKpis({ ramPct: 91 }), okPra()).score).toBe(80);
    expect(computeHealthScore([], okKpis({ storagePct: 92 }), okPra()).score).toBe(85);
  });

  it('PRA critique −20, vigilance −10, na → 0', () => {
    expect(computeHealthScore([], okKpis(), okPra('crit')).score).toBe(80);
    expect(computeHealthScore([], okKpis(), okPra('warn')).score).toBe(90);
    expect(computeHealthScore([], okKpis(), okPra('na')).score).toBe(100);
  });

  it('quorum perdu → −25 (guests actifs mais cluster en lecture seule)', () => {
    const h = computeHealthScore([okNode('a'), okNode('b')], okKpis(), okPra(), { quorum: 2, quorumState: 'lost' });
    expect(h.score).toBe(75);
    expect(h.penalties[0].reasonKey).toBe('health.penalty.quorumLost');
    expect(h.penalties[0].params).toEqual({ online: 2, total: 2 });
  });

  it('quorum ok / inconnu / absent → aucune pénalité', () => {
    expect(computeHealthScore([okNode('a')], okKpis(), okPra(), { quorum: 1, quorumState: 'ok' }).score).toBe(100);
    expect(computeHealthScore([okNode('a')], okKpis(), okPra(), { quorum: null, quorumState: null }).score).toBe(100);
    expect(computeHealthScore([okNode('a')], okKpis(), okPra()).score).toBe(100);
  });

  it('Qdevice down → −10 (quorum non protégé — risque, pas incident)', () => {
    const h = computeHealthScore([okNode('a'), okNode('b')], okKpis(), okPra(), {
      quorum: 2,
      quorumState: 'ok',
      qdevice: 'down',
    });
    expect(h.score).toBe(90);
    expect(h.penalties[0].reasonKey).toBe('health.penalty.qdeviceDown');
  });

  it('Qdevice up / absent / inconnu → aucune pénalité', () => {
    expect(computeHealthScore([okNode('a')], okKpis(), okPra(), { quorum: 1, quorumState: 'ok', qdevice: 'up' }).score).toBe(100);
    expect(computeHealthScore([okNode('a')], okKpis(), okPra(), { quorum: 1, quorumState: 'ok', qdevice: 'absent' }).score).toBe(100);
    expect(computeHealthScore([okNode('a')], okKpis(), okPra(), { quorum: 1, quorumState: 'ok', qdevice: 'unknown' }).score).toBe(100);
  });

  it('quorum perdu + Qdevice down → pénalités cumulées (−25 −10)', () => {
    const h = computeHealthScore([okNode('a'), okNode('b')], okKpis(), okPra(), {
      quorum: 2,
      quorumState: 'lost',
      qdevice: 'down',
    });
    expect(h.score).toBe(65);
    expect(h.penalties.map((p) => p.reasonKey)).toEqual(['health.penalty.quorumLost', 'health.penalty.qdeviceDown']);
  });

  it('borné à 0 et libellés corrects', () => {
    const h = computeHealthScore(
      [{ ...okNode('a'), online: false }, { ...okNode('b'), online: false }],
      okKpis({ cpuPct: 95, ramPct: 95, storagePct: 95 }),
      okPra('crit'),
    );
    expect(h.score).toBe(0);
    expect(h.label).toBe('critical');

    const mid = computeHealthScore([], okKpis({ cpuPct: 95, ramPct: 75 }), okPra());
    expect(mid.score).toBe(70);
    expect(mid.label).toBe('degraded');
  });
});
