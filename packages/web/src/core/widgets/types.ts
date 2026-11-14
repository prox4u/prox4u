import type { ReactNode } from 'react';
import type { WidgetDef } from '@prox4u/shared';

/**
 * Personnalisation d'interface par utilisateur — framework de grille de widgets.
 *
 * Une PAGE personnalisable (Vue d'ensemble, Monitor VM, Monitor nœud) déclare
 * un CATALOGUE de widgets (statiques + dynamiques) ; le framework fournit la
 * grille react-grid-layout (drag/resize), la frame de carte (handle de drag,
 * titre + sous-titre VM/nœud, bouton « retirer », actions extra), le panneau
 * BIBLIOTHÈQUE (retirés / réinsérer) et la barre d'outils (Réinitialiser +
 * indicateur de sauvegarde). La persistance par user est portée par
 * `store/user-config` (GET/PUT/DELETE /api/user-config).
 */

/** Contexte passé au rendu de chaque widget (le nom de VM / de nœud alimente
 *  les sous-titres de carte et les noms de fichiers CSV). */
export interface WidgetRenderCtx {
  endpointId: string;
  /** Nom de la VM (Monitor VM) — sous-titre de carte + CSV. */
  vmName?: string;
  /** Nom du nœud (Monitor nœud) — sous-titre de carte + CSV. */
  nodeName?: string;
}

/** Définition de widget d'une page : catalogue partagé (id/taille) + rendu. */
export interface CoreWidgetDef extends WidgetDef {
  /** Rend le CORPS de la carte (la frame fournit l'en-tête : drag, titre, retirer). */
  render: (ctx: WidgetRenderCtx) => ReactNode;
  /** Actions optionnelles de l'en-tête (export CSV du graphique…) — à gauche du bouton retirer. */
  extra?: (ctx: WidgetRenderCtx) => ReactNode;
}

/**
 * Id de widget à partir d'un libellé technique (device, mountpoint, interface…).
 * Stabilité : même libellé → même id entre deux rendus (le merge de config
 * s'appuie dessus). Caractères hors [a-zA-Z0-9._-] → tiret ; vide → « default ».
 */
export function widgetIdFrom(base: string): string {
  const s = base
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'default').slice(0, 48);
}

/**
 * Égalité de contenu de deux layouts (ids + géométrie, indifférente à l'ordre).
 * Sert de garde aux `onLayoutChange` : RGL rappelle le handler sur les
 * compactations « parent-driven » (retrait d'un widget) — on n'enregistre
 * que les changements réels (drag/resize utilisateur).
 */
export function layoutsEqual(a: Array<{ widgetId: string; x: number; y: number; w: number; h: number }>, b: Array<{ widgetId: string; x: number; y: number; w: number; h: number }>): boolean {
  if (a.length !== b.length) return false;
  const map = new Map(b.map((i) => [i.widgetId, i]));
  return a.every((i) => {
    const m = map.get(i.widgetId);
    return !!m && m.x === i.x && m.y === i.y && m.w === i.w && m.h === i.h;
  });
}
