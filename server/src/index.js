import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

// --- Required env guards ---
const REQUIRED_ENV = ['MONGO_URI'];
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

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[server] SIGINT received, closing...');
  await mongoose.connection.close();
  process.exit(0);
});

start();
