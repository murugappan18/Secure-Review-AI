import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore.js';
import { backendUrl } from '../lib/api.js';
import Footer from '../components/Footer.jsx';

export default function Landing() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const [params] = useSearchParams();
  const oauthError = params.get('error');

  // If we already have a JWT, skip the marketing page.
  useEffect(() => {
    if (token) navigate('/dashboard', { replace: true });
  }, [token, navigate]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-lg text-center">
        <h1 className="text-4xl font-semibold mb-3">SecureReview AI</h1>
        <p className="text-slate-400 mb-10 leading-relaxed">
          Agentic, contextual security review for GitHub pull requests.
          <br />
          Sign in to connect a repo.
        </p>

        <a
          href={backendUrl('/auth/github')}
          className="inline-flex items-center gap-3 rounded-lg bg-slate-100 px-5 py-3 text-slate-900 font-medium hover:bg-white transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            className="w-5 h-5"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.07 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.6.23 2.78.12 3.07.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
          </svg>
          Sign in with GitHub
        </a>

        {oauthError && (
          <p className="text-red-400 text-sm mt-6 font-mono">
            OAuth failed: {oauthError}
          </p>
        )}

        <p className="text-slate-500 text-xs mt-12">
          We request the <code className="text-slate-300">repo</code>,{' '}
          <code className="text-slate-300">read:user</code>, and{' '}
          <code className="text-slate-300">user:email</code> scopes. You can
          revoke access anytime from your GitHub settings.
        </p>
      </div>
      </main>
      <Footer />
    </div>
  );
}
