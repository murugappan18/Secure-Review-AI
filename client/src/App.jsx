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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
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
      </BrowserRouter>
    </QueryClientProvider>
  );
}
