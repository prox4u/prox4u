import type { AuthProvider } from './providers.js';
import type { SessionStore } from './session.js';
import type { AuthStore } from './store.js';

/**
 * Contexte d'exécution de l'authentification, construit au démarrage (index.ts)
 * et partagé par les routes /api/auth/* + /api/admin/*, le guard global et
 * la vérification du WebSocket /ws. Fichier « feuille » : ne dépend que de
 * ses sœurs pour éviter tout cycle d'imports avec core/.
 */
export interface AuthContext {
  store: AuthStore;
  sessions: SessionStore;
  provider: AuthProvider;
}
