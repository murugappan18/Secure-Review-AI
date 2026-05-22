import axios from 'axios';
import { useAuthStore } from '../store/authStore.js';

// Empty baseURL → relative requests. In dev, Vite's proxy forwards /api and
// /auth to the Express server. In prod, VITE_API_URL points at the Render
// backend and CORS allows it.
const baseURL = import.meta.env.VITE_API_URL || '';

export const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const { token } = useAuthStore.getState();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
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
