import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLine, influxTsToUnix, type SqlRow } from './influx.js';
import type { AppContext } from './poller.js';

const WINDOW_SEC = 300;
/** backfill par tranches d'un jour (évite les requêtes géantes après un long arrêt) */
const CHUNK_SEC = 86_400;

interface State {
  /** borne haute consolidée (exclusive), unix seconds */
  lastTs: number;
}

function num(v: string | number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Consolidateur : toutes les 5 min, agrège la fenêtre [lastTs, now-5min] de la
 * base raw (buckets 5 min par nœud / par VM) vers la base consolidated.
 *
 * - ne traite que des fenêtres complètes (pas de bucket partiel) ;
 * - reprise après arrêt via data/consolidation-state.json (tmp+rename) ;
 * - en cas d'échec, lastTs n'avance pas → la fenêtre est retravaillée au cycle suivant.
 */
export class InfluxConsolidator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTs: number;
  private stateFile: string;

  constructor(private ctx: AppContext) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/core → racine du repo (4 niveaux)
    const repoRoot = path.resolve(here, '../../../..');
    // hors de data/influxdb/ : ce dossier est chown'é au user du conteneur Docker
    this.stateFile = path.join(repoRoot, 'data/consolidation-state.json');
    // sans état : on repart de la fenêtre précédente (rattrape les écritures
    // d'une instance antérieure si la base raw en contient)
    this.lastTs = this.readState() ?? Math.floor(Date.now() / 1000) - WINDOW_SEC;
  }

  start(): void {
    if (!this.ctx.influx.enabled || this.ctx.config.mock) return;
    this.ctx.logger.info(`consolidateur InfluxDB actif (fenêtre ${WINDOW_SEC / 60} min, reprise à t=${this.lastTs})`);
    void this.run();
    this.timer = setInterval(() => void this.run(), WINDOW_SEC * 1_000);
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
      return Number.isInteger(s.lastTs) && s.lastTs > 0 ? s.lastTs : null;
    } catch {
      return null;
    }
  }

  private writeState(): void {
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ lastTs: this.lastTs }));
      renameSync(tmp, this.stateFile);
    } catch (err) {
      this.ctx.logger.warn(`consolidateur : état non sauvegardé (${(err as Error).message})`);
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const end = Math.floor(Date.now() / 1000) - WINDOW_SEC;
      if (end <= this.lastTs) return;
      let from = this.lastTs;
      while (from < end) {
        const to = Math.min(from + CHUNK_SEC, end);
        await this.consolidateRange(from, to);
        from = to;
      }
      this.lastTs = end;
      this.writeState();
    } catch (err) {
      this.ctx.logger.warn(`consolidateur : cycle en échec (${(err as Error).message}) — reprise au prochain cycle`);
    } finally {
      this.running = false;
    }
  }

  /** Agrège [from, to) de raw vers consolidated (buckets 5 min). */
  private async consolidateRange(from: number, to: number): Promise<void> {
    const influx = this.ctx.influx;
    // bornes ISO UTC : DataFusion ne coerce pas timestamp >= entier
    const iso = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
    // lignes legacy (avant le tag cluster) → endpoint par défaut
    const def = this.ctx.config.defaultEndpointId;
    const clusterCol = `COALESCE(cluster, '${def}')`;

    const nodeRows = await influx.querySql<SqlRow>(
      influx.rawDb,
      `SELECT date_bin(INTERVAL '5 minutes', time) AS t, ${clusterCol} AS cluster, node,
              AVG(cpu_pct) AS cpu_pct, AVG(ram_pct) AS ram_pct, AVG(disk_pct) AS disk_pct
        FROM node_metrics WHERE time >= '${iso(from)}' AND time < '${iso(to)}'
        GROUP BY t, cluster, node ORDER BY t`,
    );
    const nodeLines = nodeRows.map((r) =>
      buildLine(
        'node_metrics',
        { cluster: String(r.cluster), node: String(r.node) },
        {
          cpu_pct: round2(num(r.cpu_pct)),
          ram_pct: round2(num(r.ram_pct)),
          disk_pct: round2(num(r.disk_pct)),
        },
        influxTsToUnix(r.t),
      ),
    );
    if (nodeLines.length > 0) await influx.writeLp(influx.aggDb, nodeLines);

    // Trafic réseau du nœud (mesure dédiée — voir poller.writeInflux).
    const netRows = await influx.querySql<SqlRow>(
      influx.rawDb,
      `SELECT date_bin(INTERVAL '5 minutes', time) AS t, ${clusterCol} AS cluster, node,
              AVG(net_in_bps) AS net_in_bps, AVG(net_out_bps) AS net_out_bps
        FROM node_net WHERE time >= '${iso(from)}' AND time < '${iso(to)}'
        GROUP BY t, cluster, node ORDER BY t`,
    );
    const netLines = netRows.map((r) =>
      buildLine(
        'node_net',
        { cluster: String(r.cluster), node: String(r.node) },
        {
          net_in_bps: Math.round(num(r.net_in_bps)),
          net_out_bps: Math.round(num(r.net_out_bps)),
        },
        influxTsToUnix(r.t),
      ),
    );
    if (netLines.length > 0) await influx.writeLp(influx.aggDb, netLines);

    // Stockage VM (endpoint) : mêmes buckets 5 min que node_metrics.
    const storageRows = await influx.querySql<SqlRow>(
      influx.rawDb,
      `SELECT date_bin(INTERVAL '5 minutes', time) AS t, ${clusterCol} AS cluster,
              AVG(used_bytes) AS used, AVG(total_bytes) AS total
        FROM storage_metrics WHERE time >= '${iso(from)}' AND time < '${iso(to)}'
        GROUP BY t, cluster ORDER BY t`,
    );
    const storageLines = storageRows.map((r) =>
      buildLine(
        'storage_metrics',
        { cluster: String(r.cluster) },
        {
          used_bytes: Math.round(num(r.used)),
          total_bytes: Math.round(num(r.total)),
        },
        influxTsToUnix(r.t),
      ),
    );
    if (storageLines.length > 0) await influx.writeLp(influx.aggDb, storageLines);

    // Occupation disque : champ absent de la base si aucune VM QEMU running avec agent
    // n'a écrit dans cette fenêtre (ex. fenêtre ne contenant que le cluster de test).
    // InfluxDB 3 Core lève « No field named » sur un champ absent du scan → repli sans
    // ces deux champs (sinon lastTs resterait bloqué sur la fenêtre à jamais).
    const vmDiskSelect = `, AVG(disk_bytes) AS disk_bytes, AVG(disk_alloc_bytes) AS disk_alloc_bytes`;
    const vmSql = (disk: string) =>
      `SELECT date_bin(INTERVAL '5 minutes', time) AS t, ${clusterCol} AS cluster, node, vmid, name,
              AVG(cpu_pct) AS cpu_pct, AVG(mem_bytes) AS mem_bytes,
              AVG(disk_read_bps) AS disk_read_bps, AVG(disk_write_bps) AS disk_write_bps,
              AVG(net_in_bps) AS net_in_bps, AVG(net_out_bps) AS net_out_bps${disk}
        FROM vm_metrics WHERE time >= '${iso(from)}' AND time < '${iso(to)}'
        GROUP BY t, cluster, node, vmid, name ORDER BY t`;
    let vmRows: SqlRow[];
    try {
      vmRows = await influx.querySql<SqlRow>(influx.rawDb, vmSql(vmDiskSelect));
    } catch (err) {
      if (/No field named (disk_bytes|disk_alloc_bytes)/.test((err as Error).message ?? '')) {
        vmRows = await influx.querySql<SqlRow>(influx.rawDb, vmSql(''));
      } else {
        throw err;
      }
    }
    const vmLines = vmRows.map((r) => {
      const fields: Record<string, number> = {
        cpu_pct: round2(num(r.cpu_pct)),
        mem_bytes: Math.round(num(r.mem_bytes)),
          // champs absents sur les anciennes lignes raw → AVG NULL → 0 (fenêtres pré-extension du poller)
          disk_read_bps: Math.round(num(r.disk_read_bps)),
          disk_write_bps: Math.round(num(r.disk_write_bps)),
          net_in_bps: Math.round(num(r.net_in_bps)),
          net_out_bps: Math.round(num(r.net_out_bps)),
        };
        // Occupation disque (réelle) : omise si la fenêtre n'en contient pas (agent indispo / VM récente).
        if (r.disk_bytes != null) fields.disk_bytes = Math.round(num(r.disk_bytes));
        if (r.disk_alloc_bytes != null) fields.disk_alloc_bytes = Math.round(num(r.disk_alloc_bytes));
        return buildLine(
          'vm_metrics',
          { cluster: String(r.cluster), node: String(r.node), vmid: String(r.vmid), name: String(r.name ?? '') },
          fields,
          influxTsToUnix(r.t),
        );
      });
    if (vmLines.length > 0) await influx.writeLp(influx.aggDb, vmLines);

    // Occupation disque PAR FILESYSTEM (mesure vm_fs du poller) — état (gauge), pas un flux →
    // MAX sur la fenêtre (valeur représentative), une série par point de montage. Mesure
    // récente : si aucune ligne vm_fs dans la fenêtre, la requête lève « No field named » → repli.
    const fsDiskSelect = `, MAX(used_bytes) AS used_bytes, MAX(total_bytes) AS total_bytes`;
    const fsSql = (disk: string) =>
      `SELECT date_bin(INTERVAL '5 minutes', time) AS t, ${clusterCol} AS cluster, node, vmid, name, mountpoint, dev${disk}
         FROM vm_fs WHERE time >= '${iso(from)}' AND time < '${iso(to)}'
         GROUP BY t, cluster, node, vmid, name, mountpoint, dev ORDER BY t`;
    let fsRows: SqlRow[] = [];
    try {
      fsRows = await influx.querySql<SqlRow>(influx.rawDb, fsSql(fsDiskSelect));
    } catch (err) {
      if (/No field named/.test((err as Error).message ?? '')) {
        fsRows = await influx.querySql<SqlRow>(influx.rawDb, fsSql(''));
      } else if (!/cannot find table|table vm_fs|does not exist/i.test((err as Error).message ?? '')) {
        throw err;
      }
    }
    const fsLines = fsRows
      .filter((r) => r.used_bytes != null)
      .map((r) =>
        buildLine(
          'vm_fs',
          {
            cluster: String(r.cluster),
            node: String(r.node),
            vmid: String(r.vmid),
            name: String(r.name ?? ''),
            mountpoint: String(r.mountpoint ?? '/'),
            dev: String(r.dev ?? ''),
          },
          {
            used_bytes: Math.round(num(r.used_bytes)),
            total_bytes: Math.round(num(r.total_bytes)),
          },
          influxTsToUnix(r.t),
        ),
      );
    if (fsLines.length > 0) await influx.writeLp(influx.aggDb, fsLines);

    // Occupation réelle par datastore (mesure datastore_metrics du poller) —
    // agrégée dans le bucket infini pour que l'historique d'occupation survive
    // aux 31 j de rétention raw. Dernier point de chaque fenêtre (l'usage est un
    // état, pas un flux → on ne fait pas de moyenne).
    const dsRows = await influx.querySql<SqlRow>(
      influx.rawDb,
      `SELECT date_bin(INTERVAL '5 minutes', time) AS t, ${clusterCol} AS cluster, storage,
              MAX(used_bytes) AS used, MAX(total_bytes) AS total
        FROM datastore_metrics WHERE time >= '${iso(from)}' AND time < '${iso(to)}'
        GROUP BY t, cluster, storage ORDER BY t`,
    );
    const dsLines = dsRows.map((r) =>
      buildLine(
        'datastore_metrics',
        { cluster: String(r.cluster), storage: String(r.storage) },
        {
          used_bytes: Math.round(num(r.used)),
          total_bytes: Math.round(num(r.total)),
        },
        influxTsToUnix(r.t),
      ),
    );
    if (dsLines.length > 0) await influx.writeLp(influx.aggDb, dsLines);
  }
}

