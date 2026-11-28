import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Agent } from 'undici';
import type { InfluxConfig } from './config.js';
import { InfluxClient, type SqlRow } from './influx.js';
import type { AppContext } from './poller.js';

/**
 * Sharding multi-InfluxDB par endpoint (GitHub #18) — Phase 0 (dormant).
 *
 * Répartit les métriques sur plusieurs instances InfluxDB quand un seul nœud ne
 * suffit plus (volume d'écriture, headroom fichiers, performance requêtes).
 *
 * **Dormant par conception** : le routeur retombe sur le client GLOBAL quand
 * aucun shard n'est configuré pour un endpoint. `data/influx-shards.json` absent
 * ou vide → `forEndpoint()` = global, `all()` = [global] → zéro changement de
 * comportement par rapport à l'instance unique (prouvé par tests).
 *
 * Deux flux d'écriture couverts :
 *  - métriques API PVE (poller) → routées par `forEndpoint(clusterId)` ;
 *  - métriques agent Telegraf (node-sensors) → écrites DIRECTEMENT par le
 *    Telegraf de chaque nœud ; leur routage est une étape de DÉPLOIEMENT
 *    (Phase 1 : reconfig du Telegraf par nœud vers le shard de son endpoint).
 *    Le code Prox4u ne fait que les LIRE (fan-out, cf. ci-dessous).
 *
 * **Lectures** : `fanOutQuery` interroge TOUS les clients (global + shards) et
 * merge les résultats. C'est la solution universelle : correcte (chaque shard
 * ne contient que les données de son endpoint) ET complète (les données legacy
 * pré-sharding restent dans le global, donc incluses). Tolérance partiel : un
 * client en échec n'empêche pas les autres ; tous en échec → lève la 1ʳᵉ erreur.
 */

/** Déclaration d'un shard : un endpoint routé vers une instance InfluxDB. */
export interface InfluxShardConfig {
  /** endpoint Proxmox (id de clusters.json) routé vers ce shard. */
  endpointId: string;
  /** URL de l'instance (https://host:8181) — sans slash final. */
  url: string;
  /** token API — défaut = token global (INFLUX_TOKEN). */
  token?: string;
  /** base brute — défaut = base globale (rawDb). */
  rawDb?: string;
  /** base consolidée — défaut = base globale (aggDb). */
  aggDb?: string;
  /** base RRD native PVE — défaut = base globale (rrdDb). */
  rrdDb?: string;
  /** certificat auto-signé de l'instance (chemin absolu) — défaut = CA global. */
  caCert?: string;
}

/** Type de base (sert le fan-out : chaque client a ses propres noms de bases). */
export type DbKind = 'raw' | 'agg' | 'rrd';

/** Nom de la base `kind` pour un client donné. */
export function dbOf(c: InfluxClient, kind: DbKind): string {
  return kind === 'raw' ? c.rawDb : kind === 'agg' ? c.aggDb : c.rrdDb;
}

/**
 * Routeur de shards : tient le client global + un client par shard configuré.
 * Les clients shards sont reconstruits à la volée (hot-reload via l'UI admin).
 */
export class InfluxShardRouter {
  private clients = new Map<string, InfluxClient>();

  constructor(
    private global: InfluxClient,
    private globalCfg: InfluxConfig,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
    private opts: { globalDispatcher?: Agent; trustCa?: (caCert: string) => Agent } = {},
  ) {}

  /** (Re)construit les clients shards à partir de la config. Arrête les anciens. */
  reload(shards: InfluxShardConfig[]): void {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
    const seenEndpoint = new Set<string>();
    for (const s of shards) {
      // endpointId en double → le premier gagne (le store dédoublonne au upsert).
      if (seenEndpoint.has(s.endpointId)) continue;
      seenEndpoint.add(s.endpointId);
      this.clients.set(s.endpointId, this.buildClient(s));
    }
    if (this.clients.size > 0) {
      this.logger.info(`influx-shards : ${this.clients.size} shard(s) actif(s) : ${[...this.clients.keys()].join(', ')}`);
    }
  }

