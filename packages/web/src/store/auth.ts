import { create } from 'zustand';
import type { ModuleDef, PublicUser } from '@prox4u/shared';
import { authApi } from '../lib/auth-api';
import { syncModuleCatalog } from '../core/plugin/catalog-sync';

/**
 * État d'authentification (session cookie httpOnly côté serveur).
 * Hydratation au boot via GET /api/auth/me ; le store ne stocke que ce que
 * le serveur autorise (authorizedModules / visibleModuleIds) — zéro logique
 * de permissions côté client.
 */

interface AuthState {
  status: 'loading' | 'authed' | 'unauthed';
  user: PublicUser | null;
  /** entrées du catalogue (une par version) que l'utilisateur PEUT sélectionner */
  authorizedModules: ModuleDef[];
  /** familles effectivement affichées (au moins une version visible) — routes */
  visibleModuleIds: string[];
  /** ids de versions EXACTS visibles (autorisées ∩ préférences) — menu, routes */
  visibleVersionIds: string[];
  /** hydrate depuis /me (boot, retour de page) */
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** bascule un module dans les préférences puis resynchronise */
  toggleModule: (moduleId: string) => Promise<void>;
}

/** Réinitialisation complète de l'état (déconnexion, /me en échec). */
const UNAUTHED = {
  status: 'unauthed' as const,
  user: null,
  authorizedModules: [],
  visibleModuleIds: [],
  visibleVersionIds: [],
};

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  authorizedModules: [],
  visibleModuleIds: [],
  visibleVersionIds: [],

  refresh: async () => {
    try {
      const payload = await authApi.me();
      set({ status: 'authed', ...payload });
    } catch {
      set(UNAUTHED);
    }
  },

  login: async (username, password) => {
    const payload = await authApi.login(username, password); // lève ApiError
    set({ status: 'authed', ...payload });
    // Synchronise le catalogue serveur (crée les entrées par version manquantes),
    // puis re-hydrate /me si de nouvelles entrées ont été créées.
    void syncModuleCatalog()
      .then((r) => {
        if (r.created > 0) return get().refresh();
      })
      .catch(() => {});
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // session déjà morte côté serveur : on continue la déconnexion locale
    }
    set(UNAUTHED);
  },

  toggleModule: async (moduleId) => {
    const user = get().user;
    if (!user) return;
    const next = user.selectedModuleIds.includes(moduleId)
      ? user.selectedModuleIds.filter((id) => id !== moduleId)
      : [...user.selectedModuleIds, moduleId];
    try {
      const payload = await authApi.setPreferences(next);
      set({ ...payload });
    } catch {
      // le serveur refuse (module non autorisé) → on resynchronise l'état
      await get().refresh();
    }
  },
}));
