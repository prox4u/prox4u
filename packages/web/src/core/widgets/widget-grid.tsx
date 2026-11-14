import { useMemo, type ReactNode } from 'react';
import { GripVertical, X } from 'lucide-react';
import { useContainerWidth, ResponsiveGridLayout, type Breakpoints, type LayoutItem } from 'react-grid-layout';
import { useTranslation } from 'react-i18next';
import type { PageConfig, WidgetItem } from '@prox4u/shared';
import { Card, CardContent } from '../../components/ui/card';
import type { CoreWidgetDef, WidgetRenderCtx } from './types';

/** Breakpoints / colonnes identiques aux grilles existantes (Vue d'ensemble v1, dashboard endpoint). */
const BREAKPOINTS: Breakpoints = { lg: 1200, md: 800, sm: 400 };
const BREAKPOINT_COLS: Breakpoints = { lg: 12, md: 8, sm: 4 };

interface FrameProps {
  def: CoreWidgetDef;
  ctx: WidgetRenderCtx;
  onRemove: () => void;
  children: ReactNode;
}

/**
 * Frame de widget : carte + en-tête DRAGGABLE (classe `.drag-handle` — le handle
 * RGL, boutons/liens exclus via `dragConfig.cancel`), titre + sous-titre
 * (nom de VM / de nœud), actions extra (export CSV…) et bouton « retirer »
 * (→ bibliothèque de la page).
 */
export function WidgetFrame({ def, ctx, onRemove, children }: FrameProps) {
  const { t } = useTranslation();
  return (
    <Card className="h-full">
      <div className="drag-handle flex select-none items-center gap-2 px-4 pb-2 pt-4">
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight" title={def.title}>
            {def.title}
          </h3>
          {def.subtitle ? (
            <p className="truncate text-[11px] text-muted-foreground">{def.subtitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {def.extra?.(ctx)}
          <button
            onClick={onRemove}
            title={t('widgets.remove.title')}
            aria-label={t('widgets.remove.title')}
            className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <CardContent className="min-h-0 flex-1 overflow-hidden">{children}</CardContent>
    </Card>
  );
}

interface GridProps {
  /** Catalogue courant de la page (statiques + dynamiques). */
  catalog: CoreWidgetDef[];
  /** PageConfig MERGÉE (le layout ne contient que les widgets affichés). */
  config: PageConfig;
  ctx: WidgetRenderCtx;
  /**
   * Fin d'un DRAG / RESIZE utilisateur → nouveau layout (la bibliothèque est
   * inchangée). Appel UNIQUEMENT par onDragStop / onResizeStop de RGL : les
   * autres onLayoutChange (reflow de breakpoint, sync propsLayout après
   * ajout/retrait…) sont ignorés — le parent gère déjà ces derniers via
   * onAdd/onRemove/onReset. Garde `layoutsEqual` côté page contre les drops
   * sans déplacement.
   */
  onLayoutChange: (layout: WidgetItem[]) => void;
  /** « Retirer » une carte → bibliothèque. */
  onRemove: (widgetId: string) => void;
}

/**
 * Grille personnalisable (react-grid-layout) : ne rend que les widgets du
 * `config.layout` (les items de la bibliothèque ne sont PAS montés → pas de
 * fetch caché). Le layout est memoïsé sur le contenu (pas l'identité) pour que
 * les pushes live (WS 5 s / tick 60 s) ne relayoutent ni n'interrompent un drag.
 *
 * DEUX GARDES ANTI-SAUVEGARDE-PARASITE (bug RGL v2) :
 *  1. `breakpoint="lg"` ÉPINGLÉ : RGL ne bascule plus jamais de breakpoint.
 *     Sans ça, toute variation de largeur du conteneur (ex. ouverture du
 *     panneau bibliothèque inline — le conteneur passe de 1368 à ~1096 px,
 *     soit le breakpoint md/8 colonnes) provoque un reflow du layout 12 col.
 *     vers 8 col. et un onLayoutChange qui polluait la config persistée.
 *     Le design est 12 colonnes : sur un viewport étroit les cartes sont
 *     simplement plus étroites (jamais de reflow), comportement stable.
 *  2. Sauvegarde UNIQUEMENT en fin de drag / resize utilisateur
 *     (onDragStop / onResizeStop) : les onLayoutChange internes (reflow,
 *     sync après ajout/retrait, compaction) ne sont plus enregistrés.
 */
export function WidgetGridLayout({ catalog, config, ctx, onLayoutChange, onRemove }: GridProps) {
  const { t } = useTranslation();
  const { width, containerRef } = useContainerWidth({ initialWidth: 1280 });

  // Clé du catalogue (ids uniquement) — stable entre deux pushes live même si
  // les closures de rendu sont reconstruites.
  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);
  const defById = useMemo(() => new Map(catalog.map((d) => [d.id, d])), [catalog]);

  const layouts = useMemo(() => {
    const lg: LayoutItem[] = config.layout.map((i) => {
      const def = defById.get(i.widgetId);
      const item: LayoutItem = { i: i.widgetId, x: i.x, y: i.y, w: i.w, h: i.h };
      if (def?.minW != null) item.minW = def.minW;
      if (def?.minH != null) item.minH = def.minH;
      return item;
    });
    return { lg };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, catalogKey]);

  /** Fin de drag / resize → on remonte le layout FINAL (post-compaction) au parent. */
  const emit = (finalLayout: readonly LayoutItem[]) =>
    onLayoutChange(finalLayout.map((ci) => ({ widgetId: ci.i, x: ci.x, y: ci.y, w: ci.w, h: ci.h })));

  return (
    <ResponsiveGridLayout
      className="layout"
      innerRef={containerRef as React.RefObject<HTMLDivElement>}
      width={width}
      breakpoint="lg"
      breakpoints={BREAKPOINTS}
      cols={BREAKPOINT_COLS}
      layouts={layouts}
      rowHeight={90}
      margin={[16, 16]}
      dragConfig={{ handle: '.drag-handle', cancel: 'button, a, input, select, textarea' }}
      resizeConfig={{ handles: ['se'] }}
      onDragStop={(finalLayout) => emit(finalLayout)}
      onResizeStop={(finalLayout) => emit(finalLayout)}
    >
      {config.layout.map((item) => {
        const def = defById.get(item.widgetId);
        if (!def) return null;
        return (
          <div key={item.widgetId} className="h-full">
            <WidgetFrame
              def={def}
              ctx={ctx}
              onRemove={() => {
                if (window.confirm(t('widgets.remove.confirm', { title: def.title }))) onRemove(item.widgetId);
              }}
            >
              {def.render(ctx)}
            </WidgetFrame>
          </div>
        );
      })}
    </ResponsiveGridLayout>
  );
}