  private buildClient(s: InfluxShardConfig): InfluxClient {
    const token = s.token ?? this.globalCfg.token;
    let dispatcher = this.opts.globalDispatcher;
    if (s.caCert) {
      try {
        dispatcher = this.opts.trustCa ? this.opts.trustCa(s.caCert) : this.opts.globalDispatcher;
      } catch (err) {
        this.logger.warn(`influx-shards : CA ${s.caCert} illisible (${(err as Error).message}) → dispatcher global`);
        dispatcher = this.opts.globalDispatcher;
      }
    }
    const cfg: InfluxConfig = {
      ...this.globalCfg,
      enabled: token.length > 0,
      url: s.url.replace(/\/$/, ''),
      token,
      rawDb: s.rawDb ?? this.globalCfg.rawDb,
      aggDb: s.aggDb ?? this.globalCfg.aggDb,
      rrdDb: s.rrdDb ?? this.globalCfg.rrdDb,
      caCert: s.caCert ?? this.globalCfg.caCert,
    };
    return new InfluxClient(cfg, dispatcher);
  }

  /** Client pour un endpoint — repli sur le global si aucun shard configuré. */
  forEndpoint(endpointId?: string): InfluxClient {
    if (endpointId) {
      const c = this.clients.get(endpointId);
      if (c) return c;
    }
    return this.global;
  }

  /** Tous les clients (global + shards, dédupliqués par URL) — pour le fan-out. */
  all(): InfluxClient[] {
    const seen = new Set<string>();
    const out: InfluxClient[] = [];
    const push = (c: InfluxClient) => {
      const key = c.url;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };
    push(this.global);
    for (const c of this.clients.values()) push(c);
    return out;
  }

  /**
   * Tous les clients AVEC leur endpointId (null = global), dédupliqués par URL
   * (le global passe en premier → un shard sur l'URL globale est ignoré). Sert
   * l'archiver (isolation des CSV par shard).
   */
  allWithIds(): Array<{ client: InfluxClient; endpointId: string | null }> {
    const seen = new Set<string>();
    const out: Array<{ client: InfluxClient; endpointId: string | null }> = [];
    const push = (client: InfluxClient, endpointId: string | null) => {
      const key = client.url;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ client, endpointId });
    };
    push(this.global, null);
    for (const [endpointId, client] of this.clients) push(client, endpointId);
    return out;
  }

  hasShards(): boolean {
    return this.clients.size > 0;
  }

  /** Identifiants des endpoints sharded (UI admin — pour valider les endpointId). */
  shardEndpointIds(): string[] {
    return [...this.clients.keys()];
  }

  /** Arrête les clients shards (shutdown). */
  stop(): void {
    for (const c of this.clients.values()) c.stop();
  }
}

// ---------------------------------------------------------------------------
// Helpers de routage — à utiliser dans les modules (poller, lecteurs, …)
// ---------------------------------------------------------------------------

/** Client pour un endpoint (repli global si pas de router / pas de shard). */
export function shardFor(ctx: AppContext, endpointId?: string): InfluxClient {
  return ctx.influxShards ? ctx.influxShards.forEndpoint(endpointId) : ctx.influx;
}

/** Tous les clients (fan-out) — [global] si pas de router. */
export function shardClients(ctx: AppContext): InfluxClient[] {
  return ctx.influxShards ? ctx.influxShards.all() : [ctx.influx];
}

/**
 * Tous les clients AVEC leur endpointId (null = global) — sert l'archiver qui
 * isole les CSV par shard (sous-dossier `/<endpointId>/`) pour éviter les
 * collisions de fichiers `${table}-${day}.csv` entre instances.
 */
export function shardClientsWithIds(ctx: AppContext): Array<{ client: InfluxClient; endpointId: string | null }> {
  if (!ctx.influxShards) return [{ client: ctx.influx, endpointId: null }];
  return ctx.influxShards.allWithIds();
}

/**
 * Fan-out : requête SQL sur TOUS les clients (global + shards), merge des
 * résultats. Tolérance partiel : un client en échec n'empêche pas les autres ;
 * tous en échec → lève la 1ʳᵉ erreur (le try/catch du caller gère le repli).
 */
export async function fanOutQuery<T extends SqlRow = SqlRow>(
  ctx: AppContext,
  kind: DbKind,
  sql: string,
): Promise<T[]> {
  const clients = shardClients(ctx);
  const results = await Promise.allSettled(clients.map((c) => c.querySql<T>(dbOf(c, kind), sql)));
  const out: T[] = [];
  let firstErr: unknown = null;
  let ok = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      ok++;
      for (const row of r.value) out.push(row);
    } else if (firstErr === null) {
      firstErr = r.reason;
    }
  }
  if (ok === 0 && firstErr !== null) throw firstErr;
  return out;
}

