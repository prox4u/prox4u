import { describe, expect, it } from 'vitest';
import { VM_METRICS_TF, vmMetricsRowsToPoints } from './routes.js';

describe('VM_METRICS_TF', () => {
  it('couvre les 4 timeframes avec des buckets croissants (raw ≤ 31 j, agg pour le mois)', () => {
    expect(Object.keys(VM_METRICS_TF).sort()).toEqual(['day', 'hour', 'month', 'week']);
    // raw : hour (1 min), day (5 min), week (1 h) ; consolidated : month (1 j)
    expect(VM_METRICS_TF.hour).toEqual({ bucket: '1 minute', window: '1 hour', db: 'raw' });
    expect(VM_METRICS_TF.month).toEqual({ bucket: '1 day', window: '30 days', db: 'agg' });
  });
});

describe('vmMetricsRowsToPoints', () => {
  it('convertit les lignes date_bin+AVG en points triés (t ISO → unix seconds, tous les champs)', () => {
    const points = vmMetricsRowsToPoints([
      { t: '2026-10-26T12:05:00Z', cpu_pct: 42.5, mem_bytes: 1_073_741_824.4, disk_read_bps: 1000.6, disk_write_bps: 2000, net_in_bps: 1e6, net_out_bps: 5e5, disk_bytes: 500_000_000.4, disk_alloc_bytes: 1_000_000_000 },
      { t: '2026-10-26T12:00:00Z', cpu_pct: 10, mem_bytes: 536_870_912, disk_read_bps: 0, disk_write_bps: 0, net_in_bps: 0, net_out_bps: 0, disk_bytes: 250_000_000, disk_alloc_bytes: 1_000_000_000 },
    ]);
    expect(points).toEqual([
      { time: 1_793_016_000, cpuPct: 10, memBytes: 536_870_912, diskReadBps: 0, diskWriteBps: 0, diskBytes: 250_000_000, diskAllocBytes: 1_000_000_000, netInBps: 0, netOutBps: 0 },
      { time: 1_793_016_300, cpuPct: 42.5, memBytes: 1_073_741_824, diskReadBps: 1001, diskWriteBps: 2000, diskBytes: 500_000_000, diskAllocBytes: 1_000_000_000, netInBps: 1_000_000, netOutBps: 500_000 },
    ]);
  });

  it('garde les null par champ (bucket partiel) et arrondit les valeurs', () => {
    const points = vmMetricsRowsToPoints([
      { t: '2026-10-26T12:00:00Z', cpu_pct: null, mem_bytes: 100.6, disk_read_bps: null, disk_write_bps: null, net_in_bps: null, net_out_bps: null, disk_bytes: null, disk_alloc_bytes: null },
    ]);
    expect(points).toEqual([{ time: 1_793_016_000, cpuPct: null, memBytes: 101, diskReadBps: null, diskWriteBps: null, diskBytes: null, diskAllocBytes: null, netInBps: null, netOutBps: null }]);
  });

  it('null sur les champs I/O = données pré-extension du poller (le graphe démarre plus tard, pas à 0)', () => {
    const points = vmMetricsRowsToPoints([
      // ancienne ligne (avant l'extension) : seuls cpu_pct/mem_bytes présents → AVG NULL sur les autres
      { t: '2026-10-26T12:00:00Z', cpu_pct: 5, mem_bytes: 10, disk_read_bps: null, disk_write_bps: null, net_in_bps: null, net_out_bps: null, disk_bytes: null, disk_alloc_bytes: null },
      // nouvelle ligne : tous les champs
      { t: '2026-10-26T12:05:00Z', cpu_pct: 7, mem_bytes: 20, disk_read_bps: 999.4, disk_write_bps: 1, net_in_bps: 2, net_out_bps: 3, disk_bytes: 777, disk_alloc_bytes: 999 },
    ]);
    expect(points[0].diskReadBps).toBeNull();
    expect(points[1].diskReadBps).toBe(999);
    // occupation disque : même règle (null tant que l'agent / le champ disk n'a rien fourni)
    expect(points[0].diskBytes).toBeNull();
    expect(points[1].diskBytes).toBe(777);
    expect(points[1].diskAllocBytes).toBe(999);
  });

  it('écarter les buckets sans horodatage valide (t null / invalide)', () => {
    const points = vmMetricsRowsToPoints([
      { t: null, cpu_pct: 5, mem_bytes: 1, disk_read_bps: 1, disk_write_bps: 1, net_in_bps: 1, net_out_bps: 1, disk_bytes: 1, disk_alloc_bytes: 1 },
      { t: 'not-a-date', cpu_pct: 5, mem_bytes: 1, disk_read_bps: 1, disk_write_bps: 1, net_in_bps: 1, net_out_bps: 1, disk_bytes: 1, disk_alloc_bytes: 1 },
      { t: '2026-10-26T12:00:00Z', cpu_pct: 5, mem_bytes: 1, disk_read_bps: 1, disk_write_bps: 1, net_in_bps: 1, net_out_bps: 1, disk_bytes: 1, disk_alloc_bytes: 1 },
    ]);
    expect(points).toHaveLength(1);
  });

  it('ne mute pas le tableau d’entrée', () => {
    const rows = [
      { t: '2026-10-26T12:05:00Z', cpu_pct: 1, mem_bytes: 1, disk_read_bps: 1, disk_write_bps: 1, net_in_bps: 1, net_out_bps: 1, disk_bytes: 1, disk_alloc_bytes: 1 },
      { t: '2026-10-26T12:00:00Z', cpu_pct: 2, mem_bytes: 2, disk_read_bps: 2, disk_write_bps: 2, net_in_bps: 2, net_out_bps: 2, disk_bytes: 2, disk_alloc_bytes: 2 },
    ];
    const before = rows.map((r) => r.t);
    vmMetricsRowsToPoints(rows);
    expect(rows.map((r) => r.t)).toEqual(before);
  });
});
