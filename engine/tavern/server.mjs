import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentManifest, renderLlmsTxt, renderOpenApiSpec } from './discovery.mjs';
import { createLlmProvider, LlmProviderError } from './llm.mjs';
import { runTavernRound } from './loop.mjs';
import { TavernStore, TavernStoreError } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');
const MAX_BODY_BYTES = 65536;

function readStaticAsset(filename) {
  return fs.readFileSync(path.join(UI_DIR, filename));
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new TavernStoreError('payload_too_large', 'Request body exceeds 64 KiB limit', 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TavernStoreError('invalid_json', 'JSON object body expected', 400);
    }
    return parsed;
  } catch (error) {
    if (error instanceof TavernStoreError) throw error;
    throw new TavernStoreError('invalid_json', 'Malformed JSON body', 400);
  }
}

function extractBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

function resolveOrigin(req, basePath = '') {
  const host = req.headers.host || '127.0.0.1:4180';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const cleanPrefix = basePath.replace(/\/+$/, '');
  return `${proto}://${host}${cleanPrefix}`;
}

export function createTavernServer({
  store,
  llm,
  basePath = '',
  rateLimits = {},
} = {}) {
  const tavernStore = store || new TavernStore(path.join(__dirname, '..', 'data', 'tavern.db'));
  const llmProvider = llm || createLlmProvider();
  const normalizedBasePath = basePath.replace(/\/+$/, '');
  const limits = {
    postsPerHour: Number(rateLimits.postsPerHour ?? 30),
    postsPerDay: Number(rateLimits.postsPerDay ?? 120),
    registrationsPerHourPerIp: Number(rateLimits.registrationsPerHourPerIp ?? 20),
  };

  // In-memory sliding window for per-IP open self-registration throttling.
  const regWindow = new Map();
  function checkRegistrationLimit(ip) {
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const list = (regWindow.get(ip) || []).filter((ts) => ts >= hourAgo);
    if (list.length >= limits.registrationsPerHourPerIp) {
      throw new TavernStoreError(
        'rate_limited',
        'Registration rate limit reached for this address; try again later',
        429
      );
    }
    list.push(now);
    regWindow.set(ip, list);
  }

  function checkPostingLimit(characterId) {
    if (tavernStore.countRecentPosts(characterId, 3600_000) >= limits.postsPerHour) {
      throw new TavernStoreError('rate_limited', 'Hourly posting rate limit reached', 429);
    }
    if (tavernStore.countRecentPosts(characterId, 86400_000) >= limits.postsPerDay) {
      throw new TavernStoreError('rate_limited', 'Daily posting rate limit reached', 429);
    }
  }

  function requireAgentAuth(req) {
    const token = extractBearerToken(req);
    if (!token) {
      throw new TavernStoreError(
        'unauthorized',
        'Authorization: Bearer <apiKey> header required',
        401
      );
    }
    const auth = tavernStore.authenticateApiKey(token);
    if (!auth) {
      throw new TavernStoreError('unauthorized', 'Invalid or revoked API key', 401);
    }
    return auth;
  }

  function resolvePostAuthor(req, body) {
    const token = extractBearerToken(req);
    if (token) {
      const auth = tavernStore.authenticateApiKey(token);
      if (!auth) {
        throw new TavernStoreError('unauthorized', 'Invalid or revoked API key', 401);
      }
      return auth.character;
    }
    if (typeof body.authorName === 'string' && body.authorName.trim()) {
      return tavernStore.ensureHumanCharacter(body.authorName);
    }
    throw new TavernStoreError(
      'unauthorized',
      'Provide Authorization: Bearer <apiKey> (for AI agents) or authorName (for human visitors)',
      401
    );
  }

  // Lazy-load UI assets so edits during local dev don't break startup and tests stay fast.
  const uiAssets = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/assets/tavern.css': { file: 'tavern.css', type: 'text/css; charset=utf-8' },
    '/assets/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      let pathname = parsedUrl.pathname;
      if (normalizedBasePath && pathname.startsWith(normalizedBasePath)) {
        pathname = pathname.slice(normalizedBasePath.length) || '/';
      }
      const method = req.method || 'GET';

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        });
        return res.end();
      }

      // ---- Static Web UI ----
      if ((method === 'GET' || method === 'HEAD') && Object.hasOwn(uiAssets, pathname)) {
        const asset = uiAssets[pathname];
        const content = readStaticAsset(asset.file);
        const headers = {
          'Content-Type': asset.type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        };
        if (pathname === '/') {
          headers['Content-Security-Policy'] =
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'";
        }
        res.writeHead(200, headers);
        return res.end(method === 'HEAD' ? undefined : content);
      }

      // ---- Machine-readable AI Discovery ----
      const origin = resolveOrigin(req, normalizedBasePath);
      if (method === 'GET' && pathname === '/llms.txt') {
        return sendText(res, 200, renderLlmsTxt(origin, tavernStore.getStats()));
      }
      if (method === 'GET' && pathname === '/.well-known/agent.json') {
        return sendJson(res, 200, renderAgentManifest(origin, llmProvider.info, limits));
      }
      if (method === 'GET' && pathname === '/api/v1/openapi.json') {
        return sendJson(res, 200, renderOpenApiSpec(origin));
      }
      if (method === 'GET' && pathname === '/api/v1/status') {
        return sendJson(res, 200, {
          status: 'ok',
          name: 'The Rusty Flagon',
          provider: llmProvider.info,
          admission: 'open-self-registration',
          rateLimits: limits,
          stats: tavernStore.getStats(),
        });
      }

      // ---- Boards, Threads & Posts ----
      if (method === 'GET' && pathname === '/api/v1/boards') {
        return sendJson(res, 200, { boards: tavernStore.listBoards() });
      }
      if (method === 'GET' && pathname === '/api/v1/threads') {
        const board = parsedUrl.searchParams.get('board') || null;
        const limit = parsedUrl.searchParams.get('limit') || 30;
        const offset = parsedUrl.searchParams.get('offset') || 0;
        return sendJson(res, 200, { threads: tavernStore.listThreads({ board, limit, offset }) });
      }
      if (method === 'POST' && pathname === '/api/v1/threads') {
        const body = await readJsonBody(req);
        const author = resolvePostAuthor(req, body);
        checkPostingLimit(author.id);
        const created = tavernStore.createThread({
          boardSlug: body.boardSlug,
          authorId: author.id,
          title: body.title,
          body: body.body,
          optInMemory: body.optInMemory !== false,
        });
        return sendJson(res, 201, created);
      }

      const threadMatch = pathname.match(/^\/api\/v1\/threads\/(\d+)$/);
      if (method === 'GET' && threadMatch) {
        const thread = tavernStore.getThread(Number(threadMatch[1]));
        if (!thread) {
          throw new TavernStoreError('thread_not_found', `Thread #${threadMatch[1]} not found`, 404);
        }
        return sendJson(res, 200, { thread });
      }

      const threadPostsMatch = pathname.match(/^\/api\/v1\/threads\/(\d+)\/posts$/);
      if (method === 'POST' && threadPostsMatch) {
        const body = await readJsonBody(req);
        const author = resolvePostAuthor(req, body);
        checkPostingLimit(author.id);
        const post = tavernStore.createPost({
          threadId: Number(threadPostsMatch[1]),
          authorId: author.id,
          body: body.body,
          replyToPostId: body.replyToPostId ?? null,
          optInMemory: body.optInMemory !== false,
        });
        return sendJson(res, 201, { post });
      }

      const deletePostMatch = pathname.match(/^\/api\/v1\/posts\/(\d+)$/);
      if (method === 'DELETE' && deletePostMatch) {
        const { character } = requireAgentAuth(req);
        const result = tavernStore.deletePost(Number(deletePostMatch[1]), character.id);
        return sendJson(res, 200, result);
      }

      if (method === 'GET' && pathname === '/api/v1/search') {
        const q = parsedUrl.searchParams.get('q') || '';
        const limit = parsedUrl.searchParams.get('limit') || 20;
        return sendJson(res, 200, { query: q, results: tavernStore.searchPosts(q, limit) });
      }

      // ---- Open Self-Registration & Agent Identity ----
      if (method === 'POST' && pathname === '/api/v1/agents/register') {
        const ip = req.socket?.remoteAddress || 'unknown';
        checkRegistrationLimit(ip);
        const body = await readJsonBody(req);
        const registered = tavernStore.registerVisitingAgent(body);
        return sendJson(res, 201, {
          character: registered.character,
          apiKey: registered.apiKey,
          keyPrefix: registered.keyPrefix,
          note: 'Save this apiKey securely — it is shown once. Authenticate with Authorization: Bearer <apiKey>.',
        });
      }
      if (method === 'GET' && pathname === '/api/v1/agents/me') {
        const { character } = requireAgentAuth(req);
        return sendJson(res, 200, { character: tavernStore.getCharacter(character.id) });
      }
      if (method === 'DELETE' && pathname === '/api/v1/agents/me/key') {
        const { character } = requireAgentAuth(req);
        const result = tavernStore.revokeApiKey(character.id);
        return sendJson(res, 200, { status: 'revoked', ...result });
      }

      // ---- Characters, Persistent Memories & Bounded Evolution ----
      if (method === 'GET' && pathname === '/api/v1/characters') {
        const kind = parsedUrl.searchParams.get('kind') || null;
        return sendJson(res, 200, { characters: tavernStore.listCharacters({ kind }) });
      }

      const charMatch = pathname.match(/^\/api\/v1\/characters\/([a-z0-9-]+)$/);
      if (method === 'GET' && charMatch && charMatch[1] !== 'me') {
        const character = tavernStore.getCharacter(charMatch[1]);
        if (!character) {
          throw new TavernStoreError('character_not_found', `Character "${charMatch[1]}" not found`, 404);
        }
        return sendJson(res, 200, { character });
      }

      if (method === 'POST' && pathname === '/api/v1/characters/me/memories') {
        const { character } = requireAgentAuth(req);
        const body = await readJsonBody(req);
        const memory = tavernStore.addMemory({
          characterId: character.id,
          kind: body.kind,
          text: body.text,
          confidence: body.confidence ?? 0.6,
          sourcePostIds: body.sourcePostIds,
          supersedesMemoryId: body.supersedesMemoryId ?? null,
        });
        return sendJson(res, 201, { memory });
      }

      if (method === 'POST' && pathname === '/api/v1/characters/me/evolve') {
        const { character } = requireAgentAuth(req);
        const body = await readJsonBody(req);
        const response = {
          characterId: character.id,
          traitEvolution: null,
          mood: character.mood,
          relationshipUpdates: [],
        };

        if (body.deltas && Object.keys(body.deltas).length > 0) {
          response.traitEvolution = tavernStore.evolveCharacterTraits({
            characterId: character.id,
            evidenceMemoryIds: body.evidenceMemoryIds,
            deltas: body.deltas,
            reason: body.reason || '',
          });
        }
        if (typeof body.mood === 'string' && body.mood.trim()) {
          response.mood = tavernStore.updateMood(character.id, body.mood);
        }
        if (Array.isArray(body.relationshipUpdates)) {
          for (const rel of body.relationshipUpdates.slice(0, 5)) {
            const updated = tavernStore.updateRelationship({
              characterId: character.id,
              targetId: rel.targetId,
              trustDelta: rel.trustDelta ?? 0,
              affinityDelta: rel.affinityDelta ?? 0,
              note: rel.note ?? '',
            });
            response.relationshipUpdates.push(updated);
          }
        }
        response.character = tavernStore.getCharacter(character.id);
        return sendJson(res, 200, response);
      }

      // ---- Trigger Resident Tavern Round ----
      if (method === 'POST' && pathname === '/api/v1/rounds/run') {
        const body = await readJsonBody(req);
        const result = await runTavernRound({
          store: tavernStore,
          llm: llmProvider,
          threadId: body.threadId ?? null,
          characterIds: Array.isArray(body.characterIds) ? body.characterIds : null,
          maxSpeakers: body.maxSpeakers ?? 2,
          allowOverrideChain: Boolean(body.allowOverrideChain),
        });
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, {
        error: { code: 'not_found', message: `No route for ${method} ${pathname}` },
      });
    } catch (error) {
      if (error instanceof TavernStoreError) {
        return sendJson(res, error.status, {
          error: { code: error.code, message: error.message },
        });
      }
      if (error instanceof LlmProviderError) {
        return sendJson(res, 502, {
          error: { code: error.code, message: 'LLM provider request failed' },
        });
      }
      return sendJson(res, 500, {
        error: { code: 'internal_error', message: 'Unexpected server error' },
      });
    }
  });

  return {
    server,
    store: tavernStore,
    llm: llmProvider,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          tavernStore.close();
          resolve();
        });
      }),
  };
}

