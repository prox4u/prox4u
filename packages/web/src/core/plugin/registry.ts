import type { Plugin } from './types';

/**
 * - 'active' : version canonique de sa famille (la plus récente) — route par
 *   défaut + entrée de menu principale
 * - 'available' : autre version initialisée — exposée dans le menu avec son
 *   badge vN pour comparaison A/B (?v=<id>) et rollback
 * - 'failed' : manifeste invalide ou init() en échec
 */
export type PluginStatus = 'registered' | 'active' | 'available' | 'failed';

export interface RegistryEntry {
  plugin: Plugin;
  status: PluginStatus;
  error?: unknown;
}

class PluginRegistry {
  private entries = new Map<string, RegistryEntry>();

  /** Enregistrer un plugin (le manifeste doit déjà être validé). */
  register(plugin: Plugin): void {
    const id = plugin.manifest.id;
    if (this.entries.has(id)) throw new Error(`plugin « ${id} » déjà enregistré`);
    this.entries.set(id, { plugin, status: 'registered' });
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  /** Tous les plugins enregistrés (quel que soit leur état). */
  list(): Plugin[] {
    return [...this.entries.values()].map((e) => e.plugin);
  }

  /** Version canonique de chaque famille (la plus récente) : route par défaut + entrée de menu principale. */
  active(): Plugin[] {
    return [...this.entries.values()].filter((e) => e.status === 'active').map((e) => e.plugin);
  }

  /** Toutes les versions initialisées (actives + disponibles en A/B). */
  initialized(): Plugin[] {
    return [...this.entries.values()].filter((e) => e.status === 'active' || e.status === 'available').map((e) => e.plugin);
  }

  setActive(id: string, ok: boolean, error?: unknown): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = ok ? 'active' : 'failed';
    entry.error = ok ? undefined : error;
  }

  /** Autre version de la famille (non canonique, A/B + rollback) — exposée dans le menu. */
  setAvailable(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = 'available';
  }

  reset(): void {
    this.entries.clear();
  }
}

/** Registry singleton du host (chargé au bootstrap, statique ensuite). */
export const registry = new PluginRegistry();
