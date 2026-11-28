import type {
  AlarmRule,
  AlarmStats,
  CentreonConfig,
  CentreonPoller,
  FailedUnit,
  MetricId,
  SensorReading,
  SmartDevice,
  VmMapping,
  ZfsStatus,
} from '@prox4u/shared';

/**
 * Client API du module Alarmes & Checks NSCA (préfixe /api/alarms/*).
 * Cookies de session httpOnly envoyés automatiquement (same-origin).
 */

export interface AlarmApiError extends Error {
  status: number;
  fields?: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let fields: string[] | undefined;
    try {
      const body = (await res.json()) as { error?: string; fields?: string[]; message?: string };
      fields = body.fields;
      throw Object.assign(new Error(body.message ?? body.error ?? `${res.status}`), { status: res.status, fields });
    } catch (e) {
      if (e instanceof Error && 'status' in e) throw e;
      throw Object.assign(new Error(`${path} → HTTP ${res.status}`), { status: res.status });
    }
  }
  return (await res.json()) as T;
}

/** Cible du formulaire : VM (vmid) ou nœud. */
export interface TargetVm {
  endpointId: string;
  vmid: number;
  name: string;
  node: string;
}
export interface TargetNode {
  endpointId: string;
  node: string;
  online: boolean;
}
/** Cible du formulaire : cluster (quorum) — un endpoint = un cluster Proxmox. */
export interface TargetCluster {
  endpointId: string;
  name: string;
}
/**
 * Cibles capteurs (GitHub #4) — source InfluxDB raw (agent Telegraf).
 * Alimente les sélecteurs du formulaire pour les règles capteurs
 * (SMART / température / unité systemd / pool ZFS). `null` si InfluxDB
 * indisponible ou agent non déployé.
 */
export interface AlarmSensorTargets {
  /** Disques SMART (node + device + model). */
  smart: SmartDevice[];
  /** Capteurs lm-sensors (node + chip + feature + tempCrit). */
  sensors: SensorReading[];
  /** TOUTES les unités systemd (node + name) — pas seulement les échouées. */
  units: FailedUnit[];
  /** Pools ZFS (node + poolName + poolState). */
  pools: ZfsStatus[];
}
export interface AlarmTargets {
  vms: TargetVm[];
  nodes: TargetNode[];
  clusters: TargetCluster[];
  mappings: { key: string; host: string }[];
  /** Cibles capteurs (GitHub #4) — `null` si InfluxDB indisponible. */
  sensors: AlarmSensorTargets | null;
}

/**
 * Identifiant lisible du capteur ciblé (pour le `label` de la règle) :
 * `node / <identifiant>`. Vide si aucune métrique capteur (label = nœud).
 */
export function sensorTargetIdentifier(target: { device?: string; chip?: string; feature?: string; unit?: string; pool?: string }): string {
  if (target.device) return target.device;
  if (target.chip && target.feature) return `${target.chip}/${target.feature}`;
  if (target.unit) return target.unit;
  if (target.pool) return target.pool;
  return '';
}

/**
 * Construit la cible NŒUD du payload (GitHub #4) : nœud + identifiant capteur
 * (device / chip+feature / unit / pool) + label lisible `node / <id>`. Les
 * champs capteurs vides ne sont pas émis (cible propre pour la validation).
 */
export function buildNodeTarget(values: { endpointId: string; node: string; device?: string; chip?: string; feature?: string; unit?: string; pool?: string }) {
  const id = sensorTargetIdentifier(values);
  return {
    kind: 'node' as const,
    endpointId: values.endpointId,
    node: values.node,
    label: id ? `${values.node} / ${id}` : values.node,
    ...(values.device ? { device: values.device } : {}),
    ...(values.chip ? { chip: values.chip, feature: values.feature } : {}),
    ...(values.unit ? { unit: values.unit } : {}),
    ...(values.pool ? { pool: values.pool } : {}),
  };
}

/** Quels secrets Centreon sont fournis par le .env du serveur (CENTREON_*). */
export interface CentreonEnvSecrets {
  restToken: boolean;
  nscaPassword: boolean;
  clapiPassword: boolean;
}

/** Payload GET /api/alarms. */
export interface AlarmList {
  rules: AlarmRule[];
  pollers: CentreonPoller[];
  stats: AlarmStats;
  config: CentreonConfig;
  envSecrets: CentreonEnvSecrets;
  metrics: { vm: MetricId[]; node: MetricId[]; cluster: MetricId[] };
}

/** Payload GET /api/alarms/config. */
export interface AlarmConfigPayload {
  config: CentreonConfig;
  envSecrets: CentreonEnvSecrets;
  pollers: CentreonPoller[];
  mappings: VmMapping[];
}

export interface ProvisionOutcome {
  ok: boolean;
  message: string;
}

/**
 * Résultat de la suppression d'une règle (GitHub #20 — cohérence Prox4u ↔
 * Centreon) : `ok` = règle retirée (`centreon` = deleted/not-found) ;
 * `pending` = central injoignable, la règle reste en « suppression en attente »
 * (réessai automatique).
 */
export interface DeleteOutcome {
  ok: boolean;
  pending?: boolean;
  centreon?: 'deleted' | 'not-found' | 'pending';
  message?: string;
}

export const alarmsApi = {
  list: () => request<AlarmList>('/api/alarms'),
  targets: () => request<AlarmTargets>('/api/alarms/targets'),

  create: (rule: Omit<AlarmRule, 'id' | 'createdAt' | 'updatedAt' | 'provisionStatus' | 'provisionMessage' | 'lastSendState' | 'lastSendMessage' | 'lastAlarmAt' | 'lastOkSendAt' | 'lastOutput' | 'currentState' | 'acknowledgedAt' | 'acknowledgedBy'>) =>
    request<{ rule: AlarmRule; provision: ProvisionOutcome }>('/api/alarms/rules', { method: 'POST', body: JSON.stringify(rule) }),
  update: (id: string, patch: Partial<AlarmRule>) =>
    request<{ rule: AlarmRule }>(`/api/alarms/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => request<DeleteOutcome>(`/api/alarms/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  test: (id: string) => request<{ ok: boolean; code: number; message: string }>(`/api/alarms/rules/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  provision: (id: string) => request<ProvisionOutcome>(`/api/alarms/rules/${encodeURIComponent(id)}/provision`, { method: 'POST' }),
  /** Acknowledgment (moteur v2 — marqueur, ne coupe pas les trames). */
  ack: (id: string) => request<{ rule: AlarmRule }>(`/api/alarms/rules/${encodeURIComponent(id)}/ack`, { method: 'POST' }),
  /** Retrait de l'acknowledgment. */
  unack: (id: string) => request<{ rule: AlarmRule }>(`/api/alarms/rules/${encodeURIComponent(id)}/unack`, { method: 'POST' }),

  config: () => request<AlarmConfigPayload>('/api/alarms/config'),
  saveConfig: (payload: { config?: Partial<CentreonConfig> & { nsca?: Partial<CentreonConfig['nsca']> }; pollers?: CentreonPoller[]; mappings?: VmMapping[] }) =>
    request<{ ok: boolean }>('/api/alarms/config', { method: 'PUT', body: JSON.stringify(payload) }),
};
