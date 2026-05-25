import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';

// Lands here after the backend's OAuth callback set the httpOnly cookie
// and redirected to /auth/callback (no token in URL anymore). The cookie
// is already on the browser; we just need to load the user object.
export default function AuthCallback() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const setBootstrapped = useAuthStore((s) => s.setBootstrapped);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/auth/me');
        setUser(data.user);
        setBootstrapped(true);
        navigate('/dashboard', { replace: true });
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    })();
  }, [navigate, setUser, setBootstrapped]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="text-center">
        {error ? (
          <>
            <p className="text-red-400 font-mono text-sm mb-4">
              Sign-in failed: {error}
            </p>
            <a
              href="/"
              className="text-slate-400 hover:text-slate-200 text-sm underline"
            >
              Back to start
            </a>
          </>
        ) : (
          <p className="text-slate-400 text-sm">Signing you in...</p>
        )}
      </div>
    </div>
  );
}
