import { useEffect, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ReactMarkdown from 'react-markdown';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import SeverityPill from './SeverityPill.jsx';

// Severity order for grouping. Critical first, info last.
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export default function FindingsList({ findings = [], focusedFinding, onFocus }) {
  // Group by severity, preserving original order within each group.
  const groups = new Map(SEVERITY_ORDER.map((s) => [s, []]));
  for (const f of findings) {
    if (!groups.has(f.severity)) groups.set(f.severity, []);
    groups.get(f.severity).push(f);
  }

  if (findings.length === 0) {
    return (
      <section className="text-center py-12 border border-dashed border-slate-800 rounded-xl">
        <ShieldAlert className="w-8 h-8 mx-auto text-slate-600 mb-3" />
        <p className="text-slate-300 font-medium mb-1">No findings reported</p>
        <p className="text-xs text-slate-500">
          The agent didn&apos;t identify any security issues in this PR.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <h3 className="text-xs uppercase tracking-wider text-slate-500 font-medium">
        Findings ({findings.length})
      </h3>
      {SEVERITY_ORDER.map((sev) => {
        const items = groups.get(sev) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={sev}>
            <div className="flex items-center gap-2 mb-2">
              <SeverityPill severity={sev} count={items.length} size="sm" />
            </div>
            <div className="space-y-3">
              {items.map((f, i) => (
                <FindingCard
                  key={`${sev}-${i}`}
                  finding={f}
                  isFocused={focusedFinding === f}
                  onFocus={() => onFocus?.(f)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function FindingCard({ finding, isFocused, onFocus }) {
  const ref = useRef(null);

  useEffect(() => {
    if (isFocused && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isFocused]);

  return (
    <article
      ref={ref}
      onClick={onFocus}
      className={`rounded-xl border p-5 transition-colors cursor-pointer ${
        isFocused
          ? 'border-slate-400 bg-slate-900/80'
          : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/60'
      }`}
    >
      <header className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-base font-medium text-slate-100 mb-1">
            {finding.title}
          </h4>
          <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap">
            <code className="font-mono">{finding.filepath}</code>
            <span className="text-slate-600">·</span>
            <span className="font-mono">
              L{finding.startLine}
              {finding.endLine && finding.endLine !== finding.startLine && `-${finding.endLine}`}
            </span>
            <span className="text-slate-600">·</span>
            <span className="uppercase text-[10px] tracking-wider text-slate-500">
              {finding.category}
            </span>
          </div>
        </div>
        <div className="text-right shrink-0 space-y-1">
          <SeverityPill severity={finding.severity} size="xs" />
          <p className="text-[10px] text-slate-500 font-mono">
            conf {(finding.confidence ?? 0).toFixed(2)}
          </p>
        </div>
      </header>

      <div className="prose prose-invert prose-sm max-w-none text-slate-300 mb-3">
        <ReactMarkdown>{finding.description}</ReactMarkdown>
      </div>

      {finding.codeSnippet && (
        <CodeBlock code={finding.codeSnippet} label="Vulnerable code" />
      )}

      {finding.suggestedFix && (
        <CodeBlock
          code={finding.suggestedFix}
          label="Suggested fix"
          variant="safe"
        />
      )}

      {finding.exploitabilityNotes && (
        <p className="text-xs text-slate-400 mt-3 leading-relaxed">
          <span className="text-slate-500 uppercase tracking-wider text-[10px] mr-2">
            Exploitability
          </span>
          {finding.exploitabilityNotes}
        </p>
      )}

      {finding.references?.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-slate-800/80">
          {finding.references.map((url, i) => (
            <a
              key={i}
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
            >
              <ExternalLink className="w-3 h-3" />
              {labelFromUrl(url)}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function CodeBlock({ code, label, variant }) {
  return (
    <div className="mb-2">
      <p className={`text-[10px] uppercase tracking-wider mb-1 ${variant === 'safe' ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
        {label}
      </p>
      <div className="rounded overflow-hidden text-[12px]">
        <SyntaxHighlighter
          language="javascript"
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: '0.75rem',
            background: variant === 'safe' ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
            fontSize: '12px',
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

function labelFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('cwe.mitre.org')) {
      const m = url.match(/definitions\/(\d+)\.html/);
      return m ? `CWE-${m[1]}` : 'CWE';
    }
    if (u.hostname.includes('owasp.org')) return 'OWASP';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
