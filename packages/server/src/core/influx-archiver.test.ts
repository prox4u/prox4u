import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from './poller.js';
import type { SqlRow } from './influx.js';
import { InfluxArchiver } from './influx-archiver.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Chemin de l'état (même calcul que l'archiver : <repoRoot>/data/archive-state.json). */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const STATE_FILE = path.join(repoRoot, 'data/archive-state.json');

function makeCtx(
  archiveDir: string,
  querySqlChunked: (db: string, buildSql: (f: string, t: string) => string, from: number, to: number, opts?: { chunkDays?: number }) => Promise<SqlRow[]>,
  extraInflux: Record<string, unknown> = {},
  backupDir?: string,
): AppContext {
  return {
    config: {
      mock: false,
      influx: {
        archiveIntervalMs: 6 * 3_600_000,
        archiveAgeMs: 90 * 86_400_000,
        archiveDir,
        backupDir: backupDir ?? path.join(archiveDir, 'backups'),
      },
    },
    logger,
    influx: {
      enabled: true,
      aggDb: 'consolidated',
      querySqlChunked,
      ...extraInflux,
    },
  } as unknown as AppContext;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'influx-archive-'));
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
});

afterEach(() => {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
  rmSync(dir, { recursive: true, force: true });
});

describe('InfluxArchiver', () => {
  it('exporte les lignes consolidated en CSV 1/table/jour (groupement par jour UTC)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tA = now - 100 * 86_400; // jour A (dans la fenêtre [365j, 90j])
    const tB = now - 101 * 86_400; // jour B
    const dayA = new Date(tA * 1000).toISOString().slice(0, 10);
    const dayB = new Date(tB * 1000).toISOString().slice(0, 10);
    const rows: SqlRow[] = [
      { time: tA, cpu_pct: 10, node: 'pve1' },
      { time: tA + 3600, cpu_pct: 12, node: 'pve1' },
      { time: tB, cpu_pct: 20, node: 'pve1' },
    ];
    const archiver = new InfluxArchiver(
      makeCtx(dir, async (_db, buildSql) => {
        const sql = buildSql('x', 'y');
        if (sql.includes('"node_metrics"')) return rows;
        return []; // autres tables : vides
      }),
    );
    await (archiver as unknown as { run: () => Promise<void> }).run();

    const fileA = path.join(dir, `node_metrics-${dayA}.csv`);
    const fileB = path.join(dir, `node_metrics-${dayB}.csv`);
    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);
    const csvA = readFileSync(fileA, 'utf8').trim().split('\n');
    expect(csvA[0]).toBe('time,cpu_pct,node'); // en-tête
    expect(csvA.length).toBe(3); // 2 lignes + en-tête
    const csvB = readFileSync(fileB, 'utf8').trim().split('\n');
    expect(csvB.length).toBe(2); // 1 ligne + en-tête
    // état avancé jusqu'au cutoff (now - 90 j) — tolérance 2 s (franchise de seconde)
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { lastArchivedTs: number };
    expect(Math.abs(state.lastArchivedTs - (now - 90 * 86_400))).toBeLessThanOrEqual(2);
  });

  it('ignore une table absente (pas d’échec, état avance quand même)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const archiver = new InfluxArchiver(
      makeCtx(dir, async (_db, buildSql) => {
        const sql = buildSql('x', 'y');
        if (sql.includes('"node_metrics"')) {
          throw new Error('InfluxDB query_sql consolidated → HTTP 400: cannot find table node_metrics');
        }
        return [{ time: now - 100 * 86_400, f: 1 }];
      }),
    );
    await (archiver as unknown as { run: () => Promise<void> }).run(); // ne doit pas lever
    expect(existsSync(STATE_FILE)).toBe(true);
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { lastArchivedTs: number };
    expect(Math.abs(state.lastArchivedTs - (now - 90 * 86_400))).toBeLessThanOrEqual(2);
  });

  it('erreur autre que « table absente » : état ne avance pas', async () => {
    const archiver = new InfluxArchiver(
      makeCtx(dir, async () => {
        throw new Error('InfluxDB query_sql consolidated → HTTP 500: boom');
      }),
    );
    await (archiver as unknown as { run: () => Promise<void> }).run(); // catch interne → pas de throw
    expect(existsSync(STATE_FILE)).toBe(false); // writeState non appelé
  });

  it('reprend de lastArchivedTs : rien de nouveau → pas de requête', async () => {
    const now = Math.floor(Date.now() / 1000);
    // état pré-écrit PLUS RÉCENT que le cutoff (89 j < 90 j) → from > to → rien à archiver
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ lastArchivedTs: now - 89 * 86_400 }));
    let called = 0;
    const archiver = new InfluxArchiver(
      makeCtx(dir, async () => {
        called++;
        return [];
      }),
    );
    await (archiver as unknown as { run: () => Promise<void> }).run();
    expect(called).toBe(0);
  });

  // ---------- Sauvegarde / restauration ----------

  it('backupDatabase : ZIP (1 CSV/table + manifest.json) dans backupDir', async () => {
    const t0 = 1767225600; // 2026-01-01T00:00:00Z
    const iso = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
    const rows: SqlRow[] = [
      { time: iso(t0), node: 'n1', usage: 1.5, label: 'a,b' },
      { time: iso(t0 + 300), node: 'n1', usage: 2.5, label: null },
    ];
    const backupDir = path.join(dir, 'backups');
    const archiver = new InfluxArchiver(
      makeCtx(
        dir,
        async (_db, buildSql) => (buildSql('x', 'y').includes('"cpu"') ? rows : []),
        {
          listTables: async () => ['cpu', 'empty_t'],
          tableSchema: async (_db: string, table: string) =>
            table === 'cpu'
              ? { time: 'time', tags: ['node'], fields: [{ name: 'usage', type: 'float64' }, { name: 'label', type: 'utf8' }] }
              : { time: 'time', tags: [], fields: [{ name: 'f', type: 'float64' }] },
          querySql: async (_db: string, sql: string) =>
            sql.includes('"cpu"') ? [{ min: rows[0].time, max: rows[1].time }] : [{ min: null, max: null }],
          getServerInfo: async () => ({ version: '3.11.5', raw: {} }),
        },
        backupDir,
      ),
    );
    const r = await archiver.backupDatabase('raw');
    expect(r.tables).toEqual([
      { table: 'cpu', rows: 2 },
      { table: 'empty_t', rows: 0 }, // table vide : dans le manifeste, sans CSV
    ]);
    expect(r.totalRows).toBe(2);
    expect(r.file).toMatch(/^backup-raw-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/);
    const full = path.join(backupDir, r.file);
    expect(existsSync(full)).toBe(true);
    const zip = unzipSync(readFileSync(full));
    expect(Object.keys(zip).sort()).toEqual(['cpu.csv', 'manifest.json']); // empty_t sans CSV
    const m = JSON.parse(strFromU8(zip['manifest.json'])) as {
      db: string;
      influxVersion: string | null;
      tables: Array<{ name: string; rows: number; time: string; tags: string[]; fields: unknown[] }>;
    };
    expect(m.db).toBe('raw');
    expect(m.influxVersion).toBe('3.11.5');
    expect(m.tables).toEqual([
      { name: 'cpu', rows: 2, time: 'time', tags: ['node'], fields: [{ name: 'usage', type: 'float64' }, { name: 'label', type: 'utf8' }] },
      { name: 'empty_t', rows: 0, time: 'time', tags: [], fields: [{ name: 'f', type: 'float64' }] },
    ]);
    const csv = strFromU8(zip['cpu.csv']);
    expect(csv.split('\n')[0]).toBe('time,node,usage,label');
    expect(csv.split('\n')[1]).toContain('"a,b"'); // échappement CSV (virgule)
    expect(csv.split('\n')[2]).toBe(`${iso(t0 + 300)},n1,2.5,`); // label null → vide
  });

  it('listBackups : manifestes lus + tri décroissant + non-backup ignoré', async () => {
    const backupDir = path.join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const mk = (file: string, db: string, createdAt: string, rows: number) => {
      const manifest = { db, createdAt, influxVersion: null, tables: [{ name: 't', rows, time: 'time', tags: [], fields: [] }] };
      writeFileSync(path.join(backupDir, file), Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) })));
    };
    mk('backup-raw-2026-11-25-190000.zip', 'raw', '2026-11-25T19:00:00.000Z', 10);
    mk('backup-raw-2026-11-24-100000.zip', 'raw', '2026-11-24T10:00:00.000Z', 5);
    writeFileSync(path.join(backupDir, 'export-x.zip'), 'pas une sauvegarde');
    const archiver = new InfluxArchiver(makeCtx(dir, async () => [], {}, backupDir));
    const list = archiver.listBackups();
    expect(list.map((b) => b.file)).toEqual(['backup-raw-2026-11-25-190000.zip', 'backup-raw-2026-11-24-100000.zip']);
    expect(list[0]).toMatchObject({ db: 'raw', tables: 1, rows: 10 });
  });

  it('listBackups : dossier absent → []', async () => {
    const archiver = new InfluxArchiver(makeCtx(dir, async () => [], {}, path.join(dir, 'absent')));
    expect(archiver.listBackups()).toEqual([]);
  });

  it('restoreBackup : round-trip backup → restore (createDatabase + createTable + line-protocol)', async () => {
    const t0 = 1767225600; // 2026-01-01T00:00:00Z
    const iso = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
    const rows: SqlRow[] = [
      { time: iso(t0), node: 'n1', usage: 1.5, label: 'a,b' },
      { time: iso(t0 + 300), node: 'n1', usage: 2.5, label: null },
    ];
    const backupDir = path.join(dir, 'backups');
    const archiver = new InfluxArchiver(
      makeCtx(
        dir,
        async (_db, buildSql) => (buildSql('x', 'y').includes('"cpu"') ? rows : []),
        {
          listTables: async () => ['cpu'],
          tableSchema: async () => ({ time: 'time', tags: ['node'], fields: [{ name: 'usage', type: 'float64' }, { name: 'label', type: 'utf8' }] }),
          querySql: async (_db: string, sql: string) =>
            sql.includes('"cpu"') ? [{ min: rows[0].time, max: rows[1].time }] : [{ min: null, max: null }],
        },
        backupDir,
      ),
    );
    const r = await archiver.backupDatabase('raw');

    // Restauration : mock frais qui capture createDatabase / createTable / writeLp.
    const calls: { createDb: string[]; createTable: Array<[string, string, string[], unknown[]]>; lp: string[][] } = {
      createDb: [],
      createTable: [],
      lp: [],
    };
    const archiver2 = new InfluxArchiver(
      makeCtx(
        dir,
        async () => [],
        {
          createDatabase: async (db: string) => {
            calls.createDb.push(db);
          },
          createTable: async (db: string, table: string, tags: string[], fields: unknown[]) => {
            calls.createTable.push([db, table, tags, fields]);
          },
          writeLp: async (_db: string, lines: string[]) => {
            calls.lp.push([...lines]);
          },
        },
        backupDir,
      ),
    );
    const res = await archiver2.restoreBackup(r.file);
    expect(res.db).toBe('raw');
    expect(res.tables).toEqual([{ table: 'cpu', rows: 2, written: 2, skipped: 0 }]);
    expect(calls.createDb).toEqual(['raw']);
    expect(calls.createTable).toEqual([
      ['raw', 'cpu', ['node'], [{ name: 'usage', type: 'float64' }, { name: 'label', type: 'utf8' }]],
    ]);
    expect(calls.lp).toHaveLength(1);
    expect(calls.lp[0]).toEqual([
      `cpu,node=n1 usage=1.5,label="a,b" ${t0}`, // string avec virgule + tag
      `cpu,node=n1 usage=2.5 ${t0 + 300}`, // label vide → champ omis
    ]);
  });

  it('restoreBackup : champ absent → skipped (line-protocol exige ≥ 1 champ)', async () => {
    const backupDir = path.join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const file = 'backup-t-2026-01-01-000000.zip';
    const manifest = {
      db: 't',
      createdAt: '2026-01-01T00:00:00.000Z',
      influxVersion: null,
      tables: [{ name: 't1', rows: 2, time: 'time', tags: [], fields: [{ name: 'f', type: 'float64' }] }],
    };
    const csv = 'time,f\n2026-01-01T00:00:00Z,\n2026-01-01T00:00:01Z,42\n';
    writeFileSync(path.join(backupDir, file), Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 't1.csv': strToU8(csv) })));
    const lp: string[][] = [];
    const archiver = new InfluxArchiver(
      makeCtx(
        dir,
        async () => [],
        {
          createDatabase: async () => undefined,
          createTable: async () => undefined,
          writeLp: async (_db: string, lines: string[]) => {
            lp.push([...lines]);
          },
        },
        backupDir,
      ),
    );
    const res = await archiver.restoreBackup(file);
    expect(res.tables).toEqual([{ table: 't1', rows: 2, written: 1, skipped: 1 }]);
    expect(lp[0]).toEqual([`t1 f=42 ${1767225601}`]);
  });

  it('restoreBackup : fichier absent → erreur « backup not found »', async () => {
    const archiver = new InfluxArchiver(makeCtx(dir, async () => [], {}, path.join(dir, 'backups')));
    await expect(archiver.restoreBackup('backup-x.zip')).rejects.toThrow(/backup not found/);
  });

  // ---------- Export Parquet (GitHub #15) ----------

  it('tableParquet : 1 tranche → <table>.parquet (octets bruts API)', async () => {
    const pq = strToU8('PAR1node');
    const archiver = new InfluxArchiver(
      makeCtx(dir, async () => [], {
        querySqlChunkedRaw: async (_db: string, _b: (f: string, t: string) => string, from: number, to: number) => [
          { from, to, data: pq },
        ],
      }),
    );
    const from = 1767225600; // 2026-01-01
    const r = await archiver.tableParquet('consolidated', 'node_metrics', from, from + 86_400);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].name).toBe('node_metrics.parquet');
    expect(r.files[0].data).toEqual(pq);
  });

  it('tableParquet : N tranches → <table>-<from>_<to>.parquet par tranche', async () => {
    const from = 1767225600; // 2026-01-01
    const d30 = 30 * 86_400;
    const to = from + 61 * 86_400; // 61 j → 2 tranches (30 j + 31 j)
    const archiver = new InfluxArchiver(
      makeCtx(dir, async () => [], {
        querySqlChunkedRaw: async () => [
          { from, to: from + d30, data: strToU8('PAR1a') },
          { from: from + d30, to, data: strToU8('PAR1b') },
        ],
      }),
    );
    const r = await archiver.tableParquet('consolidated', 'node_metrics', from, to);
    expect(r.files).toHaveLength(2);
    const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
    expect(r.files[0].name).toBe(`node_metrics-${day(from)}_${day(from + d30)}.parquet`);
    expect(r.files[1].name).toBe(`node_metrics-${day(from + d30)}_${day(to)}.parquet`);
  });

  it('tableParquet : table absente (0 tranche) → 0 fichier', async () => {
    const archiver = new InfluxArchiver(
      makeCtx(dir, async () => [], { querySqlChunkedRaw: async () => [] }),
    );
    const r = await archiver.tableParquet('consolidated', 'node_metrics', 1000, 2000);
    expect(r.files).toEqual([]);
  });

  it('buildTablesZip format=parquet : ZIP avec .parquet + exports rows:null / files', async () => {
    const from = 1767225600;
    const archiver = new InfluxArchiver(
      makeCtx(dir, async () => [], {
        querySqlChunkedRaw: async (_db: string, _b: (f: string, t: string) => string, f: number, t: number) => [
          { from: f, to: t, data: strToU8('PAR1node') },
        ],
      }),
    );
    const r = await archiver.buildTablesZip(['node_metrics'], from, from + 86_400, 'parquet');
    expect(r.exports).toEqual([{ table: 'node_metrics', rows: null, files: 1 }]);
    const zip = unzipSync(Buffer.from(r.data));
    expect(Object.keys(zip)).toEqual(['node_metrics.parquet']);
    expect(strFromU8(zip['node_metrics.parquet'])).toBe('PAR1node');
  });

  it('buildTablesZip format=csv (défaut) : exports rows:number / files (comportement inchangé)', async () => {
    const from = 1767225600;
    const archiver = new InfluxArchiver(
      makeCtx(dir, async () => [{ time: '2026-01-01T00:00:00Z', cpu: 1 }]),
    );
    const r = await archiver.buildTablesZip(['node_metrics'], from, from + 86_400);
    expect(r.exports).toEqual([{ table: 'node_metrics', rows: 1, files: 1 }]);
    const zip = unzipSync(Buffer.from(r.data));
    expect(Object.keys(zip)).toEqual(['node_metrics.csv']);
  });
});
