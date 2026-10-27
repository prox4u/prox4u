import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';
import { initTheme } from './store/theme';
import { createPluginContext } from './core/plugin/context';
import { loadPlugins } from './core/plugin/loader';
import { PLUGINS } from './core/plugin/plugins';
import './i18n';
// CSS RGL AVANT index.css : nos overrides (placeholder, poignée de resize) doivent gagner la cascade
import 'react-grid-layout/css/styles.css';
import './index.css';

initTheme();

/**
 * Bootstrap du host : les plugins sont chargés et initialisés AVANT le premier
 * rendu (registry statique ensuite). Un plugin en échec ne bloque pas l'app :
 * le loader logge l'erreur et continue (voir core/plugin/loader.ts).
 */
async function bootstrap(): Promise<void> {
  await loadPlugins(PLUGINS, createPluginContext());
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