/** Fan-out chunké (long terme) — même contrat que `fanOutQuery`. */
export async function fanOutQueryChunked<T extends SqlRow = SqlRow>(
  ctx: AppContext,
  kind: DbKind,
  buildSql: (fromIso: string, toIso: string) => string,
  from: number,
  to: number,
  opts?: { chunkDays?: number },
): Promise<T[]> {
  const clients = shardClients(ctx);
  const results = await Promise.allSettled(
    clients.map((c) => c.querySqlChunked<T>(dbOf(c, kind), buildSql, from, to, opts)),
  );
  const out: T[] = [];
  let firstErr: unknown = null;
  let ok = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      ok++;
      for (const row of r.value) out.push(row);
    } else if (firstErr === null) {
      firstErr = r.reason;
    }
  }
  if (ok === 0 && firstErr !== null) throw firstErr;
  return out;
}

// ---------------------------------------------------------------------------
// Store — data/influx-shards.json (gitignoré, chmod 600, hot-reload)
// ---------------------------------------------------------------------------

interface ShardsFile {
  shards: InfluxShardConfig[];
}

/**
 * Stockage de la config des shards : un seul fichier data/influx-shards.json
 * (gitignoré, chmod 600), cache en mémoire + écriture atomique (tmp → rename).
 * Mêmes garanties que data/sensor-thresholds.json / data/centreon-nsca.json.
 *
 * Format : { "shards": [ { endpointId, url, token?, rawDb?, aggDb?, rrdDb?, caCert? } ] }.
 * Absent / vide = sharding dormant (tout reste sur l'instance globale).
 */
export class InfluxShardStore {
  private file: ShardsFile;

  constructor(
    private filePath: string,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
  ) {
    this.file = { shards: [] };
  }

  /** Charge (ou crée vide) le fichier. Fail-fast si corrompu. */
  init(): void {
    if (existsSync(this.filePath)) {
      let raw: string;
      try {
        raw = readFileSync(this.filePath, 'utf8');
      } catch (err) {
        throw new Error(`data/influx-shards.json illisible : ${(err as Error).message}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new Error(`data/influx-shards.json invalide (JSON) : ${(err as Error).message}`);
      }
      const f = data as { shards?: unknown };
      if (f.shards !== undefined && !Array.isArray(f.shards)) {
        throw new Error('data/influx-shards.json invalide : `shards` doit être un tableau');
      }
      this.file = { shards: (f.shards as InfluxShardConfig[]) ?? [] };
      this.logger.info(`influx-shards : ${this.file.shards.length} shard(s) chargé(s)`);
      return;
    }
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.persist();
    this.logger.info('influx-shards : data/influx-shards.json créé (vide — sharding dormant)');
  }

  /** Copie des shards courants (jamais la référence interne). */
  getShards(): InfluxShardConfig[] {
    return this.file.shards.map((s) => ({ ...s }));
  }

  /** Remplace l'ensemble des shards. Écriture atomique. Renvoie la nouvelle liste. */
  setShards(shards: InfluxShardConfig[]): InfluxShardConfig[] {
    this.file.shards = shards.map((s) => ({ ...s }));
    this.persist();
    return this.getShards();
  }

  /** Ajoute ou met à jour un shard (par endpointId). Renvoie la nouvelle liste. */
  upsertShard(shard: InfluxShardConfig): InfluxShardConfig[] {
    const i = this.file.shards.findIndex((s) => s.endpointId === shard.endpointId);
    if (i >= 0) this.file.shards[i] = { ...shard };
    else this.file.shards.push({ ...shard });
    this.persist();
    return this.getShards();
  }

  /** Supprime un shard (par endpointId). Renvoie la nouvelle liste. */
  deleteShard(endpointId: string): InfluxShardConfig[] {
    this.file.shards = this.file.shards.filter((s) => s.endpointId !== endpointId);
    this.persist();
    return this.getShards();
  }

  /** Écriture atomique : tmp + rename, permissions 600. */
  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }
}
