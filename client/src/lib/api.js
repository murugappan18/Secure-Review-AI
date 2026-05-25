import axios from 'axios';
import { useAuthStore } from '../store/authStore.js';

// Empty baseURL → relative requests. In dev, Vite's proxy forwards /api and
// /auth to the Express server. In prod, VITE_API_URL points at the Render
// backend and CORS allows it.
const baseURL = import.meta.env.VITE_API_URL || '';

// `withCredentials: true` makes the browser include our httpOnly `sr_token`
// cookie on every request. Combined with the server's CORS
// `credentials: true` + explicit origin, the browser will accept the
// Set-Cookie response from the OAuth callback even though API and client
// live on different domains (Render ↔ Vercel).
export const api = axios.create({ baseURL, withCredentials: true });

// 401 means the cookie expired or was cleared — drop the user from state
// so the route guard kicks them back to the landing page.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Don't clobber state if we're already unauthenticated (avoids
      // re-rendering loops while the auth bootstrap probe is running).
      const store = useAuthStore.getState();
      if (store.user) store.logout();
    }
    return Promise.reject(err);
  }
);

// Absolute URL to a backend endpoint — used when we need the browser itself
// (not XHR) to navigate there, like the GitHub OAuth kickoff.
export function backendUrl(path) {
  const base = import.meta.env.VITE_API_URL || window.location.origin;
  return `${base}${path}`;
}
