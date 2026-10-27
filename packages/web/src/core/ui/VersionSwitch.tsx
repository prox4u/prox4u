import type { ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface VersionRef {
  /** id du plugin (ex. 'vm-inventory_v2'). */
  id: string;
  element: ComponentType;
}

/**
 * Route partagée par plusieurs versions d'une même famille : rend la version
 * demandée via `?v=<id de plugin>` (défaut : la version canonique, la plus
 * récente). Permet la comparaison A/B des versions sans changer l'URL
 * canonique de la famille.
 */
export function VersionSwitch({ versions, activeId }: { versions: VersionRef[]; activeId: string }) {
  const [params] = useSearchParams();
  const v = params.get('v');
  const match =
    (v ? versions.find((x) => x.id === v) : undefined) ??
    versions.find((x) => x.id === activeId) ??
    versions[0];
  const El = match.element;
  return <El />;
}
