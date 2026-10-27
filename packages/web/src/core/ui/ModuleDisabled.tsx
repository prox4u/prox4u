import { OctagonAlert } from 'lucide-react';

/**
 * Écran de repli pour un module dont le plugin est désactivé par feature flag
 * et dont le code legacy a été supprimé après validation (Strangler Fig).
 */
export function ModuleDisabled({ module, flag }: { module: string; flag: string }) {
  return (
    <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border text-center">
      <OctagonAlert className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">Module « {module} » désactivé</p>
      <p className="text-xs text-muted-foreground">
        Activez <code className="rounded bg-secondary px-1.5 py-0.5">{flag}=true</code> pour le charger.
      </p>
    </div>
  );
}
