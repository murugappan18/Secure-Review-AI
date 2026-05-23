import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sr-theme';

// Initial value: read once from localStorage, fall back to system preference,
// finally default to 'dark'. Reading at module load time means the html class
// is set BEFORE React mounts — avoids a flash of the wrong theme.
function initialTheme() {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

// Apply once at module load — runs before React mounts.
if (typeof document !== 'undefined') {
  const t = initialTheme();
  document.documentElement.classList.toggle('dark', t === 'dark');
}

export function useTheme() {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  function toggle() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  return { theme, setTheme, toggle };
}
