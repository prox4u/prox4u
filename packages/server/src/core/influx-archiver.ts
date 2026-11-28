import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { escapeFieldString, escapeTag, influxTsToUnix, type InfluxClient, type InfluxFieldType, type SqlRow } from './influx.js';
import { shardClientsWithIds } from './influx-shards.js';
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
 * - CSV (pas de writer Parquet binaire) ; seule dep : `fflate` (zéro dep
 *   transitive) pour l'export ad-hoc multi-tables → ZIP.
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

/**
 * Identifiant SQL DuckDB entre guillemets (guillemets internes doublés).
 * Requis pour les noms de tables avec tiret (ex. `proxmox-support`) —
 * un identifiant brut avec `-` casse le parser.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Convertit la valeur `time` d'une ligne en jour YYYY-MM-DD (UTC). */
function dayOf(row: SqlRow): string | null {
  const t = row.time;
  const ts = typeof t === 'number' ? t : influxTsToUnix(typeof t === 'string' ? t : null);
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Entrée du manifeste de sauvegarde : schéma complet (time + tags + champs typés). */
interface BackupTableManifest {
  name: string;
  rows: number;
  time: string;
  tags: string[];
  fields: Array<{ name: string; type: InfluxFieldType }>;
}

/** manifest.json d'une sauvegarde (ZIP) — suffit à la restauration. */
interface BackupManifest {
  db: string;
  createdAt: string;
  influxVersion: string | null;
  tables: BackupTableManifest[];
}

/**
 * Parseur CSV RFC4180 minimal (champ cité : virgules, guillemets doublés,
 * retours à la ligne). Compatible avec l'échappement de csvEscape.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
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
   * État de l'archivage (GET /api/influxdb) : borne archivée, dossier, nb de
   * fichiers CSV + taille totale. Défensif : dossier absent → 0 fichier.
   */
  getState(): { lastArchivedTs: number; archiveDir: string; fileCount: number; totalBytes: number } {
    let fileCount = 0;
    let totalBytes = 0;
    // Récursif : les shards écrivent dans des sous-dossiers `/<endpointId>/`
    // (GitHub #18) — on compte les CSV de la racine ET des sous-dossiers.
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (f.endsWith('.csv')) {
          fileCount++;
          totalBytes += st.size;
        }
      }
    };
    try {
      walk(this.ctx.config.influx.archiveDir);
    } catch {
      // dossier absent (jamais archivé) → 0
    }
    return { lastArchivedTs: this.lastArchivedTs, archiveDir: this.ctx.config.influx.archiveDir, fileCount, totalBytes };
  }

  /**
   * Requiert [from, to) d'une table (chunké 30 j) et construit le CSV en mémoire
   * (entête + lignes, `\n` final). Table absente → 0 ligne (querySqlChunked
   * ignore « cannot find table »). `db`/`table` sont validés par le caller.
   */
  async tableCsv(db: string, table: string, from: number, to: number): Promise<{ csv: string; rows: number }> {
    const influx = this.ctx.influx;
    const rows = await influx.querySqlChunked<SqlRow>(
      db,
      (_f, _t) => `SELECT * FROM ${quoteIdent(table)} WHERE time >= '${_f}' AND time < '${_t}' ORDER BY time`,
      from,
      to,
      { chunkDays: ARCHIVE_CHUNK_DAYS },
    );
    if (rows.length === 0) return { csv: '', rows: 0 };
    const columns = Object.keys(rows[0]);
    const lines = [columns.join(',')];
    for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
    return { csv: lines.join('\n') + '\n', rows: rows.length };
  }

  /**
   * Requiert [from, to) d'une table (chunké 30 j) et renvoie les fichiers
   * Parquet (1 par tranche non vide, générés par l'API InfluxDB — header
   * `Accept: application/vnd.apache.parquet`, zéro dépendance — GitHub #15).
   * Impossible de concaténer des Parquet sans lib → 1 fichier/tranche.
   * Nommage : 1 tranche → `<table>.parquet` ; N tranches →
   * `<table>-<from>_<to>.parquet` par tranche. Table absente → 0 fichier.
   * Le nb de lignes est inconnu sans lib de lecture (rows: null côté caller).
   */
  async tableParquet(
    db: string,
    table: string,
    from: number,
    to: number,
  ): Promise<{ files: Array<{ name: string; data: Uint8Array }> }> {
    const influx = this.ctx.influx;
    const chunks = await influx.querySqlChunkedRaw(
      db,
      (_f, _t) => `SELECT * FROM ${quoteIdent(table)} WHERE time >= '${_f}' AND time < '${_t}' ORDER BY time`,
      from,
      to,
      { chunkDays: ARCHIVE_CHUNK_DAYS },
    );
    if (chunks.length === 0) return { files: [] };
    const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
    const files = chunks.map((c) => ({
      name: chunks.length === 1 ? `${table}.parquet` : `${table}-${day(c.from)}_${day(c.to)}.parquet`,
      data: c.data,
    }));
    return { files };
  }

  /**
   * Export ad-hoc d'une table de `consolidated` sur [from, to) vers un CSV
   * (POST /api/influxdb/actions/export, repli single-table). Renvoie le chemin du
   * fichier + nb de lignes (file='' si aucune ligne).
   */
  async exportTable(table: string, from: number, to: number): Promise<{ file: string; rows: number }> {
    mkdirSync(this.ctx.config.influx.archiveDir, { recursive: true });
    const { csv, rows } = await this.tableCsv(this.ctx.influx.aggDb, table, from, to);
    if (rows === 0) return { file: '', rows: 0 };
    const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
    const file = path.join(this.ctx.config.influx.archiveDir, `export-${table}-${day(from)}_${day(to)}.csv`);
    writeFileSync(file, csv);
    return { file, rows };
  }

  /**
   * Construit le ZIP d'export MULTI-tables EN MÉMOIRE (sans écriture disque) :
   * 1 CSV par table (format 'csv', défaut) ou 1+ Parquet par table (format
   * 'parquet' — 1 fichier/tranche de 30 j, GitHub #15). `export-<from>_<to>-<hhmmss>.zip`.
   * Les tables vides sont exclues du ZIP. Renvoie le nom de fichier + les bytes
   * du ZIP + le détail par table (rows: null pour Parquet — inconnu sans lib de
   * lecture ; files = nb de fichiers dans le ZIP). Sert le téléchargement direct
   * (?download=1) et exportTablesZip (mode disque).
   */
  async buildTablesZip(
    tables: string[],
    from: number,
    to: number,
    format: 'csv' | 'parquet' = 'csv',
  ): Promise<{
    filename: string;
    data: Uint8Array;
    exports: Array<{ table: string; rows: number | null; files: number }>;
  }> {
    const files: Record<string, Uint8Array> = {};
    const exports: Array<{ table: string; rows: number | null; files: number }> = [];
    for (const table of tables) {
      if (format === 'parquet') {
        const { files: pqFiles } = await this.tableParquet(this.ctx.influx.aggDb, table, from, to);
        exports.push({ table, rows: null, files: pqFiles.length });
        for (const f of pqFiles) files[f.name] = f.data;
      } else {
        const { csv, rows } = await this.tableCsv(this.ctx.influx.aggDb, table, from, to);
        exports.push({ table, rows, files: rows > 0 ? 1 : 0 });
        if (rows > 0) files[`${table}.csv`] = strToU8(csv);
      }
    }
    const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
    const hhmmss = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const filename = `export-${day(from)}_${day(to)}-${hhmmss}.zip`;
    return { filename, data: zipSync(files, { level: 6 }), exports };
  }

  /**
   * Export ad-hoc MULTI-tables (POST /api/influxdb/actions/export avec `tables[]`,
   * mode disque legacy) : construit le ZIP en mémoire puis l'écrit dans
   * `archiveDir`. Renvoie le chemin du ZIP + le détail par table.
   */
  async exportTablesZip(
    tables: string[],
    from: number,
    to: number,
    format: 'csv' | 'parquet' = 'csv',
  ): Promise<{ file: string; exports: Array<{ table: string; rows: number | null; files: number }> }> {
    const { filename, data, exports } = await this.buildTablesZip(tables, from, to, format);
    mkdirSync(this.ctx.config.influx.archiveDir, { recursive: true });
    const file = path.join(this.ctx.config.influx.archiveDir, filename);
    writeFileSync(file, Buffer.from(data));
    return { file, exports };
  }

  // ---------- Sauvegarde / restauration de bases ----------

  /**
   * Sauvegarde COMPLÈTE d'une base (POST /api/influxdb/actions/database/backup) :
   * ZIP persistant dans `backupDir` = 1 CSV par table (historique complet) +
   * `manifest.json` (db, date, version, schéma time/tags/champs par table — lu
   * depuis information_schema, indispensable à la restauration). Les tables vides
   * sont dans le manifeste (rows: 0) sans CSV. `db` est validée par le caller.
   */
  async backupDatabase(
    db: string,
  ): Promise<{ file: string; tables: Array<{ table: string; rows: number }>; totalRows: number }> {
    const influx = this.ctx.influx;
    const backupDir = this.ctx.config.influx.backupDir;
    const tables = await influx.listTables(db);
    const files: Record<string, Uint8Array> = {};
    const manifestTables: BackupTableManifest[] = [];
    const tableResults: Array<{ table: string; rows: number }> = [];
    let totalRows = 0;
    for (const table of tables) {
      const schema = await influx.tableSchema(db, table);
      if (!schema) continue; // table disparue entre-temps
      // Plage réelle [min(time), max(time)] — évite les chunks vides.
      const range = await influx.querySql<{ min: string | number | null; max: string | number | null }>(
        db,
        `SELECT min(time) AS min, max(time) AS max FROM ${quoteIdent(table)}`,
      );
      const from = influxTsToUnix(range[0]?.min ?? null);
      const max = influxTsToUnix(range[0]?.max ?? null);
      let rows = 0;
      if (from && max) {
        // Borne haute EXCLUSIVE (time < to) → max + 1 pour inclure la dernière
        // ligne (sinon la ligne à max(time) est perdue).
        const to = max + 1;
        const { csv, rows: n } = await this.tableCsv(db, table, from, to);
        rows = n;
        if (rows > 0) files[`${table}.csv`] = strToU8(csv);
      }
      // Table vide : dans le manifeste (rows: 0, sans CSV) — schéma préservé.
      manifestTables.push({ name: table, rows, time: schema.time, tags: schema.tags, fields: schema.fields });
      tableResults.push({ table, rows });
      totalRows += rows;
    }
    const info = influx.getServerInfo ? await influx.getServerInfo().catch(() => null) : null;
    const version = info?.version ?? null;
    const manifest: BackupManifest = {
      db,
      createdAt: new Date().toISOString(),
      influxVersion: version,
      tables: manifestTables,
    };
    files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
    const day = new Date().toISOString().slice(0, 10);
    const hhmmss = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const file = `backup-${db}-${day}-${hhmmss}.zip`;
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, file), Buffer.from(zipSync(files, { level: 6 })));
    return { file, tables: tableResults, totalRows };
  }

  /**
   * Liste des sauvegardes (GET /api/influxdb/backups) : lit le manifest.json de
   * chaque ZIP de `backupDir`. ZIP corrompu / sans manifeste → ignoré. Tri date
   * décroissante. Défensif : dossier absent → [].
   */
  listBackups(): Array<{ file: string; db: string; createdAt: string; size: number; tables: number; rows: number }> {
    const backupDir = this.ctx.config.influx.backupDir;
    let entries: string[] = [];
    try {
      entries = readdirSync(backupDir);
    } catch {
      return [];
    }
    const out: Array<{ file: string; db: string; createdAt: string; size: number; tables: number; rows: number }> = [];
    for (const f of entries) {
      if (!/^backup-[\w.-]+\.zip$/.test(f)) continue;
      const full = path.join(backupDir, f);
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      try {
        const zip = unzipSync(readFileSync(full));
        const raw = zip['manifest.json'];
        if (!raw) continue;
        const m = JSON.parse(strFromU8(raw)) as BackupManifest;
        out.push({
          file: f,
          db: m.db,
          createdAt: m.createdAt,
          size,
          tables: m.tables.length,
          rows: m.tables.reduce((s, t) => s + t.rows, 0),
        });
      } catch {
        continue; // ZIP corrompu / manifeste illisible → ignoré
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Restaure une sauvegarde (POST /api/influxdb/actions/database/restore) :
   * unzip → createDatabase (idempotent) → pour chaque table du manifeste :
   * createTable (idempotent, schéma du manifeste) + réinjection line-protocol
   * par lots de 1000 lignes (writeLp, précision seconde). Cible = base d'origine
   * du manifeste ; table existante → append (doublons possibles).
   * Lève si le fichier est absent ou le manifeste illisible.
   */
  async restoreBackup(
    file: string,
  ): Promise<{ db: string; tables: Array<{ table: string; rows: number; written: number; skipped: number }> }> {
    const influx = this.ctx.influx;
    const full = path.join(this.ctx.config.influx.backupDir, file);
    if (!existsSync(full)) throw new Error(`backup not found: ${file}`);
    const zip = unzipSync(readFileSync(full));
    const raw = zip['manifest.json'];
    if (!raw) throw new Error(`backup sans manifeste: ${file}`);
    const manifest = JSON.parse(strFromU8(raw)) as BackupManifest;
    await influx.createDatabase(manifest.db);
    const results: Array<{ table: string; rows: number; written: number; skipped: number }> = [];
    for (const t of manifest.tables) {
      await influx.createTable(manifest.db, t.name, t.tags, t.fields);
      let written = 0;
      let skipped = 0;
      const csvRaw = zip[`${t.name}.csv`];
      if (csvRaw) {
        const lines = parseCsv(strFromU8(csvRaw));
        const header = lines[0] ?? [];
        const timeIdx = t.time ? header.indexOf(t.time) : -1;
        const tagIdxs = t.tags.map((tag) => header.indexOf(tag));
        const fieldIdxs = t.fields.map((f) => ({ f, idx: header.indexOf(f.name) }));
        const batch: string[] = [];
        for (const row of lines.slice(1)) {
          const ts = timeIdx >= 0 ? influxTsToUnix(row[timeIdx] ?? null) : 0;
          if (!ts) {
            skipped++;
            continue;
          }
          const tagPart = t.tags
            .map((tag, i) => `${tag}=${escapeTag(row[tagIdxs[i]] ?? '')}`)
            .join(',');
          const fieldParts: string[] = [];
          for (const { f, idx } of fieldIdxs) {
            const v = row[idx];
            if (v === null || v === undefined || v === '') continue; // champ absent
            fieldParts.push(
              f.type === 'utf8' ? `${escapeTag(f.name)}=${escapeFieldString(v)}` : `${escapeTag(f.name)}=${v}`,
            );
          }
          if (fieldParts.length === 0) {
            skipped++; // line-protocol exige ≥ 1 champ
            continue;
          }
          batch.push([t.name, tagPart].filter(Boolean).join(',') + ` ${fieldParts.join(',')} ${ts}`);
          written++;
          if (batch.length >= 1000) {
            await influx.writeLp(manifest.db, batch);
            batch.length = 0;
          }
        }
        if (batch.length > 0) await influx.writeLp(manifest.db, batch);
      }
      results.push({ table: t.name, rows: t.rows, written, skipped });
    }
    return { db: manifest.db, tables: results };
  }

  /** Archive [from, to) de `consolidated` vers CSV (1 fichier / table / jour). */
  private async archiveRange(from: number, to: number): Promise<void> {
    // Sharding (GitHub #18) : chaque instance archive sa propre base consolidated.
    // Le global écrit à la racine de archiveDir (comportement d'origine) ; chaque
    // shard écrit dans un sous-dossier `/<endpointId>/` (évite les collisions de
    // fichiers `${table}-${day}.csv` entre instances).
    for (const { client: influx, endpointId } of shardClientsWithIds(this.ctx)) {
      await this.archiveClient(influx, endpointId, from, to);
    }
  }

  private async archiveClient(influx: InfluxClient, endpointId: string | null, from: number, to: number): Promise<void> {
    const outDir = endpointId
      ? path.join(this.ctx.config.influx.archiveDir, endpointId)
      : this.ctx.config.influx.archiveDir;
    mkdirSync(outDir, { recursive: true });
    for (const table of ARCHIVE_TABLES) {
      // Chunké (30 j) → chaque requête reste sous --query-file-limit.
      let rows: SqlRow[];
      try {
        rows = await influx.querySqlChunked<SqlRow>(
          influx.aggDb,
          (_f, _t) => `SELECT * FROM ${quoteIdent(table)} WHERE time >= '${_f}' AND time < '${_t}' ORDER BY time`,
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
        const file = path.join(outDir, `${table}-${day}.csv`);
        writeFileSync(file, lines.join('\n') + '\n');
      }
    }
  }
}
