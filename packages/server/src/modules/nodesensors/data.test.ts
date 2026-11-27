import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../core/poller.js';
import { fetchSensorAlarmData } from './data.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type SqlRow = Record<string, string | number | null>;

/**
 * AppContext mock : `querySql` renvoie les lignes selon la table interrogée
 * (FROM <table>) — permet de tester l'isolation par section (une table qui
 * lève ne fait pas perdre les autres).
 */
function makeCtx(
  tables: Record<string, SqlRow[] | Error>,
  queries: string[] = [],
): AppContext {
  return {
    config: { authFile: '/tmp/auth.json' } as AppContext['config'],
    endpoints: [],
    logger,
    influx: {
      enabled: true,
      rawDb: 'raw',
      querySql: vi.fn(async (_db: string, sql: string) => {
        queries.push(sql);
        for (const [table, rows] of Object.entries(tables)) {
          if (sql.includes(`FROM ${table}`)) {
            if (rows instanceof Error) throw rows;
            // La requête « unités en échec » filtre (active='failed' OR load='error')
            // côté DB — le mock applique le même filtre (la requête « toutes » ne le fait pas).
            if (table === 'systemd_units' && sql.includes("active = 'failed'")) {
              return rows.filter((r) => r.active === 'failed' || r.load === 'error');
            }
            return rows;
          }
        }
        return [];
      }),
    } as unknown as AppContext['influx'],
    auth: {} as AppContext['auth'],
    userConfig: {} as AppContext['userConfig'],
    hub: {} as AppContext['hub'],
  };
}

