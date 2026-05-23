import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { runWithUserContext } from '../utils/userContext.js';

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

// Verifies the Authorization: Bearer <jwt> header, loads the user (with
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
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing_bearer_token' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
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
