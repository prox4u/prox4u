import type {
  DatastoreHistoryResponse,
  MetricsTimeframe,
  NodeDiskioResponse,
  NodeHardwareResponse,
  NodeHostHistoryResponse,
  NodeNetResponse,
  NodeSensorsResponse,
  NodeSystemResponse,
  NodeTempsResponse,
  ProxmoxInventoryResponse,
  SensorHistoryResponse,
  SmartHistoryResponse,
  SmartTempsResponse,
  VmDiskioResponse,
  VmFsResponse,
  VmNetResponse,
  ZfsArcResponse,
} from '@prox4u/shared';
import type { InfluxHistoryResponse } from '@prox4u/shared';
import type {
  CapacityResponse,
  InfluxDbResponse,
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

/** Capacity planning au NIVEAU NŒUD (disk = rootfs du nœud) — /api/node-capacity. */
export function fetchNodeCapacity(endpoint: string, node: string): Promise<CapacityResponse> {
  const path = `/api/node-capacity?node=${encodeURIComponent(node)}`;
  return getJson<CapacityResponse>(withEndpoint(path, endpoint));
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

/** Métriques système hôte (load / iowait / swap / usage par cœur) — dernier point par nœud, Vue d'ensemble. */
export function fetchNodeSystem(): Promise<NodeSystemResponse> {
  return getJson<NodeSystemResponse>('/api/node-system');
}

/** Empreinte matérielle par nœud (modèle CPU + DMI) — quasi-statique, page nœud v4. */
export function fetchNodeHardware(): Promise<NodeHardwareResponse> {
  return getJson<NodeHardwareResponse>('/api/node-hardware');
}

/** I/O disque par device PHYSIQUE d'un nœud (counters diskio → débits, buckets) — Vue d'ensemble. */
export function fetchNodeDiskio(node: string, timeframe: MetricsTimeframe): Promise<NodeDiskioResponse> {
  return getJson<NodeDiskioResponse>(`/api/node-diskio?node=${encodeURIComponent(node)}&timeframe=${timeframe}`);
}

/** I/O disque PAR DISQUE d'une VM (agent hôte + mapping device-mapper) — Monitor VM. */
export function fetchVmDiskio(endpoint: string, vmid: number, timeframe: MetricsTimeframe): Promise<VmDiskioResponse> {
  return getJson<VmDiskioResponse>(
    `/api/vm-diskio?endpoint=${encodeURIComponent(endpoint)}&vmid=${vmid}&timeframe=${timeframe}`,
  );
}

/** Trafic réseau PAR INTERFACE d'un nœud hôte (Telegraf net, tap des VMs exclus) — Monitor nœud. */
export function fetchNodeNet(node: string, timeframe: MetricsTimeframe): Promise<NodeNetResponse> {
  return getJson<NodeNetResponse>(`/api/node-net?node=${encodeURIComponent(node)}&timeframe=${timeframe}`);
}

/** Températures PAR CHIP (Telegraf sensors, max du chip par bucket) — Monitor nœud v4. */
export function fetchNodeTemps(node: string, timeframe: MetricsTimeframe): Promise<NodeTempsResponse> {
  return getJson<NodeTempsResponse>(`/api/node-temps?node=${encodeURIComponent(node)}&timeframe=${timeframe}`);
}

/** Températures PAR DISQUE (Telegraf smart_device, temp_c > 0) — Monitor nœud v4. */
export function fetchSmartTemps(node: string, timeframe: MetricsTimeframe): Promise<SmartTempsResponse> {
  return getJson<SmartTempsResponse>(`/api/smart-temps?node=${encodeURIComponent(node)}&timeframe=${timeframe}`);
}

/** ZFS ARC (taille + max + hit rate) — Monitor nœud v4. */
export function fetchZfsArc(node: string, timeframe: MetricsTimeframe): Promise<ZfsArcResponse> {
  return getJson<ZfsArcResponse>(`/api/zfs-arc?node=${encodeURIComponent(node)}&timeframe=${timeframe}`);
}

/** Charge 1/5/15 + swap (Telegraf system + mem) — Monitor nœud v4 (widgets « Charge moyenne » et « Swap »). */
export function fetchNodeSystemHistory(node: string, timeframe: MetricsTimeframe): Promise<NodeHostHistoryResponse> {
  return getJson<NodeHostHistoryResponse>(`/api/node-system-history?node=${encodeURIComponent(node)}&timeframe=${timeframe}`);
}

/** Trafic réseau PAR INTERFACE d'une VM (agent hôte + joint MAC → tap) — Monitor VM. */
export function fetchVmNet(endpoint: string, vmid: number, timeframe: MetricsTimeframe): Promise<VmNetResponse> {
  return getJson<VmNetResponse>(
    `/api/vm-net?endpoint=${encodeURIComponent(endpoint)}&vmid=${vmid}&timeframe=${timeframe}`,
  );
}

// ---------- Module InfluxDB 3 Core (vision + action) ----------

/** État InfluxDB (ping/version/bases/compteurs/headroom/canAct) — page /influxdb. */
export function fetchInfluxDb(): Promise<InfluxDbResponse> {
  return getJson<InfluxDbResponse>('/api/influxdb');
}

/** Historique InfluxDB (file/abandons/latence/enfilement) — graphiques, cache serveur 5 min. */
export function fetchInfluxHistory(range: '24h' | '7d' | '30d' = '24h'): Promise<InfluxHistoryResponse> {
  return getJson<InfluxHistoryResponse>(`/api/influxdb/history?range=${range}`);
}

/** Tables d'une base InfluxDB (défaut consolidated) — liste dynamique, cache serveur 5 min. */
export function fetchInfluxTables(db?: string): Promise<{ db: string; tables: string[] }> {
  return getJson<{ db: string; tables: string[] }>(`/api/influxdb/tables${db ? `?db=${encodeURIComponent(db)}` : ''}`);
}

/**
 * Lance une action InfluxDB (POST /api/influxdb/actions/<action>).
 * `action` ∈ flush | archive/run | archive/reset | export | database/recreate |
 * database/drop | table/drop. Le guard (admin ou groupe) renvoie 403 sinon.
 */
export async function postInfluxAction(action: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/influxdb/actions/${action}`, {
    method: 'POST',
    // Content-Type JSON seulement s'il y a un body : Fastify rejette un body
    // vide avec Content-Type application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(`${action} → HTTP ${res.status}`) as Error & { code?: string; status: number };
    err.code = typeof json.code === 'string' ? json.code : undefined;
    err.status = res.status;
    throw err;
  }
  return json;
}
