import { fetch, type Agent } from 'undici';
import type { InfluxConfig } from './config.js';

export interface SqlRow {
  [col: string]: string | number | null;
}

interface QuerySqlResponse {
  results?: Array<{
    series?: Array<{
      columns?: string[];
      name?: string;
      values?: (string | number | null)[][];
    }>;
  }>;
}

/**
 * Convertit un timestamp InfluxDB en unix seconds.
 * L'API renvoie l'UTC sous forme ISO sans indicateur de fuseau : on force le `Z`
 * avant Date.parse (sinon JS interprète en heure locale).
 */
export function influxTsToUnix(t: string | number | null): number {
  if (t === null || t === undefined) return 0;
  if (typeof t === 'number') return Math.floor(t > 1e12 ? t / 1000 : t);
  const s = String(t).trim();
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  return Math.floor(Date.parse(iso) / 1000);
}

/** Échappement d'une valeur de tag line-protocol. */
export function escapeTag(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ');
}

/** Encodage d'un champ string line-protocol. */
export function escapeFieldString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export type FieldValue = number | string;

/** Construit une ligne line-protocol : `mesure,t1=v1,t2=v2 f1=1,f2="x" ts`. */
export function buildLine(
  measurement: string,
  tags: Record<string, string>,
  fields: Record<string, FieldValue>,
  tsSec: number,
): string {
  const tagPart = Object.entries(tags)
    .map(([k, v]) => `${escapeTag(k)}=${escapeTag(v)}`)
    .join(',');
  const fieldPart = Object.entries(fields)
    .map(([k, v]) => (typeof v === 'string' ? `${escapeTag(k)}=${escapeFieldString(v)}` : `${escapeTag(k)}=${v}`))
    .join(',');
  return [measurement, tagPart].filter(Boolean).join(',') + ` ${fieldPart} ${tsSec}`;
}

/** délai de coalescence : regroupe les lignes d'un même tick en un seul lot */
const FLUSH_DELAY_MS = 25;
/** délai de retry après un lot en échec (sans attendre un nouveau tick) */
const FLUSH_RETRY_MS = 1_000;

/** Compteurs d'écriture (P1 backpressure) — exposés via getStats(). */
export interface InfluxWriteStats {
  enabled: boolean;
  /** lignes en file d'attente (instantané) */
  queueDepth: number;
  /** total des lignes enfileées (monotone) */
  enqueued: number;
  /** total des lignes écrites avec succès (monotone) */
  flushed: number;
  /** total des lignes abandonnées (débordement file + dead-letter, monotone) */
  dropped: number;
  /** lots write_lp en échec (monotone) */
  failedBatches: number;
  lastDropAt: number | null;
  lastErrorAt: number | null;
}

/** Stats de lecture (P4 auto-monitoring). */
export interface InfluxQueryStats {
  lastQueryMs: number | null;
  lastQueryAt: number | null;
  lastQueryError: string | null;
}

/**
 * Client InfluxDB 3 Core (HTTP natif, sans SDK).
 *
 * - écriture : file bornée non bloquante (le poller ne doit jamais attendre),
 *   flush par lots vers /api/v3/write_lp, dead-letter après N échecs consécutifs ;
 * - lecture : SQL DuckDB via /api/v3/query_sql (+ querySqlChunked pour les fenêtres
 *   long terme > --query-file-limit) ;
 * - admin : création des bases avec rétention native (immuable en Core) + server-info.
 *
 * Limites gérées (plan-limites-influxdb3.md) : file d'écriture dimensionnée + compteurs
 * d'abandon (P1), requêtes chunkées (P2), stats de lecture + server-info (P4).
 */
export class InfluxClient {
  private queue: string[] = [];
  private flushing = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastDropLog = 0;
  private consecutiveFailures = 0;
  // P1 — compteurs d'écriture
  private enqueued = 0;
  private flushed = 0;
  private dropped = 0;
  private failedBatches = 0;
  private lastDropAt: number | null = null;
  private lastErrorAt: number | null = null;
  // P4 — stats de lecture
  private lastQueryMs: number | null = null;
  private lastQueryAt: number | null = null;
  private lastQueryError: string | null = null;

