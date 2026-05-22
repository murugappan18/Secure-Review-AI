import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';

// Lands here after the backend signs a JWT and redirects with
// `${CLIENT_URL}/auth/callback#token=<jwt>`. Read the hash, persist the
// token, hydrate the user, navigate to the dashboard.
export default function AuthCallback() {
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);
  const setUser = useAuthStore((s) => s.setUser);
  const [error, setError] = useState(null);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const token = params.get('token');

    if (!token) {
      setError('No token in callback URL.');
      return;
    }

    setToken(token);

    // Clean the URL so the JWT doesn't sit in history.
    window.history.replaceState({}, '', '/auth/callback');

    (async () => {
      try {
        const { data } = await api.get('/auth/me');
        setUser(data.user);
        navigate('/dashboard', { replace: true });
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    })();
  }, [navigate, setToken, setUser]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="text-center">
        {error ? (
          <>
            <p className="text-red-400 font-mono text-sm mb-4">
              Sign-in failed: {error}
            </p>
            <a href="/" className="text-slate-400 hover:text-slate-200 text-sm underline">
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
