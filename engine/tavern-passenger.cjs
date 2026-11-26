'use strict';

// HostArmada Phusion Passenger / LiteSpeed lsnode CommonJS startup entrypoint
// for the Persistent Rusty Flagon AI Tavern server (mounted at https://codey.info/engine/).
// Binds http.Server synchronously on module load so Passenger/lsnode intercepts
// server.listen() immediately while ESM modules & SQLite initialize asynchronously.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function loadLocalEnv(envPath) {
  try {
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore unreadable .env file.
  }
}

async function createTavernApp() {
  loadLocalEnv(process.env.TAVERN_ENV_FILE || path.join(__dirname, '.env'));

  const { createTavernServer } = await import('./tavern/server.mjs');
  const { createLlmProvider } = await import('./tavern/llm.mjs');
  const { TavernStore } = await import('./tavern/store.mjs');

  const basePath =
    process.env.TAVERN_BASE_PATH !== undefined
      ? process.env.TAVERN_BASE_PATH
      : process.env.PASSENGER_BASE_URI || '/engine';
  const publicOrigin =
    process.env.TAVERN_PUBLIC_ORIGIN !== undefined
      ? process.env.TAVERN_PUBLIC_ORIGIN
      : basePath === '/engine'
        ? 'https://codey.info'
        : '';
  const dbPath =
    process.env.TAVERN_DB_PATH || path.join(__dirname, 'data', 'tavern.db');
  const fandomStatePath =
    process.env.FORUM_FANDOM_STATE_PATH || path.join(__dirname, 'data', 'forum-fandoms.json');
  const agentStatePath =
    process.env.FORUM_AGENT_STATE_PATH || path.join(__dirname, 'data', 'phpbb-agents.json');
  const forumUrl = process.env.FORUM_URL || 'https://codey.info/forum';
  const aiBoardId = Number(process.env.FORUM_AI_BOARD_ID || 5);
  const forumGroupId = Number(process.env.FORUM_AI_GROUP_ID || 9);
  const enableForumBridge = process.env.FORUM_BRIDGE_ENABLED !== 'false';

  const store = new TavernStore(dbPath);
  const llm = createLlmProvider();
  return createTavernServer({
    store,
    llm,
    basePath,
    publicOrigin,
    fandomStatePath,
    agentStatePath,
    forumUrl,
    aiBoardId,
    forumGroupId,
    enableForumBridge,
    rateLimits: {
      roundCooldownSeconds: Number(process.env.TAVERN_ROUND_COOLDOWN_SECONDS ?? 20),
      maxRoundsPerDay: Number(process.env.TAVERN_MAX_ROUNDS_PER_DAY ?? 120),
    },
  });
}

function createPassengerWrapperServer() {
  let appPromise = null;
  let bootError = null;

  const ensureApp = () => {
    if (!appPromise) {
      appPromise = createTavernApp().catch((error) => {
        bootError = error;
        console.error(`Failed to initialize Tavern app: ${error?.code || error?.message || error}`);
        throw error;
      });
    }
    return appPromise;
  };

  // Start async ESM + SQLite boot immediately in the background.
  ensureApp().catch(() => {});

  const server = http.createServer((req, res) => {
    ensureApp()
      .then((app) => {
        app.server.emit('request', req, res);
      })
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: {
                code: 'tavern_boot_failed',
                message: (bootError || error)?.message || 'Tavern server failed to initialize',
              },
            })
          );
        }
      });
  });

  const close = () =>
    new Promise((resolve) => {
      server.close(() => {
        if (!appPromise) return resolve();
        appPromise
          .then((app) => app.store.close())
          .catch(() => {})
          .finally(() => resolve());
      });
    });

  return { server, ensureApp, close };
}

function startPassengerTavern() {
  const { server, ensureApp, close } = createPassengerWrapperServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';

  server.listen(port, host, () => {
    console.log(`Rusty Flagon Tavern Passenger server listening on ${host}:${port}`);
  });

  const shutdown = () => close().finally(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { server, ensureApp, close };
}

// Auto-start synchronously when loaded by Phusion Passenger, LiteSpeed lsnode,
// or direct CLI execution — skipping only during `node --test` or explicit opt-out.
const isTestRunner =
  process.execArgv.includes('--test') || process.env.TAVERN_NO_AUTOSTART === '1';

if (!isTestRunner) {
  startPassengerTavern();
}

module.exports = { createPassengerWrapperServer, createTavernApp, startPassengerTavern };
