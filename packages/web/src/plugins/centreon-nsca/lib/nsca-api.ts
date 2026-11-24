import type {
  AlarmRule,
  AlarmStats,
  CentreonConfig,
  CentreonPoller,
  MetricId,
  VmMapping,
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
export interface AlarmTargets {
  vms: TargetVm[];
  nodes: TargetNode[];
  clusters: TargetCluster[];
  mappings: { key: string; host: string }[];
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

export const alarmsApi = {
  list: () => request<AlarmList>('/api/alarms'),
  targets: () => request<AlarmTargets>('/api/alarms/targets'),

  create: (rule: Omit<AlarmRule, 'id' | 'createdAt' | 'updatedAt' | 'provisionStatus' | 'provisionMessage' | 'lastSendState' | 'lastSendMessage' | 'lastAlarmAt' | 'lastOutput' | 'currentState'>) =>
    request<{ rule: AlarmRule; provision: ProvisionOutcome }>('/api/alarms/rules', { method: 'POST', body: JSON.stringify(rule) }),
  update: (id: string, patch: Partial<AlarmRule>) =>
    request<{ rule: AlarmRule }>(`/api/alarms/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => request<{ ok: boolean }>(`/api/alarms/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  test: (id: string) => request<{ ok: boolean; code: number; message: string }>(`/api/alarms/rules/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  provision: (id: string) => request<ProvisionOutcome>(`/api/alarms/rules/${encodeURIComponent(id)}/provision`, { method: 'POST' }),

  config: () => request<AlarmConfigPayload>('/api/alarms/config'),
  saveConfig: (payload: { config?: Partial<CentreonConfig> & { nsca?: Partial<CentreonConfig['nsca']> }; pollers?: CentreonPoller[]; mappings?: VmMapping[] }) =>
    request<{ ok: boolean }>('/api/alarms/config', { method: 'PUT', body: JSON.stringify(payload) }),
};
