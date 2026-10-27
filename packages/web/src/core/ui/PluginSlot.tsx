import type { ReactNode } from 'react';
import { registry } from '../plugin/registry';

/**
 * Point de montage (Extension Point) : rend le composant principal d'un plugin
 * actif, ou le fallback si le plugin est absent/inactif/sans Component.
 */
export function PluginSlot({ id, fallback = null }: { id: string; fallback?: ReactNode }) {
  const entry = registry.get(id);
  if (entry?.status === 'active' && entry.plugin.Component) {
    const Component = entry.plugin.Component;
    return <Component />;
  }
  return <>{fallback}</>;
}
