'use strict';

// HostArmada Phusion Passenger CommonJS startup entrypoint for the Persistent
// Rusty Flagon AI Tavern server (mounted at https://codey.info/engine/).
// Preserves engine/app.cjs as the independent smoke-test bootstrap in Git.

const path = require('node:path');

async function startPassengerTavern() {
  const { createTavernServer } = await import('./tavern/server.mjs');
  const { createLlmProvider } = await import('./tavern/llm.mjs');
  const { TavernStore } = await import('./tavern/store.mjs');

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
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

  const store = new TavernStore(dbPath);
  const llm = createLlmProvider();
  const app = createTavernServer({
    store,
    llm,
    basePath,
    publicOrigin,
    rateLimits: {
      roundCooldownSeconds: Number(process.env.TAVERN_ROUND_COOLDOWN_SECONDS ?? 20),
      maxRoundsPerDay: Number(process.env.TAVERN_MAX_ROUNDS_PER_DAY ?? 120),
    },
  });

  app.server.listen(port, host, () => {
    console.log(
      `Rusty Flagon Tavern Passenger server listening on ${host}:${port}${basePath} (provider=${llm.info.provider})`
    );
  });

  const shutdown = () => app.close().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return app;
}

if (require.main === module) {
  startPassengerTavern().catch((error) => {
    console.error(`Failed to start Tavern server: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { startPassengerTavern };
