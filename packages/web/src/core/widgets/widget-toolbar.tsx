import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Library, Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useCustomizablePage } from './customizable-page';
import { useUserConfig } from '../../store/user-config';

interface Props {
  /** Panneau bibliothèque ouvert ? (le bouton est le seul point d'entrée). */
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  /** Réinitialiser la page courante (layout par défaut) — avec confirmation. */
  onReset: () => void;
  /** Nombre de widgets dans la bibliothèque (badge sur le bouton). */
  libraryCount: number;
}

/**
 * Barre d'outils de personnalisation d'une page : bouton BIBLIOTHÈQUE
 * (panneau latéral non modale, compteur de widgets retirés), bouton
 * RÉINITIALISER (layout par défaut, avec confirmation) et indicateur de
 * sauvegarde (store user-config — PUT débridé côté serveur).
 */
export function WidgetToolbar({ libraryOpen, onToggleLibrary, onReset, libraryCount }: Props) {
  const { t } = useTranslation();

  // Signale à la topbar que la page a sa propre barre d'outils (→ le bouton
  // de reset v1 de la topbar se masque pendant que la page est montée).
  useEffect(() => {
    useCustomizablePage.getState().setActive(true);
    return () => useCustomizablePage.getState().setActive(false);
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        variant={libraryOpen ? 'default' : 'outline'}
        size="sm"
        onClick={onToggleLibrary}
        aria-expanded={libraryOpen}
      >
        <Library className="h-3.5 w-3.5" />
        {t('widgets.library')}
        {libraryCount > 0 && <Badge tone="primary">{libraryCount}</Badge>}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        title={t('widgets.reset.title')}
        onClick={() => {
          if (window.confirm(t('widgets.reset.confirm'))) onReset();
        }}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t('widgets.reset')}
      </Button>
      <SaveIndicator />
    </div>
  );
}

/** Indicateur d'état de sauvegarde (débridé 800 ms + flush pagehide). */
export function SaveIndicator() {
  const { t } = useTranslation();
  const saveState = useUserConfig((s) => s.saveState);
  if (saveState === 'idle') return null;
  if (saveState === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('widgets.saving')}
      </span>
    );
  }
  if (saveState === 'saved') {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-ok">
        <CheckCircle2 className="h-3 w-3" />
        {t('widgets.saved')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-crit" title={t('widgets.saveError')}>
      <AlertTriangle className="h-3 w-3" />
      {t('widgets.saveErrorShort')}
    </span>
  );
}
