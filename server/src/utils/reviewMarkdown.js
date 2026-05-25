// Render a Review document into GitHub-flavored markdown so it can be posted
// back as a PR comment or as the body of a PR review.

const SEVERITY_EMOJI = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: 'ℹ️',
};

const RISK_EMOJI = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟢',
};

const APP_URL = process.env.CLIENT_URL || 'https://securereviewai.vercel.app';

function severityOrder(sev) {
  return ['critical', 'high', 'medium', 'low', 'info'].indexOf(sev);
}

// Render the review as a single markdown blob for an issue-style comment.
// Everything in one fold-out block so the PR conversation stays tidy.
export function renderReviewMarkdown(review) {
  const findings = [...(review.findings ?? [])].sort(
    (a, b) => severityOrder(a.severity) - severityOrder(b.severity)
  );

  const reviewUrl = `${APP_URL}/reviews/${review._id}`;
  const lines = [];

  lines.push(`## 🛡️ SecureReview AI — security review`);
  lines.push('');

  const risk = review.riskAssessment ?? 'low';
  lines.push(
    `**Overall risk:** ${RISK_EMOJI[risk] ?? ''} \`${risk.toUpperCase()}\` · ` +
      `**Findings:** ${findings.length} · ` +
      `**Model:** \`${review.modelUsed ?? 'unknown'}\``
  );
  lines.push('');

  if (review.summary) {
    lines.push('> ' + review.summary.replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (findings.length === 0) {
    lines.push('_No security vulnerabilities were identified in this PR._');
    lines.push('');
  } else {
    // Severity tally line.
    const tally = {};
    for (const f of findings) tally[f.severity] = (tally[f.severity] ?? 0) + 1;
    const tallyStr = Object.entries(tally)
      .map(([sev, n]) => `${SEVERITY_EMOJI[sev] ?? ''} ${n} ${sev}`)
      .join(' · ');
    lines.push(`**Breakdown:** ${tallyStr}`);
    lines.push('');

    findings.forEach((f, i) => {
      lines.push(
        `### ${SEVERITY_EMOJI[f.severity] ?? ''} ${i + 1}. ${f.title} ` +
          `\`[${(f.severity ?? 'info').toUpperCase()}]\``
      );
      lines.push('');
      lines.push(
        `**File:** \`${f.filepath}:${f.startLine}` +
          (f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : '') +
          '`' +
          (f.category ? ` · **Category:** \`${f.category}\`` : '') +
          (typeof f.confidence === 'number'
            ? ` · **Confidence:** ${(f.confidence * 100).toFixed(0)}%`
            : '')
      );
      lines.push('');
      if (f.description) {
        lines.push(f.description);
        lines.push('');
      }
      if (f.codeSnippet) {
        const fenceLang = guessFence(f.filepath);
        lines.push(`<details><summary>Vulnerable code</summary>`);
        lines.push('');
        lines.push('```' + fenceLang);
        lines.push(String(f.codeSnippet).trimEnd());
        lines.push('```');
        lines.push('</details>');
        lines.push('');
      }
      if (f.suggestedFix) {
        lines.push('**Suggested fix:**');
        lines.push('');
        lines.push('```' + guessFence(f.filepath));
        lines.push(String(f.suggestedFix).trimEnd());
        lines.push('```');
        lines.push('');
      }
      if (f.exploitabilityNotes) {
        lines.push(`**Exploitability:** ${f.exploitabilityNotes}`);
        lines.push('');
      }
      if (Array.isArray(f.references) && f.references.length > 0) {
        lines.push('**References:** ' + f.references.map((r) => `<${r}>`).join(', '));
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    });
  }

  lines.push(
    `_Full review with tool traces and per-phase reasoning → [open in SecureReview AI](${reviewUrl})_`
  );
  lines.push('');
  lines.push(
    '<sub>🤖 Automated review by [SecureReview AI](' +
      APP_URL +
      '). This is advisory, not a substitute for human review.</sub>'
  );

  return lines.join('\n');
}

// Build the body + inline comments payload for the createReview endpoint.
// Only findings whose filepath appears in `prFiles` (PR-touched files) and
// whose line falls inside an added/modified hunk are eligible to become
// inline comments — otherwise GitHub rejects the comment with 422.
//
// Returns { body, comments[], inlineCount, skipped[] } so the UI can show
// how many findings landed inline vs were rolled into the summary body.
export function renderReviewForPRReview(review, prFiles = []) {
  const findings = review.findings ?? [];
  const touchedFiles = new Map(prFiles.map((f) => [f.filename, f]));

  const inline = [];
  const skipped = [];

  for (const f of findings) {
    const file = touchedFiles.get(f.filepath);
    if (!file || !file.patch) {
      skipped.push({ finding: f, reason: 'file not in PR diff' });
      continue;
    }
    if (!isLineInPatch(file.patch, f.startLine)) {
      skipped.push({ finding: f, reason: 'line not in PR hunk' });
      continue;
    }
    inline.push({
      path: f.filepath,
      line: f.startLine,
      body: renderInlineCommentBody(f),
    });
  }

  // Build a concise body covering: the summary, the skipped findings (if any),
  // and a link back to the full review.
  const lines = [];
  lines.push(`## 🛡️ SecureReview AI — security review`);
  lines.push('');
  const risk = review.riskAssessment ?? 'low';
  lines.push(
    `**Overall risk:** ${RISK_EMOJI[risk] ?? ''} \`${risk.toUpperCase()}\` · ` +
      `**Findings:** ${findings.length} (${inline.length} inline, ${skipped.length} summarized below) · ` +
      `**Model:** \`${review.modelUsed ?? 'unknown'}\``
  );
  lines.push('');
  if (review.summary) {
    lines.push('> ' + review.summary.replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push(
      '### Findings not posted inline ' +
        '<sub>_(file or line not present in this PR\'s diff)_</sub>'
    );
    lines.push('');
    for (const { finding, reason } of skipped) {
      lines.push(
        `- ${SEVERITY_EMOJI[finding.severity] ?? ''} **${finding.title}** — ` +
          `\`${finding.filepath}:${finding.startLine}\` _(${reason})_`
      );
    }
    lines.push('');
  }

  const reviewUrl = `${APP_URL}/reviews/${review._id}`;
  lines.push(`_Full review → [open in SecureReview AI](${reviewUrl})_`);
  lines.push('');
  lines.push(
    '<sub>🤖 Automated review by [SecureReview AI](' +
      APP_URL +
      '). This is advisory, not a substitute for human review.</sub>'
  );

  return {
    body: lines.join('\n'),
    comments: inline,
    inlineCount: inline.length,
    skipped,
  };
}

// One inline finding's body. Compact — the file/line context is already
// provided by the inline anchor itself, so we skip the file: line header.
function renderInlineCommentBody(f) {
  const lines = [];
  lines.push(
    `${SEVERITY_EMOJI[f.severity] ?? ''} **${f.title}** ` +
      `\`[${(f.severity ?? 'info').toUpperCase()}]\``
  );
  lines.push('');
  if (f.description) {
    lines.push(f.description);
    lines.push('');
  }
  if (f.suggestedFix) {
    lines.push('**Suggested fix:**');
    lines.push('');
    lines.push('```' + guessFence(f.filepath));
    lines.push(String(f.suggestedFix).trimEnd());
    lines.push('```');
    lines.push('');
  }
  if (f.exploitabilityNotes) {
    lines.push(`_Exploitability:_ ${f.exploitabilityNotes}`);
    lines.push('');
  }
  if (Array.isArray(f.references) && f.references.length > 0) {
    lines.push('Refs: ' + f.references.map((r) => `<${r}>`).join(', '));
  }
  lines.push('');
  lines.push('<sub>🤖 SecureReview AI</sub>');
  return lines.join('\n');
}

// GitHub PR patch hunks look like:
//   @@ -10,7 +12,9 @@
// We only care about "+12,9" — the new file's starting line + hunk length.
// A finding line N qualifies for inline comment if N falls within
// [hunkStart, hunkStart + hunkLen - 1] for any hunk.
function isLineInPatch(patch, line) {
  if (!patch || !line) return false;
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = hunkRe.exec(patch)) !== null) {
    const start = Number(m[1]);
    const len = Number(m[2] ?? '1');
    if (line >= start && line < start + len) return true;
  }
  return false;
}

function guessFence(filepath = '') {
  const ext = filepath.split('.').pop()?.toLowerCase();
  const map = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    java: 'java',
    rs: 'rust',
    php: 'php',
    cs: 'csharp',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    sh: 'bash',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    html: 'html',
    css: 'css',
  };
  return map[ext] ?? '';
}
