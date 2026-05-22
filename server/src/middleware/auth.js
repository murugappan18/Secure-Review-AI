import jwt from 'jsonwebtoken';
import User from '../models/User.js';

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

// Verifies the Authorization: Bearer <jwt> header, loads the user, and
// attaches both req.user (the Mongoose doc, including encrypted accessToken)
// and req.userId. 401 on any failure.
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing_bearer_token' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).select('+accessToken');
    if (!user) {
      return res.status(401).json({ error: 'user_not_found' });
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'token_expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'invalid_token' });
    }
    next(err);
  }
}
