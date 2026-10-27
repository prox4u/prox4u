# Plan — Refonte UI : dark mode natif + réorganisation des blocs + restyle shadcn/ui

> Statut : **livré** (thème sombre + accents, restyle shadcn/ui, drag & drop + resize sur `/` et `/e/:id` — voir STATUS.md)
> Contexte : retour utilisateur sur le dashboard livré — « c'est vraiment ordinaire ». Exigences :
> pouvoir déplacer/organiser les blocs, esthétique shadcn/ui minimaliste et professionnelle,
> mode sombre natif pour l'effet « vCenter moderne », polish Tailwind (ombres, arrondis, transitions).

## Décisions actées (validées par l'utilisateur)

| Choix | Décision |
|---|---|
| Thème par défaut | **Sombre** au 1er chargement + toggle clair/sombre dans la topbar, choix persisté (localStorage) |
| Réorganisation des blocs | **react-grid-layout v2.2.4** (compatible React 18) : réordonner **+ redimensionner**, ordre/tailles persistés en localStorage, bouton « réinitialiser » |
| Ampleur visuelle | **Restyle complet** du design system acté (skill §2) : fond `#0B0F19`, cartes `#161B26`, bordures slate-800, `rounded-2xl`, `shadow-xl`, accents émeraude/bleu/ambre/indigo |
| Couleurs | **Accent personnalisable** : 5 palettes (indigo, bleu, émeraude, ambre, rose) sélectionnables à chaud via `data-accent` sur `<html>` + variables CSS par palette/mode ; choix persisté. Les couleurs de statut (ok/warn/crit) restent fixes (code couleur unique du design system) |

## Work packages

### WP1 — Fondations thème sombre + couleurs d'accent
- `packages/web/src/store/theme.ts` : zustand + middleware persist — `theme: 'dark' | 'light'` (défaut `'dark'`) + `accent: 'indigo' | 'blue' | 'emerald' | 'amber' | 'rose'` (défaut `'indigo'`), `toggle()`, `setAccent()` ; effet applicatif : `document.documentElement.classList.toggle('dark', …)` + `dataset.accent = accent` + `color-scheme: dark|light` (scrollbars/inputs natifs)
- **Palettes d'accent** dans `index.css` : `[data-accent="…"] { --primary: …; --ring: … }` déclinées pour les modes clair ET sombre (ex. indigo sombre `#818cf8` / clair `#4f46e5`) ; les variables de statut `--ok/--warn/--crit` restent hors accent
- `lib/accents.ts` : map TS miroir des palettes (valeurs hex par accent/mode) pour les graphiques ECharts/Tremor qui ne lisent pas les variables CSS
- Toggle Sun/Moon (lucide) + **popover d'accent** (pastilles de couleur, icône Palette) dans la topbar, boutons ghost
- `index.css` : réécriture du bloc `.dark` avec les tokens actés — fond `#0B0F19` (hsl 224 44% 7 %), cartes `#161B26`, bordures slate-800, foreground slate-100, muted slate-400, primary indigo/bleu, ok/warn/crit émeraude/ambre/rouge (légèrement plus clairs en sombre) ; thème clair poli en contrepoint
- **Tokens Tremor dark** : ajouter `--color-dark-tremor-*` dans `@theme` (background/border/content/brand + variantes subtle/emphasis/inverted) — valeurs officielles à récupérer depuis la doc @tremor/react (le dist ne les contient pas) → gridlines, labels et tooltips des graphiques corrects en sombre
- Transitions fluides : `transition-colors duration-300` sur body, cartes, topbar (pas sur les graphiques SVG pour éviter les artefacts)

