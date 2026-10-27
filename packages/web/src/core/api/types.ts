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

/** Réponse de GET /api/storage-inventory (tous les endpoints) — re-export depuis shared. */
export type { StorageInventoryResponse } from '@prox4u/shared';
export type { VmDetailResponse, VmMetricsResponse } from '@prox4u/shared';
