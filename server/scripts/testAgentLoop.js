// Phase 7 verification — run the full agent loop against a real PR URL.
//
// Usage:
//   node --use-system-ca scripts/testAgentLoop.js <prUrl>
//
// Picks the first User in the DB to source the GitHub access token. Creates
// a fresh Review, runs the loop, prints phase progress, then dumps the final
// findings.

import { loadDotenv } from '../src/utils/env.js';
loadDotenv();

import mongoose from 'mongoose';
import User from '../src/models/User.js';
import Review from '../src/models/Review.js';
import { runReview, parsePrUrl } from '../src/agent/agentLoop.js';

async function main() {
  const prUrl = process.argv[2];
  if (!prUrl) {
    console.error('Usage: node scripts/testAgentLoop.js <prUrl>');
    process.exit(1);
  }
  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    console.error(`Could not parse PR URL: ${prUrl}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  // Pick the only/first user in the DB.
  const user = await User.findOne().select('+accessToken');
  if (!user) {
    console.error('No user found. Sign in via the frontend at least once.');
    process.exit(1);
  }

  // Create the Review doc the same way the route would.
  const review = await Review.create({
    userId: user._id,
    prUrl,
    prOwner: parsed.owner,
    prRepo: parsed.repo,
    prNumber: parsed.prNumber,
    status: 'queued',
  });
  console.log(`Created review ${review._id} for ${parsed.owner}/${parsed.repo}#${parsed.prNumber}\n`);

  // Console emitter — show meaningful phase transitions, suppress chatty iter starts.
  const emitter = (ev) => {
    if (ev.type === 'phase_start') {
      console.log(`\n>>> PHASE START: ${ev.phase}`);
    } else if (ev.type === 'phase_complete') {
      console.log(`<<< PHASE DONE:  ${ev.phase}  (${ev.durationMs}ms)`);
    } else if (ev.type === 'phase_error') {
      console.log(`!!! PHASE ERR:   ${ev.phase}  ${ev.error}`);
    } else if (ev.type === 'tool_call') {
      const args = JSON.stringify(ev.arguments);
      console.log(`    🔧 ${ev.tool}(${args.length > 100 ? args.slice(0, 100) + '...' : args})`);
    } else if (ev.type === 'tool_result') {
      const r = ev.result;
      const summary = r?.error
        ? `ERROR: ${r.error}`
        : Array.isArray(r)
          ? `${r.length} items`
          : typeof r === 'object'
            ? Object.keys(r ?? {}).join(',').slice(0, 80)
            : String(r).slice(0, 80);
      console.log(`    ↳  (${ev.durationMs}ms) ${summary}`);
    } else if (ev.type === 'review_complete') {
      console.log(`\n=== REVIEW COMPLETE: ${ev.findings} findings, ${ev.tokensUsed} tokens, ${ev.durationMs}ms ===`);
    } else if (ev.type === 'review_failed') {
      console.log(`\n=== REVIEW FAILED: ${ev.error} ===`);
    } else if (ev.type === 'pr_metadata') {
      console.log(`PR title: "${ev.title}"`);
    }
  };

  try {
    await runReview({
      reviewId: review._id,
      accessToken: user.getAccessToken(),
      emitter,
    });
  } catch (err) {
    console.error('\nrunReview threw:', err.message);
  }

  // Reload to get final state
  const final = await Review.findById(review._id);
  console.log('\n--- FINAL ---');
  console.log('Status:           ', final.status);
  console.log('Risk:             ', final.riskAssessment);
  console.log('Findings:         ', final.findings.length);
  console.log('Tool calls total: ', final.toolCalls.length);
  console.log('Tokens used:      ', final.tokensUsed);
  console.log('Models used:      ', final.modelUsed);
  console.log('Duration:         ', final.durationMs, 'ms');
  console.log('Status message:   ', final.statusMessage ?? 'OK');
  console.log('\nSummary:');
  console.log(final.summary);
  console.log('\nFindings:');
  for (const f of final.findings) {
    console.log(`\n  [${f.severity}] ${f.title}  (${f.category}, conf=${f.confidence})`);
    console.log(`  ${f.filepath}:${f.startLine}-${f.endLine}`);
    console.log(`  ${f.description}`);
    if (f.references?.length) console.log(`  Refs: ${f.references.join(', ')}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await mongoose.disconnect();
  process.exit(1);
});
