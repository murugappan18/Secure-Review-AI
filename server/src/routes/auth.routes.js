import { Router } from 'express';
import passport from 'passport';
import {
  requireAuth,
  signJwt,
  setAuthCookie,
  clearAuthCookie,
} from '../middleware/auth.js';

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
// Passport exchanges code → access token, runs our verify callback. We
// sign a short JWT, drop it into an httpOnly + Secure + SameSite=None
// cookie (so it survives the cross-site Vercel↔Render hop), and redirect
// the user to a clean callback URL — the token NEVER appears in the URL,
// browser history, or any HTTP log along the way.
router.get(
  '/github/callback',
  passport.authenticate('github', {
    session: false,
    failureRedirect: `${CLIENT_URL}/?error=oauth_failed`,
  }),
  (req, res) => {
    const token = signJwt(req.user);
    setAuthCookie(res, token);
    res.redirect(`${CLIENT_URL}/auth/callback`);
  }
);

// Current user — used by the frontend to hydrate after the OAuth cookie
// lands. Also serves as the "am I logged in?" probe at app boot.
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user.toJSON() });
});

// Logout — clear the httpOnly cookie. Stateless JWTs have no server-side
// session to invalidate, but blowing away the cookie is what the browser
// needs to forget the credential.
router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

export default router;
