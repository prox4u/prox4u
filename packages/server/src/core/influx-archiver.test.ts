import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
): AppContext {
  return {
    config: {
      mock: false,
      influx: {
        archiveIntervalMs: 6 * 3_600_000,
        archiveAgeMs: 90 * 86_400_000,
        archiveDir,
      },
    },
    logger,
    influx: {
      enabled: true,
      aggDb: 'consolidated',
      querySqlChunked,
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
        if (sql.includes('FROM node_metrics')) return rows;
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
        if (sql.includes('FROM node_metrics')) {
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
});
