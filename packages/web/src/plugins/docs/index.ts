import { BookOpen } from 'lucide-react';
import type { Plugin } from '../../core/plugin/types';
import { DocsPage } from './pages/docs';

/**
 * Plugin Documentation — notices d'utilisation par module (Markdown → HTML).
 *
 * - Une notice par FAMILLE de plugin (9 modules), source `.md` dans le repo
 *   (bundlée au build via `?raw`), rendue en HTML par `marked`.
 * - Accès par module : la sidebar ne liste que les modules de `visibleModuleIds`
 *   (autorisé ∩ préférences) — un user sans accès à un plugin n'a pas accès à
 *   sa doc (même source que ModuleRoute). Accès direct /docs/<module> sans
 *   permission → /profile.
 * - Le module `docs` lui-même est géré par le catalogue (catalogue global +
 *   groupes) : l'admin peut masquer toute la documentation à un groupe.
 *
 * Contenu FR (v1) ; l'EN viendra ensuite.
 */
export const docsPlugin: Plugin = {
  manifest: {
    id: 'docs',
    name: 'Documentation',
    version: '1.0.0',
    routes: [
      { path: '/docs', element: DocsPage },
      { path: '/docs/:moduleId', element: DocsPage },
    ],
    menu: [
      { id: 'docs', to: '/docs', labelKey: 'nav.docs', icon: BookOpen, order: 90 },
    ],
  },
  init(ctx) {
    ctx.logger.info('docs prêt — 2 routes + 1 entrée de menu exposées au host');
  },
};
