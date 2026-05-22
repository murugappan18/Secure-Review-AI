import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // All /api/* requests go to the Express server.
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      // Only proxy the SERVER-side auth routes. /auth/callback is a
      // CLIENT-side React Router route (AuthCallback.jsx) and must be
      // served by Vite's SPA fallback, not forwarded to Express.
      //
      // Regex matches: /auth/github, /auth/github/callback, /auth/me, /auth/logout
      // Does NOT match: /auth/callback (client route)
      '^/auth/(github|me|logout)': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
