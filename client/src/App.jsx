import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Landing from './routes/Landing.jsx';
import AuthCallback from './routes/AuthCallback.jsx';
import Dashboard from './routes/Dashboard.jsx';
import RepoDetail from './routes/RepoDetail.jsx';
import Reviews from './routes/Reviews.jsx';
import ReviewTheater from './routes/ReviewTheater.jsx';
import Settings from './routes/Settings.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { useAuthStore } from './store/authStore.js';
import { api } from './lib/api.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// App-level auth bootstrap. Runs ONCE on initial app load, regardless of
// which route the user landed on. Probes /auth/me — if the httpOnly
// cookie is valid, the server returns the user and we populate the auth
// store. If not, we leave user=null and mark bootstrapped=true.
//
// Why this is at the app root (not inside ProtectedRoute / Landing):
// public routes like /reviews/:id need to know the auth state too, so
// they can render the proper app header for signed-in viewers. Doing
// the probe per-route also caused subtle bugs where refreshing a public
// route left the auth store unhydrated.
function AuthBootstrap({ children }) {
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  const setUser = useAuthStore((s) => s.setUser);
  const setBootstrapped = useAuthStore((s) => s.setBootstrapped);

  useEffect(() => {
    if (bootstrapped) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/auth/me');
        if (!cancelled) setUser(data.user);
      } catch {
        /* no valid cookie — leave user=null */
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapped, setUser, setBootstrapped]);

  return children;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthBootstrap>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/repos/:owner/:name"
              element={
                <ProtectedRoute>
                  <RepoDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reviews"
              element={
                <ProtectedRoute>
                  <Reviews />
                </ProtectedRoute>
              }
            />
            {/* Reviews are world-readable when their owner has flipped
                isPublic=true (auto-set when posting to GitHub). The component
                tries the authenticated endpoint first, then falls back to
                the public one — so signed-in owners get the full Review
                Theater, and PR authors clicking the link from the GitHub
                comment get a read-only view without needing to sign in. */}
            <Route path="/reviews/:id" element={<ReviewTheater />} />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              }
            />
          </Routes>
        </AuthBootstrap>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
