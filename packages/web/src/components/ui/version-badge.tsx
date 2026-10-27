import { parsePluginVersion } from '@prox4u/shared';
import { cn } from '../../lib/utils';

/**
 * Badge de version d'un plugin (v1 neutre, vN+ accentué) — même style partout
 * (menu de gauche, catalogue admin, profil, titres de page).
 */
export function VersionBadge({ pluginId, className }: { pluginId: string; className?: string }) {
  const { family, version } = parsePluginVersion(pluginId);
  return (
    <span
      className={cn(
        'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
        pluginId === family ? 'border-border text-muted-foreground' : 'border-primary/40 bg-primary/10 text-primary',
        className,
      )}
    >
      v{version}
    </span>
  );
}
