import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { parsePluginVersion } from '@prox4u/shared';
import { Sidebar } from './components/layout/sidebar';
import { Topbar } from './components/layout/topbar';
import { ModuleRoute, ProtectedRoute } from './components/auth/protected-route';
import { useSnapshotStream } from './core/data/use-snapshot-stream';
import { FEATURES } from './core/config/features';
import { registry } from './core/plugin/registry';
import { syncModuleCatalog } from './core/plugin/catalog-sync';
import { ModuleDisabled } from './core/ui/ModuleDisabled';
import { VersionSwitch, type VersionRef } from './core/ui/VersionSwitch';
import { LoginPage } from './pages/login';
import { ProfilePage } from './pages/profile';
import { AdminPage } from './pages/admin';
import { useAuth } from './store/auth';

/**
 * Arborescence de routes :
 * - /login : public (page de connexion)
 * - le reste est protégé par session (ProtectedRoute) ; mustChangePassword
 *   force /profile?tab=password avant tout accès.
 * - chaque famille de plugin a son ModuleRoute (visibilité = autorisés ∩ préférences).
 * - /admin exige le rôle admin.
 */
export default function App() {
  const refresh = useAuth((s) => s.refresh);
  // Ids de versions EXACTS visibles (autorisées ∩ sélection profil) : seules ces
  // versions sont rendues sur les routes partagées (cohérence menu/URL).
  const visibleVersionIds = useAuth((s) => s.visibleVersionIds);

  // Hydratation de la session au boot (cookie httpOnly → GET /api/auth/me) +
  // synchronisation du catalogue serveur avec les versions enregistrées.
  useEffect(() => {
    void refresh();
    void syncModuleCatalog()
      .then((r) => {
        if (r.created > 0) void refresh(); // nouvelles entrées → re-hydrater
      })
      .catch(() => {}); // pas de session (page /login) → sans objet
  }, [refresh]);

  // Routes des plugins initialisés (toutes versions), groupées par famille
  // (ModuleRoute de visibilité). Si plusieurs versions partagent un chemin,
  // la route est un VersionSwitch : ?v=<id de plugin> choisit la version
  // (défaut = la version active de la famille).
  const families = new Map<string, Array<{ path: string; versions: VersionRef[] }>>();
  for (const p of registry.initialized()) {
    const family = parsePluginVersion(p.manifest.id).family;
    const list = families.get(family) ?? [];
    for (const r of p.manifest.routes ?? []) {
      const existing = list.find((x) => x.path === r.path);
      if (existing) existing.versions.push({ id: p.manifest.id, element: r.element });
      else list.push({ path: r.path, versions: [{ id: p.manifest.id, element: r.element }] });
    }
    families.set(family, list);
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            {/*
             * Routes de repli : un module dont le plugin est désactivé par feature
             * flag (disjoncteur) affiche ModuleDisabled au lieu d'une route morte.
             */}
            {!FEATURES.USE_PLUGIN_HYPERVISION && (
              <>
                <Route path="/" element={<ModuleDisabled module="hypervision" flag="VITE_USE_PLUGIN_HYPERVISION" />} />
                <Route path="/e/:endpointId" element={<ModuleDisabled module="hypervision" flag="VITE_USE_PLUGIN_HYPERVISION" />} />
                <Route path="/e/:endpointId/n/:nodeId" element={<ModuleDisabled module="hypervision" flag="VITE_USE_PLUGIN_HYPERVISION" />} />
              </>
            )}
            {!FEATURES.USE_PLUGIN_NETWORK && <Route path="/topology" element={<ModuleDisabled module="network" flag="VITE_USE_PLUGIN_NETWORK" />} />}
            {!FEATURES.USE_PLUGIN_STORAGE && <Route path="/storage" element={<ModuleDisabled module="storage" flag="VITE_USE_PLUGIN_STORAGE" />} />}
            {!FEATURES.USE_PLUGIN_VM_INVENTORY && <Route path="/vms" element={<ModuleDisabled module="vm-inventory" flag="VITE_USE_PLUGIN_VM_INVENTORY" />} />}

            {/* Routes des plugins, par famille (visibilité par utilisateur). */}
            {[...families.entries()].map(([family, routes]) => {
              const canonicalId = registry
                .active()
                .find((p) => parsePluginVersion(p.manifest.id).family === family)?.manifest.id;
              return (
                <Route key={family} element={<ModuleRoute moduleId={family} />}>
                  {routes.map((r) => {
                    // Seules les versions VISIBLES pour l'utilisateur (autorisées ∩
                    // sélection profil) sont rendues : « sélectionner la V1 et non la
                    // v2 » → /vms sert la v1, même si la canonique (la plus récente)
                    // est la v2. Aucune version visible → ModuleRoute a déjà redirigé
                    // vers /profile (visibleModuleIds = familles des versions visibles).
                    const visible = r.versions.filter((v) => visibleVersionIds.includes(v.id));
                    const versions = visible.length > 0 ? visible : r.versions;
                    if (versions.length > 1) {
                      // Version par défaut : la canonique si sélectionnée, sinon la première.
                      const activeId = versions.find((v) => v.id === canonicalId)?.id ?? versions[0].id;
                      return <Route key={r.path} path={r.path} element={<VersionSwitch versions={versions} activeId={activeId} />} />;
                    }
                    const El = versions[0].element;
                    return <Route key={r.path} path={r.path} element={<El />} />;
                  })}
                </Route>
              );
            })}

            {/* Profil (tous les rôles) */}
            <Route path="/profile" element={<ProfilePage />} />

            {/* Administration (rôle admin) */}
            <Route element={<ProtectedRoute role="admin" />}>
              <Route path="/admin" element={<AdminPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

/** Coquille de l'app (sidebar + topbar + flux WS) — rendue seulement si connecté. */
function AppShell() {
  useSnapshotStream();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] px-4 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
