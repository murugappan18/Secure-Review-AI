// Phase 5 + 6 verification — one round trip, end-to-end, with the tools
// flowing through the MCP registry instead of inline definitions.
//
// Usage:
//   node --use-system-ca scripts/testToolUse.js                # uses PRIMARY_LLM
//   PRIMARY_LLM=claude node --use-system-ca scripts/testToolUse.js
//   node --use-system-ca scripts/testToolUse.js <repoId>       # specific repo
//
// What it proves (in addition to Phase 5):
//   - The MCP registry assembles tools from codebase + security MCP servers.
//   - The adapter converts them into a shape our LLM clients consume.
//   - The agent autonomously picks the right tool from a 12-tool palette.
//   - executeToolCall validates args + routes to the right handler.

import { loadDotenv } from '../src/utils/env.js';
loadDotenv();

import mongoose from 'mongoose';
import { chat } from '../src/services/llm/llmRouter.js';
import {
  getGenericTools,
  executeToolCall,
  describeRegistry,
} from '../src/mcp/registry.js';
import Repo from '../src/models/Repo.js';

const SYSTEM_PROMPT = `You are a code analyst exploring an unfamiliar repository.
Use the available tools to find relevant code. When you respond, cite each
finding with filepath:startLine-endLine. Keep the final answer concise —
no more than 6 short bullet points.`;

const USER_PROMPT =
  'Find any React components in this repo that manage state with hooks. ' +
  'Use the available tools to look for them, then list what you found.';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const argRepoId = process.argv[2];
  const repo = argRepoId
    ? await Repo.findById(argRepoId)
    : await Repo.findOne({ indexStatus: 'ready', chunkCount: { $gt: 0 } });

  if (!repo) {
    console.error('No indexed repo found. Index one in the dashboard first.');
    process.exit(1);
  }

  // --- Show what the registry knows about ---
  console.log('=== MCP registry contents ===');
  const desc = describeRegistry();
  for (const [serverName, tools] of Object.entries(desc)) {
    console.log(`\n[${serverName}]  ${tools.length} tools`);
    for (const t of tools) {
      console.log(`  - ${t.name}`);
    }
  }

  console.log(`\n=== Using repo: ${repo.fullName} (${repo._id}) — ${repo.chunkCount} chunks ===\n`);

  // Pull tools from codebase + security servers only. GitHub tools require
  // an access token in ctx; this dev script doesn't run as a user, so we skip
  // them. Phase 7's agent loop will pass the real token through.
  const tools = getGenericTools({ servers: ['codebase', 'security'] });
  console.log(`Offering ${tools.length} tools to the LLM\n`);

  const ctx = { repoId: repo._id };

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT },
  ];

  // --- Round 1: model picks a tool ---
  console.log('--- Round 1: initial LLM call ---');
  const r1 = await chat({ messages, tools });
  console.log(`Answered by   : ${r1.provider} (${r1.model})`);
  console.log(`Finish reason : ${r1.finishReason}`);
  console.log(`Tokens        : ${r1.usage.inputTokens} in, ${r1.usage.outputTokens} out`);
  console.log(`Tool calls    : ${r1.toolCalls.length}`);
  if (r1.text) console.log(`Text          : ${r1.text}`);
  for (const tc of r1.toolCalls) {
    console.log(`  → ${tc.name}(${JSON.stringify(tc.arguments)})`);
  }

  if (r1.toolCalls.length === 0) {
    console.log('\nModel chose not to call any tool. Inconclusive.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // --- Execute every tool call through the registry ---
  console.log('\n--- Executing tool calls via registry ---');
  const toolResults = [];
  for (const tc of r1.toolCalls) {
    const result = await executeToolCall(tc.name, tc.arguments, ctx);
    const summary = Array.isArray(result)
      ? `${result.length} items`
      : result?.error
        ? `ERROR: ${result.error}`
        : Object.keys(result ?? {}).join(', ');
    console.log(`  ${tc.name} → ${summary}`);
    toolResults.push({
      toolCallId: tc.id,
      name: tc.name,
      content: JSON.stringify(result),
    });
  }

  // --- Round 2: feed results, get final answer ---
  console.log('\n--- Round 2: final answer ---');
  const messages2 = [
    ...messages,
    { role: 'assistant', content: r1.text, toolCalls: r1.toolCalls },
    ...toolResults.map((tr) => ({
      role: 'tool',
      toolCallId: tr.toolCallId,
      name: tr.name,
      content: tr.content,
    })),
  ];
  const r2 = await chat({
    messages: messages2,
    tools,
    preferProvider: r1.provider,
  });
  console.log(`Answered by   : ${r2.provider} (${r2.model})`);
  console.log(`Tokens        : ${r2.usage.inputTokens} in, ${r2.usage.outputTokens} out`);
  console.log('---');
  console.log(r2.text ?? '(no text)');
  console.log('---\n');

  console.log(
    `Total tokens: ${
      r1.usage.inputTokens +
      r1.usage.outputTokens +
      r2.usage.inputTokens +
      r2.usage.outputTokens
    }`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Test failed:', err);
  if (err.triedProviders) console.error('Providers tried:', err.triedProviders);
  await mongoose.disconnect();
  process.exit(1);
});
