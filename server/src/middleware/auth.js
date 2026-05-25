import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { runWithUserContext } from '../utils/userContext.js';

// Name of the httpOnly cookie carrying the JWT. Read from req.cookies via
// cookie-parser, set/cleared via the helpers below.
export const AUTH_COOKIE = 'sr_token';

// Cookie options that work for cross-site auth between Vercel (client) and
// Render (api): SameSite=None + Secure is REQUIRED for the browser to send
// the cookie cross-origin. httpOnly makes JS unable to read it (immune to
// XSS token theft).
export function authCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd, // 'None' requires Secure; localhost dev runs over http
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // match JWT expiry (7d)
    path: '/',
  };
}

// Helper used by the OAuth callback to set the auth cookie.
export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, authCookieOptions());
}

// Helper used by /auth/logout to clear it.
export function clearAuthCookie(res) {
  // Pass the same SameSite/Secure attrs so the browser actually removes it.
  res.clearCookie(AUTH_COOKIE, { ...authCookieOptions(), maxAge: 0 });
}

// Issues a signed JWT for a freshly-authenticated user.
// Payload is intentionally tiny — just enough to look the user up.
export function signJwt(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('[auth] JWT_SECRET is required');
  return jwt.sign(
    { sub: String(user._id), githubId: user.githubId },
    secret,
    { expiresIn: '7d' }
  );
}

// Verify any JWT string. Used by Socket.IO handshake middleware too.
export function verifyJwt(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// Read the JWT from the request, preferring the httpOnly cookie over a
// Bearer header. The header path is kept ONLY as a transitional fallback —
// the rest of the app uses cookies now.
export function extractToken(req) {
  if (req.cookies && req.cookies[AUTH_COOKIE]) {
    return req.cookies[AUTH_COOKIE];
  }
  const header = req.headers?.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) return token;
  return null;
}

// Verifies the auth token (cookie or Bearer header), loads the user (with
// decrypted GitHub token + decrypted BYOK API keys), and attaches:
//   req.user        — the Mongoose doc
//   req.userId      — convenience accessor
//   req.userContext — the snapshot we'll stash in AsyncLocalStorage
//
// Wraps next() in runWithUserContext so any downstream async code (route
// handlers, agent loop, LLM clients) can read the current user's BYOK
// keys + model preferences without explicit parameter plumbing.
export async function requireAuth(req, res, next) {
  let user;
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'not_authenticated' });
    }

    const payload = verifyJwt(token);
    // Need +accessToken AND +settings.apiKeys.*.encryptedKey for BYOK.
    user = await User.findById(payload.sub).select(
      '+accessToken +settings.apiKeys.gemini.encryptedKey +settings.apiKeys.claude.encryptedKey +settings.apiKeys.groq.encryptedKey'
    );
    if (!user) {
      return res.status(401).json({ error: 'user_not_found' });
    }

    req.user = user;
    req.userId = user._id;
    req.userContext = user.toUserContext();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'token_expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'invalid_token' });
    }
    return next(err);
  }

  // Run the downstream chain inside the user-context async storage. Promise
  // continuations created inside next() inherit the context automatically.
  runWithUserContext(req.userContext, () => next());
}
