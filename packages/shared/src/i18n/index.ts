import { en } from './en.js';
import { fr } from './fr.js';

export const resources = {
  fr: { translation: fr },
  en: { translation: en },
} as const;

export const DEFAULT_LANG = 'fr' as const;
export type Lang = keyof typeof resources;
