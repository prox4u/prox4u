import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { influxTsToUnix, type SqlRow } from './influx.js';
import type { AppContext } from './poller.js';

/**
 * Archivage InfluxDB 3 Core (P5, plan-limites-influxdb3.md).
 *
 * `consolidated` a une rétention infinie → croissance sans borne (pas de DELETE en
 * Core). L'archiver exporte périodiquement les lignes de `consolidated` PLUS ANCIENTS
 * que `archiveAgeMs` vers des fichiers CSV (1 / table / jour) dans `archiveDir`, pour
 * un stockage long terme interrogeable hors InfluxDB (DuckDB/Excel/csvtool).
 *
 * - même pattern que le consolidateur : timer + état `data/archive-state.json`
 *   (tmp+rename) + reprise ; `lastArchivedTs` n'avance que si TOUTES les tables
 *   sont archivées avec succès ;
 * - requêtes chunkées (30 j) → toujours sous --query-file-limit ;
 * - table absente / champ absent → ignorée (pas d'échec) ;
 * - zéro dépendance : CSV (pas de writer Parquet binaire).
 */

/** Tables écrites par le consolidateur dans `consolidated` (liste de référence). */
const ARCHIVE_TABLES = [
  'node_metrics',
  'node_net',
  'storage_metrics',
  'vm_metrics',
  'vm_fs',
  'datastore_metrics',
  'smart_device',
  'sensors',
  'zfs',
  'systemd_units',
] as const;

/** 1ʳᵉ exécution : on remonte au plus à 1 an (borne le backfill initial), en secondes. */
const FIRST_RUN_LOOKBACK_SEC = 365 * 86_400;
/** Tranche de requête (jours) — reste sous --query-file-limit. */
const ARCHIVE_CHUNK_DAYS = 30;

interface State {
  /** borne haute archivée (exclusive), unix seconds */
  lastArchivedTs: number;
}

/** Échappement CSV minimal (guillemets, virgules, retours à la ligne). */
function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Convertit la valeur `time` d'une ligne en jour YYYY-MM-DD (UTC). */
function dayOf(row: SqlRow): string | null {
  const t = row.time;
  const ts = typeof t === 'number' ? t : influxTsToUnix(typeof t === 'string' ? t : null);
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export class InfluxArchiver {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastArchivedTs: number;
  private stateFile: string;

  constructor(private ctx: AppContext) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../..');
    // hors de data/influxdb/ (chown du conteneur) — à côté de consolidation-state.json
    this.stateFile = path.join(repoRoot, 'data/archive-state.json');
    this.lastArchivedTs = this.readState() ?? Math.floor(Date.now() / 1000) - FIRST_RUN_LOOKBACK_SEC;
  }

  start(): void {
    const { influx, config } = this.ctx;
    if (!influx.enabled || config.mock) return;
    this.ctx.logger.info(
      `archiver InfluxDB actif (intervalle ${Math.round(config.influx.archiveIntervalMs / 3_600_000)} h, ` +
        `âge archivé ${Math.round(config.influx.archiveAgeMs / 86_400_000)} j, reprise à t=${this.lastArchivedTs})`,
    );
    void this.run();
    this.timer = setInterval(() => void this.run(), config.influx.archiveIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readState(): number | null {
    try {
      if (!existsSync(this.stateFile)) return null;
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as State;
      return Number.isInteger(s.lastArchivedTs) && s.lastArchivedTs > 0 ? s.lastArchivedTs : null;
    } catch {
      return null;
    }
  }

  private writeState(): void {
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ lastArchivedTs: this.lastArchivedTs }));
      renameSync(tmp, this.stateFile);
    } catch (err) {
      this.ctx.logger.warn(`archiver : état non sauvegardé (${(err as Error).message})`);
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const to = now - Math.floor(this.ctx.config.influx.archiveAgeMs / 1000); // cutoff : on n'archive que l'ancien
      const from = this.lastArchivedTs;
      if (from >= to) return; // rien de nouveau à archiver
      await this.archiveRange(from, to);
      this.lastArchivedTs = to;
      this.writeState();
      this.ctx.logger.info(`archiver : ${from} → ${to} archivé (CSV dans ${this.ctx.config.influx.archiveDir})`);
    } catch (err) {
      // lastArchivedTs n'avance pas → reprise au cycle suivant
      this.ctx.logger.warn(`archiver : cycle en échec (${(err as Error).message}) — reprise au prochain cycle`);
    } finally {
      this.running = false;
    }
  }

  /** Archive [from, to) de `consolidated` vers CSV (1 fichier / table / jour). */
  private async archiveRange(from: number, to: number): Promise<void> {
    const influx = this.ctx.influx;
    mkdirSync(this.ctx.config.influx.archiveDir, { recursive: true });
    for (const table of ARCHIVE_TABLES) {
      // Chunké (30 j) → chaque requête reste sous --query-file-limit.
      let rows: SqlRow[];
      try {
        rows = await influx.querySqlChunked<SqlRow>(
          influx.aggDb,
          (_f, _t) => `SELECT * FROM ${table} WHERE time >= '${_f}' AND time < '${_t}' ORDER BY time`,
          from,
          to,
          { chunkDays: ARCHIVE_CHUNK_DAYS },
        );
      } catch (err) {
        // table absente / champ absent → ignorée ; autre erreur → propagée (reprise)
        if (!/cannot find table|does not exist|No field named/i.test((err as Error).message ?? '')) throw err;
        continue;
      }
      if (rows.length === 0) continue;
      // Regroupement par jour (UTC) → 1 CSV / table / jour.
      const byDay = new Map<string, SqlRow[]>();
      for (const r of rows) {
        const day = dayOf(r);
        if (!day) continue;
        const arr = byDay.get(day);
        if (arr) arr.push(r);
        else byDay.set(day, [r]);
      }
      const columns = Object.keys(rows[0]);
      for (const [day, dayRows] of byDay) {
        const lines = [columns.join(',')];
        for (const r of dayRows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
        const file = path.join(this.ctx.config.influx.archiveDir, `${table}-${day}.csv`);
        writeFileSync(file, lines.join('\n') + '\n');
      }
    }
  }
}
