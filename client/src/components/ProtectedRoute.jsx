import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore.js';

// Gates protected routes. Reads from the auth store — which is populated
// by the app-level AuthBootstrap on initial load. We don't fire our own
// /auth/me probe here anymore; centralising the bootstrap was the only
// way to make /reviews/:id (a public-readable route) reliably know the
// user is signed in after a hard refresh.
export default function ProtectedRoute({ children }) {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  const location = useLocation();

  // While the app-root bootstrap is still in flight, hold the route in a
  // tiny loading state instead of flashing to the landing redirect — that
  // would log the user out visually for ~200ms on every cold page load.
  if (!bootstrapped) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center text-sm text-slate-500">
        Loading...
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }
  return children;
}