  /**
   * Dispatcher dédié (CA InfluxDB auto-signé) : la confiance est limitée aux
   * appels InfluxDB, au lieu de modifier le dispatcher global du processus
   * (qui ferait alors confiance au CA Influx pour TOUTES les requêtes,
   * Proxmox et Centreon compris).
   */
  constructor(private cfg: InfluxConfig, private dispatcher?: Agent) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get rawDb(): string {
    return this.cfg.rawDb;
  }

  get aggDb(): string {
    return this.cfg.aggDb;
  }

  /** base RRD native Proxmox VE (7 tables, déjà présente chez les clients) */
  get rrdDb(): string {
    return this.cfg.rrdDb;
  }

  /** Enfile une ligne line-protocol (base raw). Non bloquant, file bornée. */
  enqueue(line: string): void {
    if (!this.cfg.enabled) return;
    this.enqueued++;
    if (this.queue.length >= this.cfg.queueMax) {
      this.queue.shift();
      this.dropped++;
      this.lastDropAt = Date.now();
      this.logDrop('file d’écriture saturée : lignes les plus anciennes abandonnées');
    }
    this.queue.push(line);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Arrête le timer de coalescence (shutdown). */
  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** Nombre de lignes en attente d'écriture (tests / diagnostic). */
  get pending(): number {
    return this.queue.length;
  }

  /** Compteurs d'écriture (P1) — consommés par /api/health et /api/influxdb. */
  getStats(): InfluxWriteStats {
    return {
      enabled: this.cfg.enabled,
      queueDepth: this.queue.length,
      enqueued: this.enqueued,
      flushed: this.flushed,
      dropped: this.dropped,
      failedBatches: this.failedBatches,
      lastDropAt: this.lastDropAt,
      lastErrorAt: this.lastErrorAt,
    };
  }

  /** Stats de lecture (P4) — latence + dernier error de la dernière requête. */
  getQueryStats(): InfluxQueryStats {
    return {
      lastQueryMs: this.lastQueryMs,
      lastQueryAt: this.lastQueryAt,
      lastQueryError: this.lastQueryError,
    };
  }

  /**
   * Estimation de headroom fichiers (P4) : InfluxDB 3 Core stocke 1 fichier Parquet
   * / table / bloc de 10 min (144/jour). Sans compaction (Core), une requête de N jours
   * scanne N×144 fichiers → refus au-delà de --query-file-limit. Avec le chunking (P2),
   * la plus longue requête simple = chunkDays → `chunkFiles`. `yearFiles` montre ce que
   * ferait une requête 365 j non chunkée (justifie le chunking).
   */
  fileEstimate(): {
    chunkDays: number;
    chunkFiles: number;
    yearFiles: number;
    fileLimit: number;
    headroom: 'ok' | 'warn' | 'crit';
  } {
    const chunkDays = this.cfg.queryChunkDays;
    const chunkFiles = chunkDays * 144;
    const yearFiles = 365 * 144;
    const fileLimit = this.cfg.queryFileLimit;
    const ratio = chunkFiles / fileLimit;
    const headroom: 'ok' | 'warn' | 'crit' = ratio > 1 ? 'crit' : ratio > 0.8 ? 'warn' : 'ok';
    return { chunkDays, chunkFiles, yearFiles, fileLimit, headroom };
  }

  /** Vide la file par lots ; en cas d'échec, ré-enfile (ou dead-letter après N échecs). */
  async flush(): Promise<void> {
    if (this.flushing || !this.cfg.enabled) return;
    this.flushing = true;
    try {
      for (;;) {
        const batch = this.queue.splice(0, this.cfg.flushMaxLines);
        if (batch.length === 0) break;
        try {
          await this.writeLp(this.cfg.rawDb, batch);
          this.flushed += batch.length;
          this.consecutiveFailures = 0;
        } catch {
          this.failedBatches++;
          this.lastErrorAt = Date.now();
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.cfg.flushMaxRetries) {
            // Dead-letter : InfluxDB trop longtemps indisponible → on abandonne le lot.
            // La file reste bornée à queueMax ; le repli RRD couvre l'affichage.
            this.dropped += batch.length;
            this.lastDropAt = Date.now();
            this.consecutiveFailures = 0;
            this.logDrop(
              `écriture InfluxDB en échec répété (${this.cfg.flushMaxRetries}) : ${batch.length} ligne(s) abandonnées`,
            );
            break;
          }
          // Ré-enfile en tête (borné) — reprise au prochain flush / retry.
          const head = batch.slice(Math.max(0, batch.length + this.queue.length - this.cfg.queueMax));
          this.queue.unshift(...head);
          this.logDrop(`écriture InfluxDB en échec : ${this.queue.length} ligne(s) conservée(s) en file`);
          break;
        }
      }
      // Retry court si des lignes restent en file (sans attendre un nouveau tick).
      if (this.queue.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, FLUSH_RETRY_MS);
        this.flushTimer.unref?.();
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Écrit un lot de lignes line-protocol (précision seconde). */
  async writeLp(db: string, lines: string[]): Promise<void> {
    const url = `${this.cfg.url}/api/v3/write_lp?db=${encodeURIComponent(db)}&precision=s`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'text/plain' },
      body: lines.join('\n'),
      signal: AbortSignal.timeout(10_000),
      dispatcher: this.dispatcher,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`InfluxDB write_lp ${db} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /** Requête SQL (DuckDB) avec stats de lecture (P4). Renvoie les lignes de la 1ʳᵉ série. */
  async querySql<T extends SqlRow = SqlRow>(db: string, sql: string): Promise<T[]> {
    const start = Date.now();
    try {
      const rows = await this.querySqlOnce<T>(db, sql);
      this.lastQueryMs = Date.now() - start;
      this.lastQueryAt = Date.now();
      this.lastQueryError = null;
      return rows;
    } catch (err) {
      this.lastQueryMs = Date.now() - start;
      this.lastQueryAt = Date.now();
      this.lastQueryError = (err as Error).message ?? String(err);
      throw err;
    }
  }

  /**
   * Requête SQL chunkée (P2) : découpe [from, to) en tranches de `chunkDays` et
   * concatène les résultats. Chaque tranche reste sous --query-file-limit
   * (30 j = 4 320 fichiers < 10 000). `buildSql(fromIso, toIso)` fournit le SQL
   * paramétré par bornes (le caller contrôle la clause WHERE).
   *
   * Une tranche « table absente / champ absent » est ignorée (pattern consolidateur) ;
   * tout autre échec est propagé.
   */
  async querySqlChunked<T extends SqlRow = SqlRow>(
    db: string,
    buildSql: (fromIso: string, toIso: string) => string,
    from: number,
    to: number,
    opts?: { chunkDays?: number },
  ): Promise<T[]> {
    const chunkSec = (opts?.chunkDays ?? this.cfg.queryChunkDays) * 86_400;
    const iso = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
    const out: T[] = [];
    let cursor = from;
    while (cursor < to) {
      const end = Math.min(cursor + chunkSec, to);
      try {
        out.push(...(await this.querySql<T>(db, buildSql(iso(cursor), iso(end)))));
      } catch (err) {
        if (!/cannot find table|does not exist|No field named/i.test((err as Error).message ?? '')) {
          throw err;
        }
      }
      cursor = end;
    }
    return out;
  }

  private async querySqlOnce<T extends SqlRow = SqlRow>(db: string, sql: string): Promise<T[]> {
    const res = await fetch(`${this.cfg.url}/api/v3/query_sql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ db, q: sql }),
      signal: AbortSignal.timeout(10_000),
      dispatcher: this.dispatcher,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`InfluxDB query_sql ${db} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as QuerySqlResponse | SqlRow[];
    // InfluxDB 3 renvoie un tableau d'objets par défaut ; on gère aussi le
    // format results/series (colonnes + valeurs positionnelles).
    if (Array.isArray(json)) return json as T[];
    const series = json.results?.[0]?.series?.[0];
    if (!series?.columns || !series.values) return [];
    const columns = series.columns;
    return series.values.map((row) => {
      const obj: Record<string, string | number | null> = {};
      columns.forEach((c, i) => {
        obj[c] = row[i] ?? null;
      });
      return obj as T;
    });
  }

  /** Crée une base avec sa rétention native (idempotent : 409 ignoré). `retentionPeriod` absent = rétention infinie. */
  async createDatabase(db: string, retentionPeriod?: string): Promise<void> {
    const body: Record<string, string> = { db };
    if (retentionPeriod) body.retention_period = retentionPeriod;
    const res = await fetch(`${this.cfg.url}/api/v3/configure/database`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      dispatcher: this.dispatcher,
    });
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => '');
      throw new Error(`InfluxDB create_database ${db} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /**
   * Supprime une base (destructif) via DELETE /api/v3/configure/database.
   * Lève une erreur si la base n'existe pas (404) — le caller valide avant.
   */
  async dropDatabase(db: string): Promise<void> {
    const res = await fetch(`${this.cfg.url}/api/v3/configure/database?db=${encodeURIComponent(db)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      signal: AbortSignal.timeout(10_000),
      dispatcher: this.dispatcher,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`InfluxDB drop_database ${db} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /**
   * Supprime une table (destructif) via DELETE /api/v3/configure/table.
   * Lève une erreur si la base/table n'existe pas (404) — le caller valide avant.
   */
  async dropTable(db: string, table: string): Promise<void> {
    const res = await fetch(
      `${this.cfg.url}/api/v3/configure/table?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(10_000),
        dispatcher: this.dispatcher,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`InfluxDB drop_table ${db}.${table} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /** GET /health (3 s max). L'endpoint exige le token quand l'auth est active. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.url}/health`, {
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(3_000),
        dispatcher: this.dispatcher,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Infos serveur (P4) : version via /api/v3/server-info (défensif — l'endpoint peut
   * varier selon la version). Renvoie `version` (best-effort) + le JSON brut.
   */
  async getServerInfo(): Promise<{ version: string | null; raw: unknown }> {
    try {
      const res = await fetch(`${this.cfg.url}/api/v3/server-info`, {
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(3_000),
        dispatcher: this.dispatcher,
      });
      if (!res.ok) return { version: null, raw: null };
      const json = (await res.json()) as Record<string, unknown>;
      const version =
        (typeof json.version === 'string' && json.version) ||
        (typeof json.build === 'string' && (json.build as string)) ||
        null;
      return { version, raw: json };
    } catch {
      return { version: null, raw: null };
    }
  }

  /**
   * Liste les bases (P4) via GET /api/v3/configure/database?format=json.
   * InfluxDB 3 Core exige le paramètre `format` (400 sinon) et renvoie un
   * tableau d'objets `{ "iox::database": "<nom>" }` — sans rétention (l'API
   * GET ne l'expose pas). Défensif : repli sur `db`/`name` + [] en cas de
   * surprise (le format peut varier selon la version).
   */
  async listDatabases(): Promise<Array<{ name: string; retention: string | null }>> {
    try {
      const res = await fetch(`${this.cfg.url}/api/v3/configure/database?format=json`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(5_000),
        dispatcher: this.dispatcher,
      });
      if (!res.ok) return [];
      const json = (await res.json()) as unknown;
      const arr = Array.isArray(json) ? json : (json as { databases?: unknown[] })?.databases;
      if (!Array.isArray(arr)) return [];
      return arr
        .map((d) => {
          const o = d as Record<string, unknown>;
          const name =
            typeof o['iox::database'] === 'string'
              ? o['iox::database']
              : typeof o.db === 'string'
                ? o.db
                : typeof o.name === 'string'
                  ? o.name
                  : '';
          const retention =
            typeof o.retention_period === 'string'
              ? o.retention_period
              : typeof o.retentionPeriod === 'string'
                ? o.retentionPeriod
                : null;
          return { name, retention };
        })
        .filter((d) => d.name.length > 0);
    } catch {
      return [];
    }
  }

  private logDrop(msg: string): void {
    const now = Date.now();
    if (now - this.lastDropLog > 60_000) {
      this.lastDropLog = now;
      console.warn(`[influx] ${msg}`);
    }
  }
}

/**
 * Attend InfluxDB (10 × 3 s) puis crée les deux bases :
 * raw (rétention 31 d) + agg (rétention infinie). Non bloquant pour le boot.
 */
export async function ensureInfluxDatabases(
  client: InfluxClient,
  logger: Pick<Console, 'info' | 'warn'>,
): Promise<void> {
  if (!client.enabled) return;
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (await client.ping()) break;
    if (attempt === 10) {
      logger.warn('InfluxDB injoignable : les métriques historiques resteront en RRD Proxmox');
      return;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  try {
    await client.createDatabase(client.rawDb, '31d');
    await client.createDatabase(client.aggDb); // rétention infinie (champ omis)
    logger.info(`InfluxDB prêt : bases ${client.rawDb} (31 j) + ${client.aggDb} (∞)`);
  } catch (err) {
    logger.warn(`création des bases InfluxDB en échec : ${(err as Error).message}`);
  }
}
