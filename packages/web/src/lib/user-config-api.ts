import type { UserConfig } from '@prox4u/shared';
import { request } from './auth-api';

/**
 * Personnalisation d'interface par utilisateur — GET/PUT/DELETE /api/user-config.
 * Session cookie httpOnly (same-origin) : même client que auth-api.
 */

export interface UserConfigResponse {
  userId: string;
  /** null = jamais personnalisé (le client construit les défauts depuis le catalogue). */
  config: UserConfig | null;
  lastUpdated: string | null;
}

export const userConfigApi = {
  get: () => request<UserConfigResponse>('/api/user-config'),
  save: (config: UserConfig) =>
    request<UserConfigResponse>('/api/user-config', { method: 'PUT', body: JSON.stringify(config) }),
  reset: () => request<UserConfigResponse>('/api/user-config', { method: 'DELETE' }),
};
