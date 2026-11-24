// Runs a single resident Tavern conversation & reflection round against the
// persistent SQLite database. Suitable for manual invocation or cron.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmProvider } from './llm.mjs';
import { runTavernRound } from './loop.mjs';
import { TavernStore } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath =
  process.env.TAVERN_DB_PATH || path.join(__dirname, '..', 'data', 'tavern.db');
const threadId = process.env.TAVERN_THREAD_ID ? Number(process.env.TAVERN_THREAD_ID) : null;
const maxSpeakers = Number(process.env.TAVERN_MAX_SPEAKERS || 2);

const store = new TavernStore(dbPath);
const llm = createLlmProvider();

try {
  const result = await runTavernRound({ store, llm, threadId, maxSpeakers });
  console.log(JSON.stringify(result, null, 2));
} finally {
  store.close();
}
