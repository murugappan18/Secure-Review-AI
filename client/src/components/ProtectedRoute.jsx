import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore.js';
import { api } from '../lib/api.js';

// Bootstraps auth from the httpOnly cookie: on first render, if we haven't
// probed /auth/me yet, do so. While that's in flight, render a tiny "..."
// holder so we don't flash the landing redirect for users who DO have a
// valid cookie.
export default function ProtectedRoute({ children }) {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  const setUser = useAuthStore((s) => s.setUser);
  const setBootstrapped = useAuthStore((s) => s.setBootstrapped);
  const location = useLocation();

  useEffect(() => {
    if (bootstrapped) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/auth/me');
        if (!cancelled) setUser(data.user);
      } catch {
        // No cookie / expired — leave user null, fall through to redirect.
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapped, setUser, setBootstrapped]);

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
