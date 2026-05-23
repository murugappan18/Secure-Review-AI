import { motion } from 'framer-motion';
import { Check, X, Loader2, Circle } from 'lucide-react';

// The 5 phases the agent runs through, in order. Display names are the
// human-readable forms; the keys must match what agentLoop persists.
const PHASE_DEFS = [
  { key: 'understand_diff', label: 'Understand diff' },
  { key: 'gather_context', label: 'Gather context' },
  { key: 'reason_exploitability', label: 'Reason exploitability' },
  { key: 'compare_patterns', label: 'Compare patterns' },
  { key: 'generate_review', label: 'Generate review' },
];

function statusOf(phase) {
  if (!phase) return 'pending';
  if (phase.error) return 'failed';
  if (phase.completedAt) return 'complete';
  return 'running';
}

function StatusIcon({ status }) {
  const cls = 'w-4 h-4';
  if (status === 'complete') {
    return <Check className={`${cls} text-emerald-400`} strokeWidth={3} />;
  }
  if (status === 'failed') {
    return <X className={`${cls} text-red-400`} strokeWidth={3} />;
  }
  if (status === 'running') {
    return <Loader2 className={`${cls} text-amber-300 animate-spin`} />;
  }
  return <Circle className={`${cls} text-slate-600`} />;
}

const ROW_TONES = {
  complete: 'border-emerald-500/30 bg-emerald-500/5',
  failed: 'border-red-500/30 bg-red-500/5',
  running: 'border-amber-500/40 bg-amber-500/10',
  pending: 'border-slate-800 bg-slate-900/30',
};

export default function PhaseTimeline({ phases = [] }) {
  // Map persisted phases by name for O(1) lookup.
  const byName = new Map(phases.map((p) => [p.name, p]));

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-3">
        Agent phases
      </h3>
      <ol className="space-y-1.5">
        {PHASE_DEFS.map((def, idx) => {
          const phase = byName.get(def.key);
          const status = statusOf(phase);
          const tone = ROW_TONES[status];

          return (
            <motion.li
              key={def.key}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.05 }}
              className={`flex items-center gap-3 rounded-md border px-3 py-2 ${tone}`}
            >
              <StatusIcon status={status} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-200">{def.label}</p>
                {phase?.error && (
                  <p className="text-[11px] text-red-300/80 font-mono truncate" title={phase.error}>
                    {phase.error}
                  </p>
                )}
              </div>
              {phase?.durationMs != null && (
                <span className="text-[11px] text-slate-500 font-mono shrink-0">
                  {formatDuration(phase.durationMs)}
                </span>
              )}
            </motion.li>
          );
        })}
      </ol>
    </section>
  );
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
