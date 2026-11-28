/**
 * Client API des shards InfluxDB par endpoint (onglet Administration, GitHub #18).
 * Préfixe /api/admin/influx-shards — guard rôle admin côté serveur.
 * Cookies de session httpOnly envoyés automatiquement (same-origin).
 */

export interface InfluxShard {
  endpointId: string;
  url: string;
  token?: string;
  rawDb?: string;
  aggDb?: string;
  rrdDb?: string;
  caCert?: string;
}

export interface InfluxShardsResponse {
  shards: InfluxShard[];
  endpoints: Array<{ id: string; name: string }>;
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
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      throw Object.assign(new Error(body.message ?? body.error ?? `${res.status}`), { status: res.status });
    } catch (e) {
      if (e instanceof Error && 'status' in e) throw e;
      throw Object.assign(new Error(`${path} → HTTP ${res.status}`), { status: res.status });
    }
  }
  return (await res.json()) as T;
}

export const influxShardsApi = {
  /** GET → shards courants + endpoints valides. */
  list(): Promise<InfluxShardsResponse> {
    return request<InfluxShardsResponse>('/api/admin/influx-shards');
  },

  /** POST → upsert un shard (par endpointId). */
  upsert(shard: InfluxShard): Promise<InfluxShardsResponse> {
    return request<InfluxShardsResponse>('/api/admin/influx-shards', {
      method: 'POST',
      body: JSON.stringify(shard),
    });
  },

  /** DELETE /:endpointId → retirer un shard. */
  remove(endpointId: string): Promise<InfluxShardsResponse> {
    return request<InfluxShardsResponse>(
      `/api/admin/influx-shards/${encodeURIComponent(endpointId)}`,
      { method: 'DELETE' },
    );
  },

  /** DELETE → tout retirer (retour instance unique). */
  clearAll(): Promise<InfluxShardsResponse> {
    return request<InfluxShardsResponse>('/api/admin/influx-shards', { method: 'DELETE' });
  },

  /** POST /:endpointId/test → ping de l'instance sharded. */
  test(endpointId: string): Promise<{ endpointId: string; url: string; ping: boolean }> {
    return request<{ endpointId: string; url: string; ping: boolean }>(
      `/api/admin/influx-shards/${encodeURIComponent(endpointId)}/test`,
      { method: 'POST' },
    );
  },
};