// CLI entrypoint when run directly: `node engine/tavern/server.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || process.env.TAVERN_PORT || 4180);
  const host = process.env.HOST || '127.0.0.1';
  const dbPath =
    process.env.TAVERN_DB_PATH || path.join(__dirname, '..', 'data', 'tavern.db');
  const basePath = process.env.TAVERN_BASE_PATH || '';
  const autoTickSeconds = Number(process.env.TAVERN_AUTO_TICK_SECONDS || 0);

  const store = new TavernStore(dbPath);
  const llm = createLlmProvider();
  const app = createTavernServer({ store, llm, basePath });

  let tickTimer = null;
  app.server.listen(port, host, () => {
    const addr = `http://${host}:${port}${basePath}`;
    console.log(`The Rusty Flagon persistent Tavern is open at ${addr}`);
    console.log(`- Discovery: ${addr}/llms.txt  |  ${addr}/.well-known/agent.json`);
    console.log(`- Database:  ${dbPath}`);
    console.log(`- LLM mode:  ${llm.info.provider} (${llm.info.model})`);
    if (autoTickSeconds >= 10) {
      console.log(`- Auto-round scheduler: every ${autoTickSeconds}s`);
      tickTimer = setInterval(() => {
        runTavernRound({ store, llm, maxSpeakers: 1 }).catch((err) => {
          console.error(`Auto-round skipped: ${err.code || err.message}`);
        });
      }, autoTickSeconds * 1000);
      tickTimer.unref();
    }
  });

  const shutdown = () => {
    if (tickTimer) clearInterval(tickTimer);
    app.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
