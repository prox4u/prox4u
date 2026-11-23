import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../core/poller.js';
import type { InfluxQueryStats, InfluxWriteStats } from '../../core/influx.js';

/**
 * GET /api/influxdb — auto-monitoring InfluxDB 3 Core (P4, plan-limites-influxdb3.md).
 *
 * Visibilité des limites en continu : état (ping/version/bases), compteurs
 * d'écriture (abandons, file), stats de lecture (latence, dernier error) et
 * headroom fichiers (estimation vs --query-file-limit). Lecture seule, non
 * bloquante (chaque sous-lecture est bornée et défensive).
 *
 * Guard : session requise (hook global de l'auth — comme les autres /api/*).
 */
export interface InfluxDbResponse {
  enabled: boolean;
  ping: boolean;
  version: string | null;
  databases: Array<{ name: string; retention: string | null }>;
  write: InfluxWriteStats;
  query: InfluxQueryStats;
  fileEstimate: {
    chunkDays: number;
    chunkFiles: number;
    yearFiles: number;
    fileLimit: number;
    headroom: 'ok' | 'warn' | 'crit';
  };
}

export function registerInfluxDbRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/influxdb', async (_req, _reply): Promise<InfluxDbResponse> => {
    const influx = ctx.influx;
    if (!influx.enabled) {
      return {
        enabled: false,
        ping: false,
        version: null,
        databases: [],
        write: influx.getStats(),
        query: influx.getQueryStats(),
        fileEstimate: influx.fileEstimate(),
      };
    }
    // Sous-lectures indépendantes et bornées : une qui échoue ne casse pas la route.
    const [ping, info, databases] = await Promise.all([
      influx.ping(),
      influx.getServerInfo(),
      influx.listDatabases(),
    ]);
    return {
      enabled: true,
      ping,
      version: info.version,
      databases,
      write: influx.getStats(),
      query: influx.getQueryStats(),
      fileEstimate: influx.fileEstimate(),
    };
  });
}
