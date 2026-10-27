import { Navigate } from 'react-router-dom';
import { LoginCard } from '../components/auth/login-form';
import { useAuth } from '../store/auth';

/**
 * Page de connexion. Après login réussi, le store passe en 'authed' et la
 * redirection suit : mustChangePassword → /profile?tab=password (forçage),
 * sinon la destination d'origine (ou /).
 */
export function LoginPage() {
  const { status, user } = useAuth();

  if (status === 'authed' && user) {
    return <Navigate to={user.mustChangePassword ? '/profile?tab=password' : '/'} replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <LoginCard />
    </div>
  );
}
