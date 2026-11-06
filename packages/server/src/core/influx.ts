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

const FLUSH_MAX_LINES = 200;
const QUEUE_MAX = 1_000;
/** délai de coalescence : regroupe les lignes d'un même tick en un seul lot */
const FLUSH_DELAY_MS = 25;

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

/**
 * Client InfluxDB 3 Core (HTTP natif, sans SDK).
 *
 * - écriture : file bornée non bloquante (le poller ne doit jamais attendre),
 *   flush par lots de 200 lignes vers /api/v3/write_lp ;
 * - lecture : SQL DuckDB via /api/v3/query_sql ;
 * - admin : création des bases avec rétention native (immuable en Core).
 */
export class InfluxClient {
  private queue: string[] = [];
  private flushing = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastDropLog = 0;

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
    if (this.queue.length >= QUEUE_MAX) {
      this.queue.shift();
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Nombre de lignes en attente d'écriture (tests / diagnostic). */
  get pending(): number {
    return this.queue.length;
  }

  /** Vide la file par lots ; en cas d'échec, le lot est ré-enfilé en tête. */
  async flush(): Promise<void> {
    if (this.flushing || !this.cfg.enabled) return;
    this.flushing = true;
    try {
      for (;;) {
        const batch = this.queue.splice(0, FLUSH_MAX_LINES);
        if (batch.length === 0) break;
        try {
          await this.writeLp(this.cfg.rawDb, batch);
        } catch {
          const head = batch.slice(Math.max(0, batch.length + this.queue.length - QUEUE_MAX));
          this.queue.unshift(...head);
          this.logDrop(`écriture InfluxDB en échec : ${this.queue.length} ligne(s) conservée(s) en file`);
          break;
        }
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

  /** Requête SQL (DuckDB). Renvoie les lignes de la première série. */
  async querySql<T extends SqlRow = SqlRow>(db: string, sql: string): Promise<T[]> {
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
