import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Persisted in localStorage under 'sr-auth'. Survives page refresh — that's
// the entire mechanism keeping the user logged in. Logging out clears it.
//
// localStorage (not httpOnly cookies) is fine for a portfolio project; a
// production app concerned with XSS would prefer httpOnly cookies.
export const useAuthStore = create(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null }),
      isAuthenticated: () => !!get().token,
    }),
    { name: 'sr-auth' }
  )
);
