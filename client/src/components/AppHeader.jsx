import { Link, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuthStore } from '../store/authStore.js';
import { api } from '../lib/api.js';
import { disconnectSocket } from '../lib/socket.js';
import ThemeToggle from './ThemeToggle.jsx';

const NAV = [
  { key: 'dashboard', to: '/dashboard', label: 'Dashboard' },
  { key: 'reviews', to: '/reviews', label: 'Reviews' },
  { key: 'settings', to: '/settings', label: 'Settings' },
];

const MAX_WIDTHS = {
  '5xl': 'max-w-5xl',
  '7xl': 'max-w-7xl',
};

export default function AppHeader({ active, maxWidth = '5xl' }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  async function handleLogout() {
    try {
      await api.post('/auth/logout');
    } catch {
      // If the request fails (network etc.), clear local state anyway —
      // the cookie may still be on the browser, but the user clicked Sign
      // Out so we should at least drop the in-memory user.
    }
    disconnectSocket();
    logout();
    navigate('/', { replace: true });
  }

  const widthClass = MAX_WIDTHS[maxWidth] ?? MAX_WIDTHS['5xl'];

  return (
    <header className="border-b border-slate-800">
      <div className={`${widthClass} mx-auto px-4 sm:px-6 py-3 sm:py-4`}>
        {/* Row 1: brand + (desktop nav) + right controls */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 sm:gap-6 min-w-0">
            <h1 className="text-base sm:text-lg font-semibold whitespace-nowrap">
              SecureReview AI
            </h1>
            {/* Desktop nav — hidden on mobile, shown on sm+ */}
            <nav className="hidden sm:flex gap-4 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.key}
                  to={item.to}
                  className={
                    item.key === active
                      ? 'text-slate-100 font-medium'
                      : 'text-slate-400 hover:text-slate-100'
                  }
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-1 sm:gap-3 shrink-0">
            <ThemeToggle />
            {user?.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt=""
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-full border border-slate-700"
              />
            )}
            <span className="text-sm text-slate-300 hidden md:inline">
              {user?.username}
            </span>
            <button
              onClick={handleLogout}
              aria-label="Sign out"
              title="Sign out"
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 bg-slate-900/40 hover:bg-slate-800 hover:text-slate-100 hover:border-slate-500 ml-1 sm:ml-2 whitespace-nowrap transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>

        {/* Row 2: mobile-only nav strip */}
        <nav className="sm:hidden flex gap-4 text-xs mt-2 pt-2 border-t border-slate-800/60">
          {NAV.map((item) => (
            <Link
              key={item.key}
              to={item.to}
              className={
                item.key === active
                  ? 'text-slate-100 font-medium'
                  : 'text-slate-400 hover:text-slate-100'
              }
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
