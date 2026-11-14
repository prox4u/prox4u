import { X, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PageConfig } from '@prox4u/shared';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { CoreWidgetDef } from './types';

interface Props {
  /** Catalogue courant de la page (statiques + dynamiques). */
  catalog: CoreWidgetDef[];
  /** PageConfig MERGÉE (layout = affichés, library = retirés). */
  config: PageConfig;
  /** Réinsérer un widget depuis la bibliothèque. */
  onAdd: (widgetId: string) => void;
  /** Retirer un widget de la grille (→ bibliothèque). */
  onRemove: (widgetId: string) => void;
  /** Fermer le panneau. */
  onClose: () => void;
}

/**
 * Panneau BIBLIOTHÈQUE de la page (side panel non modale, toujours accessible
 * via le bouton « Bibliothèque » de la barre d'outils) :
 *  - « Affichés » : widgets de la grille, avec bouton Retirer ;
 *  - « Bibliothèque » : widgets retirés, avec bouton Afficher.
 * Chaque action passe par le store user-config (défense + PUT débridé).
 */
export function WidgetLibraryPanel({ catalog, config, onAdd, onRemove, onClose }: Props) {
  const { t } = useTranslation();
  const shownIds = new Set(config.layout.map((i) => i.widgetId));
  const shown = catalog.filter((c) => shownIds.has(c.id));
  const hidden = catalog.filter((c) => !shownIds.has(c.id));

  return (
    <aside className="w-64 shrink-0 rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">{t('widgets.library')}</h2>
        <button
          onClick={onClose}
          title={t('widgets.close')}
          aria-label={t('widgets.close')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t('widgets.library.hint')}</p>

        <section>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('widgets.shown')} ({shown.length})
          </h3>
          <ul className="mt-1.5 space-y-1">
            {shown.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5">
                <span className="min-w-0 truncate text-xs" title={c.title}>
                  {c.title}
                </span>
                <Button variant="ghost" size="sm" onClick={() => onRemove(c.id)} title={t('widgets.remove.title')} className="shrink-0 text-muted-foreground">
                  {t('widgets.remove')}
                </Button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('widgets.inLibrary')} ({hidden.length})
          </h3>
          {hidden.length === 0 ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{t('widgets.emptyLibrary')}</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {hidden.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5">
                  <span className="min-w-0 truncate text-xs" title={c.title}>
                    {c.title}
                  </span>
                  <Button
                    size="sm"
                    onClick={() => onAdd(c.id)}
                    title={t('widgets.add.title')}
                    className="shrink-0"
                  >
                    <Plus className="h-3 w-3" />
                    {t('widgets.add')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

/** Compteur compact (badge) du nombre de widgets dans la bibliothèque. */
export function LibraryCountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <Badge tone="primary">{count}</Badge>;
}