### WP2 — ECharts thématisés + resize
- `packages/web/src/lib/chart-theme.ts` : palette selon thème **et accent** (couleurs axes, splitLines, labels, tooltip fond/bordure, couleurs séries CPU/RAM/disk — la 1re série suit l'accent) ; exportée pour la jauge et le graphe capacity
- `health-gauge.tsx` + `capacity-chart.tsx` : option ECharts reconstruite au changement de thème (dépendance store theme dans le useMemo) ; jauge : glow émeraude en sombre (`shadowBlur`) — l'« anneau lumineux » du design system
- `hooks/use-echart.ts` : remplacer le listener `window.resize` par un **ResizeObserver** sur le conteneur → indispensable quand un bloc est redimensionné dans la grille

### WP3 — Restyle shadcn/ui
Fondations déjà présentes (CVA, clsx, tailwind-merge, Radix slot/separator/tooltip) ; composants à créer : `button.tsx` (variants default/ghost/outline), `skeleton.tsx`.
- `Card` : `rounded-2xl`, `shadow-xl` (dark : halo noir), bordure subtile, hover border highlight ; **header avec poignée de drag** (GripVertical, classe `.drag-handle`) + titre + zone actions
- KPIs (`kpi-row.tsx`) : icône en pastille colorée (`bg-blue-500/10 text-blue-400`), valeur `text-2xl font-semibold tabular-nums`, label `text-xs uppercase tracking-wide muted`, barres de progression fines
- `table.tsx` : header slate-800/50, hover ligne, conteneur arrondi `overflow-hidden` ; `badge.tsx` / `progress.tsx` recalibrés pour le sombre
- `topbar.tsx` : logo en carré dégradé (Server), LIVE dot pulsant (`animate-pulse`), boutons ghost (langue + thème), badge cluster
- `alerts-list.tsx` : bordure gauche colorée par sévérité + fond teinté subtil ; `pra-panel.tsx` : jauges d'absorption en dégradé + bannière de statut

### WP4 — react-grid-layout
- Dépendance : `pnpm --filter @proxmox/web add react-grid-layout` (v2.2.4) + import des 2 CSS (`react-grid-layout/css/styles.css`, `react-resizable/css/styles.css`) dans `main.tsx`
- `packages/web/src/store/layout.ts` : zustand + persist — layout `{i, x, y, w, h}` par breakpoint, `setLayout()`, `resetLayout()`
- `pages/dashboard.tsx` : `ResponsiveReactGridLayout` (breakpoints 12 / 8 / 4 colonnes), **registre de 8 blocs** (id → titre i18n + rendu) au lieu de la grille durcie actuelle
- Layout initial (grille 12, rowHeight ≈ 150 px, margin 16 px) :

| Bloc | w | h |
|---|---|---|
| health (HealthGauge) | 3 | 2 |
| kpis (KpiRow) | 9 | 1 |
| pra (PraPanel) | 6 | 2 |
| capacity (CapacityChart) | 6 | 3 |
| top (TopConsumers) | 7 | 3 |
| trends (TrendsPanel) | 5 | 3 |
| nodes (NodesTable) | 8 | 2 |
| alerts (AlertsList) | 4 | 2 |

- `dragHandle=".drag-handle"` : drag **uniquement par le header** (zéro conflit avec les interactions graphiques) ; resize par poignée bas-droite
- Bouton « Réinitialiser la disposition » (topbar, à côté du toggle thème)
- Overrides CSS RGL pour le sombre : placeholder `indigo/20`, handle de resize visible (`.react-resizable-handle`), `overflow-hidden` sur les items

### WP5 — i18n + vérifications
- Clés FR/EN : toggle thème, libellés des 5 accents, « Réinitialiser la disposition », astuce drag (« Glissez par l'en-tête pour réorganiser »)
- `pnpm typecheck && pnpm test && pnpm build`
- Captures headless (Playwright/Chromium) **sombre + clair** : zéro erreur console, graphiques colorés dans les deux thèmes
- Test drag en headless : déplacer un bloc par sa poignée → recharger la page → ordre/tailles conservés (localStorage) ; resize d'un bloc → ECharts/Tremor redimensionnés proprement

## Ordre d'exécution
1. WP1 thème → 2. WP3 restyle shadcn → 3. WP2 ECharts → 4. WP4 react-grid-layout → 5. WP5 i18n + vérifications complètes

## Risques & notes
- **RGL + StrictMode** : v2 gère React 18, mais le drag doit être testé en headless dès la fin du WP4 (le StrictMode double-montage peut affecter les listeners de drag)
- **Palette dark Tremor** : absente du dist — récupérer les valeurs officielles depuis la doc @tremor/react avant d'écrire les tokens
- **Resize des graphiques** : ECharts géré par ResizeObserver (WP2) ; Tremor/recharts a son propre ResponsiveContainer (à vérifier au test)
- Les blocs gardent leur contenu existant — aucune modification du data layer (server/shared inchangés)

## Fichiers touchés (prévision)
```
packages/web/package.json                     # + react-grid-layout
packages/web/src/main.tsx                     # imports CSS RGL
packages/web/src/index.css                    # variables .dark, tokens dark-tremor-*, overrides RGL
packages/web/src/store/theme.ts               # nouveau
packages/web/src/store/layout.ts              # nouveau
packages/web/src/lib/chart-theme.ts           # nouveau
packages/web/src/lib/accents.ts               # nouveau (palettes accent clair/sombre)
packages/web/src/components/ui/button.tsx     # nouveau
packages/web/src/components/ui/skeleton.tsx   # nouveau
packages/web/src/components/ui/card.tsx       # restyle + poignée drag
packages/web/src/components/ui/{badge,progress,table}.tsx  # recalibrage sombre
packages/web/src/components/layout/topbar.tsx # toggle thème + popover accent + reset layout
packages/web/src/components/dashboard/*       # 8 composants : adaptations thème (couleurs, icônes)
packages/web/src/hooks/use-echart.ts          # ResizeObserver
packages/web/src/pages/dashboard.tsx          # ResponsiveReactGridLayout + registre de blocs
packages/shared/src/i18n/{fr,en}.ts           # nouvelles clés
STATUS.md                                     # mise à jour du statut après livraison
```
