import { create } from 'zustand';

// Auth state is now driven by an httpOnly cookie set by the server during
// OAuth callback. The browser sends it automatically; JavaScript never
// sees it, which makes it immune to XSS token theft.
//
// What we keep in memory here:
//   - `user`: the hydrated User object from GET /auth/me
//   - `bootstrapped`: have we attempted the initial /auth/me probe yet?
//
// Anything else (e.g. "am I logged in?") is derived: !!user.
export const useAuthStore = create((set, get) => ({
  user: null,
  bootstrapped: false,
  setUser: (user) => set({ user }),
  setBootstrapped: (v) => set({ bootstrapped: !!v }),
  logout: () => set({ user: null }),
  isAuthenticated: () => !!get().user,
}));