describe('fetchSensorAlarmData', () => {
  it('InfluxDB désactivé → données vides (pas d\'erreur, pas de query)', async () => {
    const ctx = {
      config: { authFile: '/tmp/auth.json' } as AppContext['config'],
      endpoints: [],
      logger,
      influx: { enabled: false, rawDb: 'raw', querySql: vi.fn() } as unknown as AppContext['influx'],
      auth: {} as AppContext['auth'],
      userConfig: {} as AppContext['userConfig'],
      hub: {} as AppContext['hub'],
    };
    const data = await fetchSensorAlarmData(ctx);
    expect(data).toEqual({ smart: [], sensors: [], zfs: [], zfsPools: [], failedUnits: [], units: [] });
    expect(ctx.influx.querySql).not.toHaveBeenCalled();
  });

  it('6 requêtes : smart, sensors, zfs (ARC), zpool (pools), systemd_units (échec), systemd_units (toutes)', async () => {
    const queries: string[] = [];
    const ctx = makeCtx({
      smart_device: [{ node: 'n1', device: '/dev/sda', model: 'WDC', serial_no: 'SN', health_ok: true, temp_c: 35, power_on_hours: 1, power_cycle_count: 1, reallocated_sectors_count: 0, pending_sector_count: 0, uncorrectable_sector_count: 0, udma_crc_errors: 0, percentage_used: null, available_spare: null, critical_warning: null, time: '2026-11-27T12:00:00Z' }],
      sensors: [{ node: 'n1', chip: 'cpu', feature: 'edge', temp_input: 50, temp_crit: 105, fan_input: null, in_input: null, time: '2026-11-27T12:00:00Z' }],
      zfs: [{ node: 'n1', arcstats_hits: 100, arcstats_misses: 5, arcstats_size: 1024, time: '2026-11-27T12:00:00Z' }],
      zpool: [{ node: 'n1', pool: 'rpool', state: 'DEGRADED', time: '2026-11-27T12:00:00Z' }],
      systemd_units: [
        { node: 'n1', name: 'ok.service', active: 'active', sub: 'running', load: 'loaded', time: '2026-11-27T12:00:00Z' },
        { node: 'n1', name: 'bad.service', active: 'failed', sub: 'failed', load: 'loaded', time: '2026-11-27T12:00:00Z' },
      ],
    }, queries);
    const data = await fetchSensorAlarmData(ctx);
    // 6 requêtes (les 2 systemd_units sont distinguées par le WHERE)
    expect(queries).toHaveLength(6);
    expect(queries.filter((q) => q.includes('FROM systemd_units'))).toHaveLength(2);
    expect(queries.some((q) => q.includes('FROM zpool'))).toBe(true);
    // contenu
    expect(data.smart).toHaveLength(1);
    expect(data.smart[0]).toMatchObject({ node: 'n1', device: '/dev/sda', healthOk: true, tempC: 35 });
    expect(data.sensors).toHaveLength(1);
    expect(data.sensors[0]).toMatchObject({ chip: 'cpu', feature: 'edge', tempInput: 50, tempCrit: 105 });
    expect(data.zfs).toHaveLength(1);
    expect(data.zfs[0]).toMatchObject({ node: 'n1', arcHits: 100 });
    expect(data.zfsPools).toHaveLength(1);
    expect(data.zfsPools[0]).toMatchObject({ node: 'n1', poolName: 'rpool', poolState: 'DEGRADED' });
    // failedUnits : SEULES les unités failed/error (le filtre est dans le WHERE)
    expect(data.failedUnits).toHaveLength(1);
    expect(data.failedUnits[0].name).toBe('bad.service');
    // units : TOUTES les unités (sans filtre)
    expect(data.units).toHaveLength(2);
    expect(data.units.map((u) => u.name).sort()).toEqual(['bad.service', 'ok.service']);
  });

  it('dernier point par cible (dédoublonnage) — la 1re ligne (time DESC) prime', async () => {
    const ctx = makeCtx({
      smart_device: [
        { node: 'n1', device: '/dev/sda', model: null, serial_no: null, health_ok: true, temp_c: 40, power_on_hours: null, power_cycle_count: null, reallocated_sectors_count: null, pending_sector_count: null, uncorrectable_sector_count: null, udma_crc_errors: null, percentage_used: null, available_spare: null, critical_warning: null, time: '2026-11-27T12:00:10Z' },
        { node: 'n1', device: '/dev/sda', model: null, serial_no: null, health_ok: true, temp_c: 30, power_on_hours: null, power_cycle_count: null, reallocated_sectors_count: null, pending_sector_count: null, uncorrectable_sector_count: null, udma_crc_errors: null, percentage_used: null, available_spare: null, critical_warning: null, time: '2026-11-27T12:00:00Z' },
      ],
    });
    const data = await fetchSensorAlarmData(ctx);
    expect(data.smart).toHaveLength(1);
    expect(data.smart[0].tempC).toBe(40); // dernier point
  });

  it('isolation par section : une table qui lève ne fait pas perdre les autres', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ctx = makeCtx({
      smart_device: new Error('table absente'),
      sensors: [{ node: 'n1', chip: 'cpu', feature: 'edge', temp_input: 50, temp_crit: 105, fan_input: null, in_input: null, time: '2026-11-27T12:00:00Z' }],
      zpool: new Error('table absente'),
      systemd_units: new Error('table absente'),
    });
    const data = await fetchSensorAlarmData(ctx);
    expect(data.smart).toEqual([]); // SMART en échec → vide
    expect(data.sensors).toHaveLength(1); // capteurs OK
    expect(data.zfsPools).toEqual([]);
    expect(data.failedUnits).toEqual([]);
    expect(data.units).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4); // smart + zpool + systemd_units ×2 (échec + toutes)
    warn.mockRestore();
  });

  it('health_ok tri-state : NULL → null (inconnue, pas un échec)', async () => {
    const ctx = makeCtx({
      smart_device: [
        { node: 'n1', device: '/dev/sda', model: null, serial_no: null, health_ok: null, temp_c: 35, power_on_hours: null, power_cycle_count: null, reallocated_sectors_count: null, pending_sector_count: null, uncorrectable_sector_count: null, udma_crc_errors: null, percentage_used: null, available_spare: null, critical_warning: null, time: '2026-11-27T12:00:00Z' },
        { node: 'n1', device: '/dev/sdb', model: null, serial_no: null, health_ok: false, temp_c: 35, power_on_hours: null, power_cycle_count: null, reallocated_sectors_count: null, pending_sector_count: null, uncorrectable_sector_count: null, udma_crc_errors: null, percentage_used: null, available_spare: null, critical_warning: null, time: '2026-11-27T12:00:00Z' },
      ],
    });
    const data = await fetchSensorAlarmData(ctx);
    expect(data.smart.find((d) => d.device === '/dev/sda')!.healthOk).toBeNull();
    expect(data.smart.find((d) => d.device === '/dev/sdb')!.healthOk).toBe(false);
  });
});
