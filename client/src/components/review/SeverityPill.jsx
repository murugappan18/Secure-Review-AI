// Shared severity badge — used in the findings list, top-bar summary, etc.
// Standardized colors so the visual language is consistent across the app.

const TONES = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  low: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  info: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

export default function SeverityPill({ severity, count, size = 'sm' }) {
  const tone = TONES[severity] ?? TONES.info;
  const sizing =
    size === 'lg'
      ? 'text-sm px-2.5 py-1'
      : size === 'xs'
        ? 'text-[10px] px-1.5 py-0.5'
        : 'text-xs px-2 py-0.5';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium uppercase tracking-wide ${tone} ${sizing}`}>
      {count !== undefined && <span>{count}</span>}
      {severity}
    </span>
  );
}

export function ProviderPill({ provider }) {
  if (!provider) return null;
  const tones = {
    gemini: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    claude: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    groq: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  };
  // modelUsed can be "gemini" or "gemini+claude" when fallback fired.
  const primary = provider.split('+')[0];
  return (
    <span
      className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border font-mono ${tones[primary] ?? tones.gemini}`}
    >
      via {provider}
    </span>
  );
}

export function StatusPill({ status }) {
  const tones = {
    queued: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    running: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    complete: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    failed: 'bg-red-500/15 text-red-300 border-red-500/40',
    stopped: 'bg-slate-700/40 text-slate-300 border-slate-600',
  };
  const tone = tones[status] ?? tones.queued;
  return (
    <span className={`text-xs uppercase tracking-wide px-2 py-0.5 rounded-full border font-medium ${tone}`}>
      {status}
    </span>
  );
}
