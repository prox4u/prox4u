/**
 * Types partagés — module node-sensors (métriques locales Telegraf).
 * Données issues de l'agent Telegraf bare-metal sur chaque nœud Proxmox.
 */

/** État SMART d'un disque (dernier point de la table smart_device). */
export interface SmartDevice {
  node: string;
  device: string;
  model: string | null;
  serialNo: string | null;
  healthOk: boolean;
  tempC: number | null;
  powerOnHours: number | null;
  powerCycleCount: number | null;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  uncorrectableSectors: number | null;
  udmaCrcErrors: number | null;
  /** NVMe : pourcentage de vie utilisée (0 = neuf, 100 = fin de vie). */
  percentageUsed: number | null;
  /** NVMe : espace de secours restant (%). */
  availableSpare: number | null;
  /** NVMe : avertissement critique (0 = OK). */
  criticalWarning: number | null;
  lastSeen: number; // unix seconds
}

/** Lecture capteur (table sensors) — température / ventilateur / tension. */
export interface SensorReading {
  node: string;
  chip: string;
  feature: string;
  tempInput: number | null;
  tempCrit: number | null;
  fanInput: number | null;
  inInput: number | null;
  lastSeen: number;
}

/** État ZFS (table zfs) — ARC + pools. */
export interface ZfsStatus {
  node: string;
  arcHits: number | null;
  arcMisses: number | null;
  arcSize: number | null;
  arcCacheSize: number | null;
  poolName: string | null;
  poolState: string | null; // ONLINE / DEGRADED / OFFLINE
  poolSize: number | null;
  poolAllocated: number | null;
  poolFree: number | null;
  lastSeen: number;
}

/** Unité systemd en état non-normal (table systemd_units, active != 'active' ou load != 'loaded'). */
export interface FailedUnit {
  node: string;
  name: string;
  active: string; // activating / active / deactivating / inactive / failed
  sub: string; // running / exited / dead / auto-restart
  load: string; // loaded / not-found / error
  lastSeen: number;
}

/** Réponse GET /api/node-sensors?timeframe=1h. */
export interface NodeSensorsResponse {
  timeframe: string;
  nodes: string[];
  smart: SmartDevice[];
  sensors: SensorReading[];
  zfs: ZfsStatus[];
  failedUnits: FailedUnit[];
  /** 'influx' si les données viennent d'InfluxDB, 'empty' si aucun nœud Telegraf. */
  source: 'influx' | 'empty';
}
