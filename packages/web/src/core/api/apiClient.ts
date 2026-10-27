import type { MetricsTimeframe } from '@prox4u/shared';
import type {
  CapacityResponse,
  MetricsResponse,
  NetworkTopologyResponse,
  OvercommitRiskResponse,
  StorageInventoryResponse,
  TrendsResponse,
  VmDetailResponse,
  VmMetricsResponse,
} from './types';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

function withEndpoint(path: string, endpoint?: string): string {
  if (!endpoint) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}endpoint=${encodeURIComponent(endpoint)}`;
}

export function fetchCapacity(endpoint?: string): Promise<CapacityResponse> {
  return getJson<CapacityResponse>(withEndpoint('/api/capacity', endpoint));
}

export function fetchTrends(endpoint?: string): Promise<TrendsResponse> {
  return getJson<TrendsResponse>(withEndpoint('/api/trends', endpoint));
}

export function fetchMetrics(timeframe: MetricsTimeframe, endpoint?: string, node?: string): Promise<MetricsResponse> {
  const path = `/api/metrics?timeframe=${timeframe}${node ? `&node=${encodeURIComponent(node)}` : ''}`;
  return getJson<MetricsResponse>(withEndpoint(path, endpoint));
}

export function fetchOvercommitRisk(endpoint?: string): Promise<OvercommitRiskResponse> {
  return getJson<OvercommitRiskResponse>(withEndpoint('/api/overcommit-risk', endpoint));
}

/** Topologie réseau de tous les endpoints (cache serveur 5 min). */
export function fetchNetworkTopology(): Promise<NetworkTopologyResponse> {
  return getJson<NetworkTopologyResponse>('/api/network-topology');
}

/** Inventaire stockage de tous les endpoints (cache serveur 5 min). */
export function fetchStorageInventory(): Promise<StorageInventoryResponse> {
  return getJson<StorageInventoryResponse>('/api/storage-inventory');
}

/** Détail d'une VM (live + config + snapshots) — plugin vm-inventory. */
export function fetchVmDetail(endpoint: string, vmid: number): Promise<VmDetailResponse> {
  return getJson<VmDetailResponse>(`/api/vm-config?endpoint=${encodeURIComponent(endpoint)}&vmid=${vmid}`);
}

/** Métriques historiques d'une VM (InfluxDB vm_metrics) — onglet Monitor. */
export function fetchVmMetrics(endpoint: string, vmid: number, timeframe: MetricsTimeframe): Promise<VmMetricsResponse> {
  return getJson<VmMetricsResponse>(
    `/api/vm-metrics?endpoint=${encodeURIComponent(endpoint)}&vmid=${vmid}&timeframe=${timeframe}`,
  );
}
