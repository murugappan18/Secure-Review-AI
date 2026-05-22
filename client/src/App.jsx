import { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function ping() {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setHealth(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    ping();
    const interval = setInterval(ping, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const mongoOk = health?.mongo === 'connected';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-semibold mb-1">SecureReview AI</h1>
        <p className="text-slate-400 mb-8 text-sm">Phase 1 — skeleton verification</p>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm uppercase tracking-wide text-slate-400">
              Backend health
            </span>
            <StatusPill ok={!error && !!health} mongoOk={mongoOk} />
          </div>

          {error && (
            <p className="text-red-400 text-sm font-mono">
              Failed to reach /api/health: {error}
            </p>
          )}

          {health && (
            <pre className="font-mono text-xs leading-relaxed text-slate-300 overflow-x-auto">
              {JSON.stringify(health, null, 2)}
            </pre>
          )}

          {!health && !error && (
            <p className="text-slate-500 text-sm">Pinging...</p>
          )}
        </div>

        <p className="text-slate-500 text-xs mt-4 text-center">
          Polls /api/health every 5s via Vite dev proxy → Express on :5000
        </p>
      </div>
    </div>
  );
}

function StatusPill({ ok, mongoOk }) {
  if (!ok) {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/30">
        offline
      </span>
    );
  }
  if (!mongoOk) {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30">
        api ok / mongo down
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
      healthy
    </span>
  );
}
