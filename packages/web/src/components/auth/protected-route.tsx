import { Loader2 } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '@prox4u/shared';
import { useAuth } from '../../store/auth';

/** Écran de chargement plein cadre (hydratation de la session au boot). */
export function FullScreenLoader() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Route protégée par session (et rôle optionnel).
 * - non connecté → /login (avec la destination d'origine en state)
 * - rôle insuffisant → /
 * - mustChangePassword → forçage sur /profile?tab=password (seule page accessible)
 */
export function ProtectedRoute({ role }: { role?: Role }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullScreenLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role && user.role !== role) return <Navigate to="/" replace />;

  const onPasswordTab =
    location.pathname === '/profile' && new URLSearchParams(location.search).get('tab') === 'password';
  if (user.mustChangePassword && !onPasswordTab) {
    return <Navigate to="/profile?tab=password" replace />;
  }
  return <Outlet />;
}

/**
 * Route protégée par module : l'utilisateur doit avoir le module (famille de
 * plugin) dans ses modules visibles (autorisés ∩ préférences). Sinon → /profile
 * (seule page toujours accessible — évite toute boucle si aucun module n'est visible).
 */
export function ModuleRoute({ moduleId }: { moduleId: string }) {
  const visible = useAuth((s) => s.visibleModuleIds);
  if (!visible.includes(moduleId)) return <Navigate to="/profile" replace />;
  return <Outlet />;
}
