import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, ChevronDown, Wrench } from 'lucide-react';

// Cosmetic phase group order for the feed.
const PHASE_ORDER = [
  'understand_diff',
  'gather_context',
  'reason_exploitability',
  'compare_patterns',
  'generate_review',
];

const PHASE_LABELS = {
  understand_diff: 'Understand diff',
  gather_context: 'Gather context',
  reason_exploitability: 'Reason exploitability',
  compare_patterns: 'Compare patterns',
  generate_review: 'Generate review',
};

export default function AgentThinkingPanel({ toolCalls = [] }) {
  // Group by phase.
  const grouped = PHASE_ORDER.map((phase) => ({
    phase,
    calls: toolCalls.filter((tc) => tc.phase === phase),
  })).filter((g) => g.calls.length > 0);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-slate-500 font-medium">
          Tool calls
        </h3>
        <span className="text-[11px] text-slate-500 font-mono">
          {toolCalls.length} total
        </span>
      </div>

      {toolCalls.length === 0 ? (
        <p className="text-xs text-slate-500 italic">No tool calls recorded.</p>
      ) : (
        <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 -mr-2 scrollbar-thin">
          {grouped.map(({ phase, calls }) => (
            <div key={phase}>
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">
                {PHASE_LABELS[phase] ?? phase}
              </p>
              <AnimatePresence>
                <div className="space-y-1.5">
                  {calls.map((tc, i) => (
                    <ToolCallCard key={`${phase}-${i}`} call={tc} delay={i * 0.03} />
                  ))}
                </div>
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ToolCallCard({ call, delay }) {
  const [open, setOpen] = useState(false);
  const isError = !!call.error;
  const keyArg = pickKeyArg(call.arguments);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className={`rounded-md border text-sm ${
        isError
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2.5 py-2 flex items-center gap-2"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        )}
        <Wrench className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <span className="font-mono text-xs text-slate-200 truncate">
          {call.tool}
        </span>
        {keyArg && (
          <span className="font-mono text-[11px] text-slate-500 truncate">
            ({keyArg})
          </span>
        )}
        <span className="ml-auto text-[10px] text-slate-500 font-mono shrink-0">
          {call.durationMs}ms
        </span>
      </button>

      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="px-2.5 pb-2 pt-1 border-t border-slate-800/80 space-y-1.5"
        >
          <Section label="arguments">
            <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-words bg-slate-950/60 p-2 rounded">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
          </Section>
          <Section label="result">
            <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-words bg-slate-950/60 p-2 rounded max-h-48 overflow-y-auto">
              {previewResult(call.result)}
            </pre>
          </Section>
          {call.error && (
            <p className="text-[11px] text-red-300 font-mono">error: {call.error}</p>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}

function Section({ label, children }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</p>
      {children}
    </div>
  );
}

// Best-effort "most interesting argument" for the collapsed view.
function pickKeyArg(args) {
  if (!args || typeof args !== 'object') return null;
  for (const key of ['query', 'cweId', 'cveId', 'pattern', 'filepath', 'name', 'functionName']) {
    if (args[key] != null) {
      const s = String(args[key]);
      return s.length > 60 ? s.slice(0, 60) + '...' : s;
    }
  }
  const first = Object.values(args)[0];
  return first != null ? String(first).slice(0, 60) : null;
}

function previewResult(result) {
  if (result == null) return '(no result)';
  const s = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return s.length > 2000 ? s.slice(0, 2000) + '\n... [truncated]' : s;
}
