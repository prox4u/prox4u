import { create } from 'zustand';
import {
  clearScopePage,
  setScopePage,
  type PageConfig,
  type UserConfig,
  type UserConfigPage,
} from '@prox4u/shared';
import { userConfigApi } from '../lib/user-config-api';

/**
 * Config de personnalisation d'interface de l'utilisateur connecté.
 *
 * - Le SERVEUR est la source de vérité (GET/PUT/DELETE /api/user-config) —
 *   pas de persist localStorage : le layout suit le compte, pas le navigateur.
 * - Chargement au boot APRÈS l'auth (et à chaque changement d'utilisateur) ;
 *   `config: null` = jamais personnalisé → les pages construisent leurs défauts
 *   depuis leur catalogue de widgets.
 * - Édition : mise à jour locale immédiate + PUT débridé (800 ms), flush
 *   `keepalive` à la fermeture de l'onglet (pagehide).
 * - `dirty` : une modification locale en cours protège contre un `load()` qui
 *   résout tardivement et écraserait le travail de l'utilisateur.
 */

export type UserConfigStatus = 'loading' | 'ready' | 'error';
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface UserConfigState {
  status: UserConfigStatus;
  /** Config serveur (null = jamais personnalisé). */
  config: UserConfig | null;
  saveState: SaveState;
  lastSavedAt: number | null;
  /** true dès la première modification locale (load() n'écrase plus). */
  dirty: boolean;
  /** Charge la config de l'utilisateur courant (boot après auth, changement d'user). */
  load: () => Promise<void>;
  /** Positionne une page / un scope + sauvegarde débridée. */
  updatePage: (page: UserConfigPage, scope: string | undefined, pageCfg: PageConfig) => void;
  /** Supprime une page / un scope (réinitialisation) + sauvegarde débridée. */
  clearPage: (page: UserConfigPage, scope: string | undefined) => void;
  /** Réinitialisation complète (DELETE → retour aux défauts de toutes les pages). */
  resetAll: () => Promise<void>;
  /** Réinitialisation de l'état local (déconnexion — la config n'appartient plus à cet user). */
  invalidate: () => void;
}

const DEBOUNCE_MS = 800;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Flush à la fermeture de l'onglet (posé au module load — closure sur saveNow). */
let flushOnHide: (() => Promise<void>) | null = null;

export const useUserConfig = create<UserConfigState>((set, get) => {
  const saveNow = async (keepalive: boolean) => {
    saveTimer = null;
    const cfg = get().config;
    if (!cfg) return;
    try {
      if (keepalive) {
        // pagehide : keepalive garantit l'achèvement de la requête après le déchargement
        await fetch('/api/user-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg),
          keepalive: true,
        });
        return;
      }
      const res = await userConfigApi.save(cfg);
      // Le serveur pose lastUpdated : on reprend la réponse (config identique + horodatage).
      set({ config: res.config, saveState: 'saved', lastSavedAt: Date.now() });
    } catch {
      if (!keepalive) set({ saveState: 'error' });
    }
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(false), DEBOUNCE_MS);
  };

  flushOnHide = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      return saveNow(true);
    }
    return Promise.resolve();
  };

  return {
    status: 'loading',
    config: null,
    saveState: 'idle',
    lastSavedAt: null,
    dirty: false,

    load: async () => {
      if (get().dirty) return; // modification locale en cours → on ne l'écrase pas
      set({ status: 'loading' });
      try {
        const res = await userConfigApi.get();
        if (get().dirty) return;
        set({ status: 'ready', config: res.config, saveState: 'idle' });
      } catch {
        // Serveur inaccessible : les pages restent fonctionnelles (défauts + re-sauvegarde
        // à la prochaine modification).
        set({ status: 'error', config: null, saveState: 'idle' });
      }
    },

    updatePage: (page, scope, pageCfg) => {
      set({ config: setScopePage(get().config, page, scope, pageCfg), dirty: true, saveState: 'saving' });
      scheduleSave();
    },

    clearPage: (page, scope) => {
      set({ config: clearScopePage(get().config, page, scope), dirty: true, saveState: 'saving' });
      scheduleSave();
    },

    resetAll: async () => {
      try {
        const res = await userConfigApi.reset();
        set({ config: res.config, dirty: false, saveState: 'idle' });
      } catch {
        set({ saveState: 'error' });
      }
    },

    invalidate: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      set({ status: 'loading', config: null, saveState: 'idle', dirty: false, lastSavedAt: null });
    },
  };
});

// Fermeture de l'onglet / navigation : flush de la sauvegarde en attente.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void flushOnHide?.();
  });
}
