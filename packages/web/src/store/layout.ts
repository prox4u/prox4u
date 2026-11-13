import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Layout, LayoutItem } from 'react-grid-layout';

export type { Layout, LayoutItem };

/**
 * Version du schéma de layout — à incrémenter à chaque changement incompatible de
 * DEFAULT_LAYOUT (nouveaux blocs, restructuration). Les layouts persistés d'une
 * version antérieure sont alors jetés au rechargement (retour aux défauts).
 */
export const LAYOUT_VERSION = 3;

/** Layout initial = design validé (graphes ressources en tête, grille 12 colonnes). */
export const DEFAULT_LAYOUT: Layout = [
  { i: 'res-cpu', x: 0, y: 0, w: 4, h: 3 },
  { i: 'res-ram', x: 4, y: 0, w: 4, h: 3 },
  { i: 'res-storage', x: 8, y: 0, w: 4, h: 3 },
  { i: 'kpi-nodes', x: 0, y: 3, w: 3, h: 2 },
  { i: 'kpi-cpu', x: 3, y: 3, w: 3, h: 2 },
  { i: 'kpi-storage', x: 6, y: 3, w: 3, h: 2 },
  { i: 'kpi-vms', x: 9, y: 3, w: 3, h: 2 },
  { i: 'metrics', x: 0, y: 5, w: 8, h: 3 },
  { i: 'health', x: 8, y: 5, w: 4, h: 3 },
  { i: 'pra', x: 0, y: 8, w: 6, h: 3 },
  { i: 'capacity', x: 6, y: 8, w: 6, h: 3 },
  { i: 'storage', x: 0, y: 11, w: 4, h: 3 },
  { i: 'network', x: 4, y: 11, w: 4, h: 3 },
  { i: 'alerts', x: 8, y: 11, w: 4, h: 3 },
  { i: 'top', x: 0, y: 14, w: 7, h: 3 },
  { i: 'nodes', x: 7, y: 14, w: 5, h: 3 },
  { i: 'overcommit', x: 0, y: 17, w: 12, h: 2 },
];

interface LayoutState {
  /** layouts par breakpoint (lg/md/sm) — dashboard endpoint */
  layout: Record<string, Layout>;
  /** layouts par breakpoint (lg/md/sm) — vue d'ensemble (/) */
  overviewLayout: Record<string, Layout>;
  /** incrémenté au reset → force le remontage des grilles */
  version: number;
  /** menu latéral : sous-arbre Proxmox (endpoints/nœuds) déplié sous « Vue d'ensemble ». Défaut replié. */
  navTreeExpanded: boolean;
  setLayouts: (all: Record<string, Layout>) => void;
  setOverviewLayouts: (all: Record<string, Layout>) => void;
  resetLayout: () => void;
  toggleNavTree: () => void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      layout: {},
      overviewLayout: {},
      version: 0,
      navTreeExpanded: false,
      setLayouts: (all) => set({ layout: all }),
      setOverviewLayouts: (all) => set({ overviewLayout: all }),
      resetLayout: () => set((s) => ({ layout: {}, overviewLayout: {}, version: s.version + 1 })),
      toggleNavTree: () => set((s) => ({ navTreeExpanded: !s.navTreeExpanded })),
    }),
    {
      name: 'proxmox-dashboard-layout',
      partialize: (s) => ({ layout: s.layout, overviewLayout: s.overviewLayout, layoutVersion: LAYOUT_VERSION, navTreeExpanded: s.navTreeExpanded }),
      // Layouts persistés d'une version antérieure → jetés (grille restructurée)
      merge: (persisted, current) => {
        const p = persisted as { layoutVersion?: number } | undefined;
        if (!p || p.layoutVersion !== LAYOUT_VERSION) return current;
        return { ...current, ...p };
      },
    },
  ),
);
