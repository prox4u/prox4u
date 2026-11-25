import { marked } from 'marked';

/**
 * Rendu Markdown → HTML (lib `marked`, GFM : tableaux, listes, code).
 * Les notices sont du Markdown statique, bundlé au build (import `?raw`) :
 * le contenu est de confiance (source dans le repo), pas de XSS externe.
 */
marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
