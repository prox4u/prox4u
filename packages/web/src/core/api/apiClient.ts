import type { DatastoreHistoryResponse, MetricsTimeframe, NodeSensorsResponse, ProxmoxInventoryResponse, SensorHistoryResponse, SmartHistoryResponse, VmFsResponse } from '@prox4u/shared';
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

/** Historique d'occupation + capacity planning par datastore d'un endpoint. */
export function fetchStorageDatastoreHistory(endpoint: string, range: 'year' | 'month' = 'year'): Promise<DatastoreHistoryResponse> {
  return getJson<DatastoreHistoryResponse>(`/api/storage-datastore-history?endpoint=${encodeURIComponent(endpoint)}&range=${range}`);
}

/**
 * Historique des valeurs d'un capteur (température, °C) — fenêtre « historique »
 * de la page Capteurs. Les trous de la série = nœud sans mesure (éteint).
 */
export function fetchSensorHistory(node: string, chip: string, feature: string, range: 'year' | 'month' = 'month'): Promise<SensorHistoryResponse> {
  return getJson<SensorHistoryResponse>(
    `/api/node-sensors-history?node=${encodeURIComponent(node)}&chip=${encodeURIComponent(chip)}&feature=${encodeURIComponent(feature)}&range=${range}`,
  );
}

/**
 * Historique de température d'un DISQUE SMART (table smart_device). Pas de
 * seuil firmware (les disques n'ont pas de `temp_crit`) — le front trace la
 * référence fixe de la table. 0 °C (pas de capteur) = exclu de la série.
 */
export function fetchSmartHistory(node: string, device: string, range: 'year' | 'month' = 'month'): Promise<SmartHistoryResponse> {
  return getJson<SmartHistoryResponse>(
    `/api/smart-device-history?node=${encodeURIComponent(node)}&device=${encodeURIComponent(device)}&range=${range}`,
  );
}

/** Détail d'une VM (live + config + snapshots) — plugin vm-view. */
export function fetchVmDetail(endpoint: string, vmid: number): Promise<VmDetailResponse> {
  return getJson<VmDetailResponse>(`/api/vm-config?endpoint=${encodeURIComponent(endpoint)}&vmid=${vmid}`);
}

/** Métriques historiques d'une VM (InfluxDB vm_metrics) — onglet Monitor. */
export function fetchVmMetrics(endpoint: string, vmid: number, timeframe: MetricsTimeframe): Promise<VmMetricsResponse> {
  return getJson<VmMetricsResponse>(
    `/api/vm-metrics?endpoint=${encodeURIComponent(endpoint)}&vmid=${vmid}&timeframe=${timeframe}`,
  );
}

/** Occupation disque PAR FILESYSTEM d'une VM (InfluxDB vm_fs) — onglet Monitor, un graphe par partition. */
export function fetchVmFs(endpoint: string, vmid: number, timeframe: MetricsTimeframe): Promise<VmFsResponse> {
  return getJson<VmFsResponse>(
    `/api/vm-fs?endpoint=${encodeURIComponent(endpoint)}&vmid=${vmid}&timeframe=${timeframe}`,
  );
}

/** Inventaire Proxmox consolidé de tous les endpoints (cache serveur 5 min) — plugin proxmox-inventory. */
export function fetchProxmoxInventory(): Promise<ProxmoxInventoryResponse> {
  return getJson<ProxmoxInventoryResponse>('/api/proxmox-inventory');
}

/** Métriques locales Telegraf (SMART, capteurs, ZFS, unités systemd) — plugin node-sensors. */
export function fetchNodeSensors(): Promise<NodeSensorsResponse> {
  return getJson<NodeSensorsResponse>('/api/node-sensors');
}
