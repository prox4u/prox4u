import type {
  CapacityForecast,
  MetricSource,
  MetricsResponse,
  NetworkTopology,
  OsSlice,
  OvercommitRiskResponse,
  TrendPoint,
} from '@prox4u/shared';

export interface CapacityResponse {
  cpu: CapacityForecast;
  ram: CapacityForecast;
  disk: CapacityForecast;
  source: MetricSource;
}

export interface TrendsResponse {
  trend7d: TrendPoint[];
  os: OsSlice[];
  source: MetricSource;
}

/** Réponse de GET /api/network-topology (tous les endpoints). */
export interface NetworkTopologyResponse {
  topologies: NetworkTopology[];
}

export type { MetricsResponse, OvercommitRiskResponse };

/** Réponses de GET /api/storage-inventory et /api/storage-datastore-history — re-export depuis shared. */
export type { StorageInventoryResponse, DatastoreHistoryResponse, DatastoreHistoryEntry } from '@prox4u/shared';
export type { VmDetailResponse, VmMetricsResponse } from '@prox4u/shared';

/**
 * Réponse de GET /api/influxdb (module InfluxDB 3 Core). `canAct` = la session
 * peut lancer les actions (admin ou groupe INFLUX_ACTION_GROUPS) — le front
 * masque/affiche le panneau Actions en conséquence.
 */
export interface InfluxDbResponse {
  enabled: boolean;
  ping: boolean;
  version: string | null;
  databases: Array<{ name: string; retention: string | null }>;
  write: {
    enabled: boolean;
    queueDepth: number;
    enqueued: number;
    flushed: number;
    dropped: number;
    failedBatches: number;
    lastDropAt: number | null;
    lastErrorAt: number | null;
  };
  query: {
    lastQueryMs: number | null;
    lastQueryAt: number | null;
    lastQueryError: string | null;
  };
  fileEstimate: {
    chunkDays: number;
    chunkFiles: number;
    yearFiles: number;
    fileLimit: number;
    headroom: 'ok' | 'warn' | 'crit';
  };
  /** état d'archivage (consolidated → CSV) — null si l'archiver n'est pas monté. */
  archive: { lastArchivedTs: number; archiveDir: string; fileCount: number; totalBytes: number } | null;
  canAct: boolean;
}
