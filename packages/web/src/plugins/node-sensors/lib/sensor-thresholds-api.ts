import type { SensorThresholds, SensorThresholdsResponse } from '@prox4u/shared';

/**
 * Client API des seuils capteurs personnalisés (onglet Administration).
 * Préfixe /api/admin/sensor-thresholds — guard rôle admin côté serveur.
 * Cookies de session httpOnly envoyés automatiquement (same-origin).
 */

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

export const sensorThresholdsApi = {
  /** GET → seuils perso + capteurs (firmware + perso éventuel). */
  list(): Promise<SensorThresholdsResponse> {
    return request<SensorThresholdsResponse>('/api/admin/sensor-thresholds');
  },

  /** PUT → remplace le jeu de seuils (clamp perso ≤ firmware côté serveur). */
  save(thresholds: SensorThresholds): Promise<SensorThresholdsResponse> {
    return request<SensorThresholdsResponse>('/api/admin/sensor-thresholds', {
      method: 'PUT',
      body: JSON.stringify({ thresholds }),
    });
  },

  /** DELETE → tout réinitialiser (retour firmware partout). */
  resetAll(): Promise<SensorThresholdsResponse> {
    return request<SensorThresholdsResponse>('/api/admin/sensor-thresholds', { method: 'DELETE' });
  },

  /** DELETE :node/:chip/:feature → réinitialiser un capteur. */
  resetOne(node: string, chip: string, feature: string): Promise<SensorThresholdsResponse> {
    const p = encodeURIComponent;
    return request<SensorThresholdsResponse>(
      `/api/admin/sensor-thresholds/${p(node)}/${p(chip)}/${p(feature)}`,
      { method: 'DELETE' },
    );
  },
};
