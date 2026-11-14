import { create } from 'zustand';

/**
 * Drapeau « une page personnalisable (grille v2) est montée ».
 * Posé par WidgetToolbar au montage (overview v2, monitors v3), consommé par
 * la topbar : quand la page courante a SA PROPRE barre d'outils (dont son
 * bouton « Réinitialiser la disposition »), le bouton de RESET LAYOUT v1 de
 * la topbar (store useLayout — sans effet sur les pages v2) est masqué pour
 * éviter deux boutons au même libellé dont l'un ne fait rien.
 */
interface CustomizablePageState {
  active: boolean;
  setActive: (active: boolean) => void;
}

export const useCustomizablePage = create<CustomizablePageState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
