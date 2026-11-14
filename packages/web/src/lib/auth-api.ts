import type { Group, ModuleDef, PublicUser, Role } from '@prox4u/shared';

/**
 * Client API d'authentification et d'administration.
 * Les cookies de session (httpOnly) sont envoyés automatiquement (same-origin).
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    /** code machine lisible (i18n : auth.error.<code>, profile.password.error.<code>…) */
    public code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** Client HTTP same-origin (cookie httpOnly automatique) — partagé par user-config-api. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let code = 'generic';
    try {
      const body = (await res.json()) as { code?: string };
      if (body.code) code = body.code;
    } catch {
      // corps non JSON : code générique
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Payload renvoyé par login et /me. */
export interface AuthPayload {
  user: PublicUser;
  /** Entrées du catalogue (une par version) que l'utilisateur peut sélectionner. */
  authorizedModules: ModuleDef[];
  /** Familles visibles (routes). */
  visibleModuleIds: string[];
  /** Ids de versions EXACTS visibles (autorisées ∩ préférences) — menu, routes. */
  visibleVersionIds: string[];
}

export const authApi = {
  login: (username: string, password: string) =>
    request<AuthPayload>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<AuthPayload>('/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  /** Préférences de modules — uniquement parmi les modules autorisés. */
  setPreferences: (moduleIds: string[]) =>
    request<AuthPayload>('/api/auth/preferences', { method: 'PUT', body: JSON.stringify({ moduleIds }) }),
  /** Synchronise le catalogue serveur avec les versions de plugins enregistrées. */
  catalogSync: (ids: string[]) =>
    request<{ ok: boolean; created: number }>('/api/auth/catalog-sync', { method: 'PUT', body: JSON.stringify({ ids }) }),
};

/** Vue d'administration : utilisateurs, groupes (membres + modules), catalogue. */
export interface AdminGroup extends Group {
  memberIds: string[];
  moduleIds: string[];
}

export interface AdminState {
  users: PublicUser[];
  groups: AdminGroup[];
  modules: ModuleDef[];
}

export const adminApi = {
  state: () => request<AdminState>('/api/admin/state'),

  createUser: (input: { username: string; displayName: string; password: string; role: Role; groupIds: string[] }) =>
    request<{ user: PublicUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  updateUser: (id: string, patch: { displayName?: string; role?: Role; active?: boolean; groupIds?: string[] }) =>
    request<{ user: PublicUser }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  resetPassword: (id: string, newPassword?: string) =>
    request<{ temporaryPassword: string }>(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(newPassword ? { newPassword } : {}),
    }),

  createGroup: (name: string, description: string) =>
    request<Group>('/api/admin/groups', { method: 'POST', body: JSON.stringify({ name, description }) }),
  updateGroup: (id: string, patch: { name?: string; description?: string }) =>
    request<Group>(`/api/admin/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteGroup: (id: string) => request<{ ok: boolean }>(`/api/admin/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setGroupMembers: (id: string, userIds: string[]) =>
    request<{ ok: boolean }>(`/api/admin/groups/${encodeURIComponent(id)}/members`, {
      method: 'PUT',
      body: JSON.stringify({ userIds }),
    }),
  setGroupModules: (id: string, moduleIds: string[]) =>
    request<{ ok: boolean }>(`/api/admin/groups/${encodeURIComponent(id)}/modules`, {
      method: 'PUT',
      body: JSON.stringify({ moduleIds }),
    }),

  setModuleGlobal: (id: string, globallyEnabled: boolean) =>
    request<{ ok: boolean }>(`/api/admin/modules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ globallyEnabled }),
    }),
};
