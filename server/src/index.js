import { loadDotenv } from './utils/env.js';
loadDotenv();

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import jwt from 'jsonwebtoken';
import { createServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { configurePassport } from './config/passport.js';
import authRoutes from './routes/auth.routes.js';
import reposRoutes from './routes/repos.routes.js';
import reviewsRoutes from './routes/reviews.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { attachReviewSocket } from './sockets/reviewSocket.js';

// --- Required env guards ---
const REQUIRED_ENV = [
  'MONGO_URI',
  'JWT_SECRET',
  'SESSION_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[env] missing required variable: ${key}`);
    process.exit(1);
  }
}

const app = express();

// --- Middleware ---
app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// express-session is used only for the OAuth `state` CSRF parameter during
// the GitHub redirect dance. Ongoing auth uses JWTs, not sessions.
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000, // 10 minutes — only needed across the redirect
    },
  })
);

app.use(passport.initialize());
configurePassport();

// --- Routes ---
app.get('/api/health', (req, res) => {
  const mongoStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    mongo: mongoStates[mongoose.connection.readyState] ?? 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use('/auth', authRoutes);
app.use('/api/repos', reposRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/settings', settingsRoutes);

// --- Error handler (must be last) ---
app.use(errorHandler);

// --- HTTP server + Socket.IO ---
//
// Wrap Express in node:http so Socket.IO can attach. The frontend connects
// to the same origin as the API; CORS for sockets is handled separately
// because the socket.io engine does its own preflight.
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  },
});

// JWT handshake: every socket must present a valid JWT in handshake.auth.token.
// We attach userId to socket.data so handlers can do owner checks.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('no_auth_token'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.userId = payload.sub;
    next();
  } catch (err) {
    next(new Error(`invalid_token: ${err.message}`));
  }
});

attachReviewSocket(io);

// --- Boot ---
const PORT = Number(process.env.PORT) || 5000;

async function start() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10_000,
    });
    console.log('[mongo] connected');
  } catch (err) {
    console.error('[mongo] connection failed:', err.message);
    process.exit(1);
  }

  httpServer.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[socket.io] attached`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[server] SIGINT received, closing...');
  io.close();
  await mongoose.connection.close();
  process.exit(0);
});

start();
