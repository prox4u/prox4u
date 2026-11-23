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

  /**
   * Noyau d'un cycle d'archivage : archive [lastArchivedTs, cutoff) et avance
   * l'état. Renvoie la plage archivée (null si rien de nouveau à archiver).
   * Ne gère PAS le guard `running` ni le logging — c'est au caller (run/runNow).
   */
  private async doRun(): Promise<{ from: number; to: number } | null> {
    const now = Math.floor(Date.now() / 1000);
    const to = now - Math.floor(this.ctx.config.influx.archiveAgeMs / 1000); // cutoff : on n'archive que l'ancien
    const from = this.lastArchivedTs;
    if (from >= to) return null; // rien de nouveau à archiver
    await this.archiveRange(from, to);
    this.lastArchivedTs = to;
    this.writeState();
    return { from, to };
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.doRun();
      if (r) this.ctx.logger.info(`archiver : ${r.from} → ${r.to} archivé (CSV dans ${this.ctx.config.influx.archiveDir})`);
    } catch (err) {
      // lastArchivedTs n'avance pas → reprise au cycle suivant
      this.ctx.logger.warn(`archiver : cycle en échec (${(err as Error).message}) — reprise au prochain cycle`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Action manuelle : cycle d'archivage IMMÉDIAT (POST /api/influxdb/actions/archive/run).
   * Renvoie la plage archivée, ou null si un cycle est déjà en cours / rien à archiver.
   * Lève si l'archivage échoue (le caller renvoie 500).
   */
  async runNow(): Promise<{ from: number; to: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.doRun();
    } finally {
      this.running = false;
    }
  }

  /**
   * Action manuelle : réinitialise l'état d'archivage (POST /api/influxdb/actions/archive/reset)
   * → re-archivage depuis 1 an (FIRST_RUN_LOOKBACK_SEC). Renvoie la nouvelle borne.
   */
  resetState(): number {
    this.lastArchivedTs = Math.floor(Date.now() / 1000) - FIRST_RUN_LOOKBACK_SEC;
    this.writeState();
    return this.lastArchivedTs;
  }

  /**
   * Export ad-hoc d'une table de `consolidated` sur [from, to) vers un CSV
   * (POST /api/influxdb/actions/export). Renvoie le chemin du fichier + nb de lignes
   * (file='' si aucune ligne). `table` est validée par le caller.
   */
  async exportTable(table: string, from: number, to: number): Promise<{ file: string; rows: number }> {
    const influx = this.ctx.influx;
    mkdirSync(this.ctx.config.influx.archiveDir, { recursive: true });
    const rows = await influx.querySqlChunked<SqlRow>(
      influx.aggDb,
      (_f, _t) => `SELECT * FROM ${table} WHERE time >= '${_f}' AND time < '${_t}' ORDER BY time`,
      from,
      to,
      { chunkDays: ARCHIVE_CHUNK_DAYS },
    );
    if (rows.length === 0) return { file: '', rows: 0 };
    const columns = Object.keys(rows[0]);
    const lines = [columns.join(',')];
    for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
    const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
    const file = path.join(this.ctx.config.influx.archiveDir, `export-${table}-${day(from)}_${day(to)}.csv`);
    writeFileSync(file, lines.join('\n') + '\n');
    return { file, rows: rows.length };
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
