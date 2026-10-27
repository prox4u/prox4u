import { DEFAULT_LANG, resources, type Lang } from '@prox4u/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const saved = (localStorage.getItem('lang') as Lang | null) ?? DEFAULT_LANG;

void i18n.use(initReactI18next).init({
  resources,
  lng: saved,
  fallbackLng: DEFAULT_LANG,
  interpolation: { escapeValue: false },
});

export function setLang(lang: Lang): void {
  localStorage.setItem('lang', lang);
  void i18n.changeLanguage(lang);
}

export default i18n;
