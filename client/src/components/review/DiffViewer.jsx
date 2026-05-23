import { FileCode } from 'lucide-react';
import SeverityPill from './SeverityPill.jsx';

// Lightweight file-impact summary, scoped to what's persisted on the Review.
// Lists each file referenced by a finding, with the per-file findings shown
// as colored chips. Clicking a chip focuses the corresponding finding card
// below. Phase 12 polish can extend this to a true Monaco diff if we start
// persisting PR patch content on the Review doc.

export default function DiffViewer({ review, focusedFinding, onMarkerClick }) {
  const findings = review.findings ?? [];

  // Group findings by filepath. Also pull file metadata from Phase 1 output
  // when available, so we can show added/modified status nicely.
  const phase1Out = review.phases?.find((p) => p.name === 'understand_diff')?.output;
  const fileSummaries = phase1Out?.fileSummaries ?? [];
  const summaryByPath = new Map(fileSummaries.map((f) => [f.filepath, f]));

  const groups = new Map();
  for (const f of findings) {
    const key = f.filepath ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  // Files referenced only by Phase 1 (no findings) should also surface so
  // the user gets a complete picture of what changed.
  for (const fs of fileSummaries) {
    if (!groups.has(fs.filepath)) groups.set(fs.filepath, []);
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-slate-200">Changed files</h3>
        <span className="text-[11px] text-slate-500 font-mono">
          {groups.size} {groups.size === 1 ? 'file' : 'files'}
        </span>
      </div>

      {groups.size === 0 ? (
        <p className="text-sm text-slate-500 italic">No file information persisted for this review.</p>
      ) : (
        <ul className="space-y-3">
          {[...groups.entries()].map(([filepath, hits]) => {
            const summary = summaryByPath.get(filepath);
            return (
              <li
                key={filepath}
                className="rounded-md border border-slate-800/80 bg-slate-950/30 p-3"
              >
                <div className="flex items-start gap-2 mb-2">
                  <FileCode className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-sm text-slate-200 font-mono truncate">
                        {filepath}
                      </code>
                      {summary?.kind && (
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 px-1.5 py-0.5 bg-slate-800 rounded">
                          {summary.kind}
                        </span>
                      )}
                      {(summary?.additions || summary?.deletions) && (
                        <span className="text-[11px] font-mono text-slate-500">
                          <span className="text-emerald-400">+{summary.additions ?? 0}</span>{' '}
                          <span className="text-red-400">-{summary.deletions ?? 0}</span>
                        </span>
                      )}
                    </div>
                    {summary?.summary && (
                      <p className="text-xs text-slate-400 mt-1">{summary.summary}</p>
                    )}
                  </div>
                </div>

                {hits.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 pl-6">
                    {hits.map((f, i) => {
                      const isFocused = focusedFinding === f;
                      return (
                        <button
                          key={i}
                          onClick={() => onMarkerClick?.(f)}
                          className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors ${
                            isFocused
                              ? 'border-slate-400 bg-slate-800'
                              : 'border-slate-800 hover:border-slate-600 bg-slate-900/40'
                          }`}
                        >
                          <SeverityPill severity={f.severity} size="xs" />
                          <span className="font-mono text-slate-300">
                            L{f.startLine}
                            {f.endLine && f.endLine !== f.startLine && `-${f.endLine}`}
                          </span>
                          <span className="text-slate-400 truncate max-w-[14rem]">
                            {f.title}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500 italic pl-6">
                    no findings on this file
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
