import { authApi } from '../../lib/auth-api';
import { registry } from './registry';

/**
 * Synchronise le catalogue des modules côté serveur avec les versions de
 * plugins enregistrées dans le registry (le serveur ne connaît pas les
 * versions — seul le web le sait). Idempotent : `created > 0` signifie que de
 * nouvelles entrées (état hérité de la famille) ont été créées → relancer un
 * /me pour rafraîchir la visibilité.
 */
export function syncModuleCatalog(): Promise<{ ok: boolean; created: number }> {
  return authApi.catalogSync(registry.list().map((p) => p.manifest.id));
}
