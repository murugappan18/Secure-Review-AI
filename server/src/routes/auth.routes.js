import { Router } from 'express';
import passport from 'passport';
import { requireAuth, signJwt } from '../middleware/auth.js';

const router = Router();
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// Step 1: kick off the OAuth dance. Passport redirects to GitHub.
router.get(
  '/github',
  passport.authenticate('github', {
    scope: ['repo', 'read:user', 'user:email'],
    session: false,
  })
);

// Step 2: GitHub redirects here with ?code=...
// Passport exchanges code → access token, runs our verify callback,
// then we sign a JWT and redirect to the React app with the token in the hash.
router.get(
  '/github/callback',
  passport.authenticate('github', {
    session: false,
    failureRedirect: `${CLIENT_URL}/?error=oauth_failed`,
  }),
  (req, res) => {
    const token = signJwt(req.user);
    // Hash fragment instead of query: not sent on subsequent requests,
    // doesn't leak into Referer or HTTP access logs.
    res.redirect(`${CLIENT_URL}/auth/callback#token=${token}`);
  }
);

// Current user — used by the frontend to hydrate after the JWT lands.
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user.toJSON() });
});

// Logout is effectively a client-side action (drop the JWT), but we expose
// this for symmetry. With stateless JWTs there's no server-side session
// to invalidate. A real production app would maintain a token-revocation list.
router.post('/logout', (_req, res) => {
  res.json({ ok: true });
});

export default router;
