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
    /*
     * Page de connexion « brandée » : toujours en mode sombre (classe `dark`
     * locale — le robot analyste et le wordmark sont sur fond noir, l'identité
     * de marque reste cohérente quel que soit le thème de l'app).
     * Split-screen : formulaire à gauche, robot analyste à droite (≥ lg).
     */
    <div className="dark flex min-h-screen bg-background">
      <div className="flex flex-1 items-center justify-center p-4">
        <LoginCard />
      </div>
      <div className="relative hidden lg:block lg:w-[46%]">
        <img
          src="/images/robot-analyst.webp"
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/30 to-transparent" />
      </div>
    </div>
  );
}
