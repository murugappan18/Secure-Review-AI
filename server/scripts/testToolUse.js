// Phase 5 verification — one tool, one round trip, end-to-end.
//
// Usage:
//   node --use-system-ca scripts/testToolUse.js                # uses PRIMARY_LLM
//   PRIMARY_LLM=claude node --use-system-ca scripts/testToolUse.js
//   node --use-system-ca scripts/testToolUse.js <repoId>       # specific repo
//
// What it proves:
//   - The LLM client receives a tool definition.
//   - The model autonomously decides to call it with sensible arguments.
//   - We execute the tool and feed the result back.
//   - The model produces a final summary citing the retrieved code.

import { loadDotenv } from '../src/utils/env.js';
loadDotenv();

import mongoose from 'mongoose';
import { chat } from '../src/services/llm/llmRouter.js';
import { searchCode } from '../src/services/vectorSearch.service.js';
import Repo from '../src/models/Repo.js';

const SYSTEM_PROMPT = `You are a code analyst exploring an unfamiliar repository.
Use the search_code tool to find relevant code chunks. When you respond, cite
each finding with filepath:startLine-endLine. Keep the final answer under
6 short bullet points.`;

const USER_PROMPT =
  'Find any React components in this repo that manage state with hooks. ' +
  'Use search_code to look for them, then list what you found.';

const TOOLS = [
  {
    name: 'search_code',
    description:
      'Semantic + text search over the indexed code chunks of this repository. ' +
      'Returns the most relevant function/class chunks for a natural-language query.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language query, e.g. "authentication middleware" or "input validation".',
        },
        limit: {
          type: 'number',
          description: 'Max number of chunks to return. Default 6.',
        },
      },
      required: ['query'],
    },
  },
];

async function executeTool(name, args, repoId) {
  if (name === 'search_code') {
    const results = await searchCode(args.query, {
      repoId,
      limit: args.limit ?? 6,
    });
    // Compact projection — full content blows tool result size up.
    return results.map((r) => ({
      filepath: r.filepath,
      name: r.name,
      type: r.type,
      lines: `${r.startLine}-${r.endLine}`,
      snippet: r.content?.slice(0, 400),
    }));
  }
  throw new Error(`unknown tool: ${name}`);
}

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

  console.log(`=== Using repo: ${repo.fullName} (${repo._id}) — ${repo.chunkCount} chunks ===\n`);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT },
  ];

  // --- Round 1: model decides whether to call a tool ---
  console.log('--- Round 1: initial LLM call ---');
  const r1 = await chat({ messages, tools: TOOLS });
  console.log(`Answered by   : ${r1.provider} (${r1.model})`);
  console.log(`Finish reason : ${r1.finishReason}`);
  console.log(`Tokens        : ${r1.usage.inputTokens} in, ${r1.usage.outputTokens} out`);
  console.log(`Tool calls    : ${r1.toolCalls.length}`);
  if (r1.text) console.log(`Text          : ${r1.text}`);
  for (const tc of r1.toolCalls) {
    console.log(`  → ${tc.name}(${JSON.stringify(tc.arguments)})`);
  }

  if (r1.toolCalls.length === 0) {
    console.log('\nModel chose not to call any tool. Test inconclusive.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // --- Execute every requested tool call ---
  console.log('\n--- Executing tool calls ---');
  const toolResults = [];
  for (const tc of r1.toolCalls) {
    const result = await executeTool(tc.name, tc.arguments, repo._id);
    console.log(`  ${tc.name} → ${result.length} chunks`);
    for (const r of result.slice(0, 3)) {
      console.log(`     ${r.filepath} :: ${r.name} (${r.lines})`);
    }
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
    tools: TOOLS,
    preferProvider: r1.provider,
  });
  console.log(`Answered by   : ${r2.provider} (${r2.model})`);
  console.log(`Tokens        : ${r2.usage.inputTokens} in, ${r2.usage.outputTokens} out`);
  console.log('---');
  console.log(r2.text ?? '(no text)');
  console.log('---\n');

  console.log(`Total tokens used in test: ${
    r1.usage.inputTokens + r1.usage.outputTokens + r2.usage.inputTokens + r2.usage.outputTokens
  }`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Test failed:', err);
  if (err.triedProviders) console.error('Providers tried:', err.triedProviders);
  await mongoose.disconnect();
  process.exit(1);
});
