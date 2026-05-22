import { config } from 'dotenv';

// Cognizant-managed laptops pre-set some API key env vars to empty strings
// at the OS level. dotenv's default behavior treats an existing empty string
// as "already populated" and refuses to fill it from .env.
//
// This helper sweeps empty env vars before loading, so:
//   - Real shell-provided env vars (production on Render, `FOO=bar npm run dev`,
//     test prefixes like `PRIMARY_LLM=claude node ...`) still win.
//   - Empty shell env vars get treated as missing, and .env fills them.
//   - On Render where there's no .env, nothing changes.
export function loadDotenv() {
  for (const key of Object.keys(process.env)) {
    if (process.env[key] === '') delete process.env[key];
  }
  config();
}
