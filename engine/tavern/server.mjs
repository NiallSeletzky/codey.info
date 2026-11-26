import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentManifest, renderLlmsTxt, renderOpenApiSpec } from './discovery.mjs';
import { createForumBridge, ForumBridgeError } from './forum-bridge.mjs';
import { createLlmProvider, LlmProviderError } from './llm.mjs';
import { runTavernRound } from './loop.mjs';
import { createMcpHandler } from './mcp.mjs';
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
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
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

async function readJsonPayload(req) {
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
    return JSON.parse(raw);
  } catch {
    throw new TavernStoreError('invalid_json', 'Malformed JSON body', 400);
  }
}

async function readJsonBody(req) {
  const parsed = await readJsonPayload(req);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TavernStoreError('invalid_json', 'JSON object body expected', 400);
  }
  return parsed;
}

function extractBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

function resolveClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function resolveOrigin(req, basePath = '', publicOrigin = '') {
  const cleanPrefix = basePath.replace(/\/+$/, '');
  if (publicOrigin) {
    return `${publicOrigin.replace(/\/+$/, '')}${cleanPrefix}`;
  }
  const host = req.headers.host || '127.0.0.1:4180';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = forwardedProto === 'https' ? 'https' : 'http';
  return `${proto}://${host}${cleanPrefix}`;
}

export function createTavernServer({
  store,
  llm,
  basePath = '',
  publicOrigin = process.env.TAVERN_PUBLIC_ORIGIN || '',
  adminToken = process.env.TAVERN_ADMIN_TOKEN || '',
  fandomStatePath = process.env.FORUM_FANDOM_STATE_PATH ||
    path.join(__dirname, '..', 'data', 'forum-fandoms.json'),
  agentStatePath,
  forumUrl = process.env.FORUM_URL || 'https://codey.info/forum',
  aiBoardId = Number(process.env.FORUM_AI_BOARD_ID || 5),
  forumGroupId = Number(process.env.FORUM_AI_GROUP_ID || 9),
  forumBridge = null,
  forumClientFactory = null,
  enableForumBridge,
  forumCacheTtlMs = 60_000,
  forumWriteCooldownMs = 3000,
  rateLimits = {},
} = {}) {
  const tavernStore = store || new TavernStore(path.join(__dirname, '..', 'data', 'tavern.db'));
  const llmProvider = llm || createLlmProvider();
  const normalizedBasePath = basePath.replace(/\/+$/, '');
  const isLiveForumBridge =
    enableForumBridge === false
      ? false
      : enableForumBridge === true ||
        Boolean(forumBridge) ||
        Boolean(forumClientFactory) ||
        tavernStore.dbPath !== ':memory:';
  const resolvedAgentStatePath =
    agentStatePath !== undefined
      ? agentStatePath
      : process.env.FORUM_AGENT_STATE_PATH ||
        (tavernStore.dbPath === ':memory:'
          ? null
          : path.join(__dirname, '..', 'data', 'phpbb-agents.json'));
  const bridge =
    forumBridge ||
    createForumBridge({
      store: tavernStore,
      forumUrl,
      aiBoardId,
      groupId: forumGroupId,
      agentStatePath: resolvedAgentStatePath,
      cacheTtlMs: forumCacheTtlMs,
      writeCooldownMs: forumWriteCooldownMs,
      liveEnabled: isLiveForumBridge,
      clientFactory: forumClientFactory,
    });
  const limits = {
    postsPerHour: Number(rateLimits.postsPerHour ?? 30),
    postsPerDay: Number(rateLimits.postsPerDay ?? 120),
    guestPostsPerHourPerIp: Number(rateLimits.guestPostsPerHourPerIp ?? 20),
    registrationsPerHourPerIp: Number(rateLimits.registrationsPerHourPerIp ?? 20),
    roundCooldownSeconds: Number(
      rateLimits.roundCooldownSeconds ?? process.env.TAVERN_ROUND_COOLDOWN_SECONDS ?? 0
    ),
    maxRoundsPerDay: Number(
      rateLimits.maxRoundsPerDay ?? process.env.TAVERN_MAX_ROUNDS_PER_DAY ?? 200
    ),
  };

  // Sliding windows for per-IP registration, guest posting, forum relay, and round budget caps.
  const regWindow = new Map();
  const guestPostWindow = new Map();
  const forumPostWindow = new Map();
  const roundTimestamps = [];
  const roundByIp = new Map();

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

  function checkGuestIpLimit(ip) {
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const list = (guestPostWindow.get(ip) || []).filter((ts) => ts >= hourAgo);
    if (list.length >= limits.guestPostsPerHourPerIp) {
      throw new TavernStoreError(
        'rate_limited',
        'Guest posting rate limit reached for this address; register an AI key or try later',
        429
      );
    }
    list.push(now);
    guestPostWindow.set(ip, list);
  }

  function checkRoundBudget(ip) {
    const now = Date.now();
    const dayAgo = now - 86400_000;
    while (roundTimestamps.length > 0 && roundTimestamps[0] < dayAgo) {
      roundTimestamps.shift();
    }
    if (roundTimestamps.length >= limits.maxRoundsPerDay) {
      const err = new TavernStoreError(
        'round_budget_exceeded',
        'Daily Tavern round cap reached; try again tomorrow',
        429
      );
      err.retryAfter = 3600;
      throw err;
    }
    if (limits.roundCooldownSeconds > 0) {
      const last = roundByIp.get(ip) || 0;
      const elapsedSec = (now - last) / 1000;
      if (elapsedSec < limits.roundCooldownSeconds) {
        const waitSec = Math.ceil(limits.roundCooldownSeconds - elapsedSec);
        const err = new TavernStoreError(
          'round_cooldown',
          `Please wait ${waitSec}s before triggering another Tavern round`,
          429
        );
        err.retryAfter = waitSec;
        throw err;
      }
      roundByIp.set(ip, now);
    }
    roundTimestamps.push(now);
  }

  function checkPostingLimit(characterId) {
    if (tavernStore.countRecentPosts(characterId, 3600_000) >= limits.postsPerHour) {
      throw new TavernStoreError('rate_limited', 'Hourly posting rate limit reached', 429);
    }
    if (tavernStore.countRecentPosts(characterId, 86400_000) >= limits.postsPerDay) {
      throw new TavernStoreError('rate_limited', 'Daily posting rate limit reached', 429);
    }
  }

  function checkForumPostingLimit(characterId) {
    checkPostingLimit(characterId);
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const dayAgo = now - 86400_000;
    const list = (forumPostWindow.get(characterId) || []).filter((ts) => ts >= dayAgo);
    const recentHour = list.filter((ts) => ts >= hourAgo).length;
    if (recentHour + tavernStore.countRecentPosts(characterId, 3600_000) >= limits.postsPerHour) {
      throw new TavernStoreError('rate_limited', 'Hourly posting rate limit reached', 429);
    }
    if (list.length + tavernStore.countRecentPosts(characterId, 86400_000) >= limits.postsPerDay) {
      throw new TavernStoreError('rate_limited', 'Daily posting rate limit reached', 429);
    }
    list.push(now);
    forumPostWindow.set(characterId, list);
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
      return { character: auth.character, isGuest: false };
    }
    if (typeof body.authorName === 'string' && body.authorName.trim()) {
      return { character: tavernStore.ensureHumanCharacter(body.authorName), isGuest: true };
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

  const mcpHandler = createMcpHandler({
    store: tavernStore,
    llm: llmProvider,
    limits,
    fandomStatePath,
    forumUrl,
    aiBoardId,
    forumBridge: bridge,
    checkRegistrationRateLimit: (ip) => {
      try {
        checkRegistrationLimit(ip);
        return true;
      } catch {
        return false;
      }
    },
    checkAgentPostRateLimit: (characterId) => {
      try {
        checkPostingLimit(characterId);
        return true;
      } catch {
        return false;
      }
    },
  });

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const rawPathname = parsedUrl.pathname;
      const method = req.method || 'GET';

      // Redirect /engine (missing trailing slash) -> /engine/ so relative UI links resolve properly.
      if (normalizedBasePath && rawPathname === normalizedBasePath && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(308, {
          Location: `${normalizedBasePath}/${parsedUrl.search}`,
          'Cache-Control': 'no-store',
        });
        return res.end();
      }

      let pathname = rawPathname;
      if (normalizedBasePath && pathname.startsWith(normalizedBasePath)) {
        pathname = pathname.slice(normalizedBasePath.length) || '/';
      }

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
          'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        });
        return res.end();
      }

      // ---- Remote MCP Streamable HTTP Server (/mcp) ----
      if (pathname === '/mcp') {
        const origin = resolveOrigin(req, normalizedBasePath, publicOrigin);
        if (method === 'POST') {
          let payload;
          try {
            payload = await readJsonPayload(req);
          } catch {
            return sendJson(res, 400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error: malformed JSON' },
            });
          }
          const result = await mcpHandler.handlePayload(payload, {
            bearerToken: extractBearerToken(req),
            clientIp: resolveClientIp(req),
            origin,
          });
          if (result.status === 202 || result.body === null) {
            res.writeHead(202, {
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
            });
            return res.end();
          }
          return sendJson(res, result.status, result.body);
        }
        if (method === 'GET' || method === 'HEAD') {
          const accept = String(req.headers.accept || '');
          if (accept.includes('text/event-stream')) {
            res.writeHead(405, {
              Allow: 'POST, OPTIONS',
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            return res.end(
              method === 'HEAD'
                ? undefined
                : JSON.stringify({
                    error: {
                      code: 'sse_not_supported',
                      message: 'Stateless Streamable HTTP MCP server: use HTTP POST to /mcp.',
                    },
                  })
            );
          }
          if (method === 'HEAD') {
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            });
            return res.end();
          }
          return sendJson(res, 200, mcpHandler.getDiscoveryInfo(origin));
        }
        if (method === 'DELETE') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          });
          return res.end();
        }
        res.writeHead(405, { Allow: 'GET, POST, DELETE, OPTIONS' });
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

      // ---- Machine-readable AI Discovery (supports GET & HEAD) ----
      const origin = resolveOrigin(req, normalizedBasePath, publicOrigin);
      if ((method === 'GET' || method === 'HEAD') && pathname === '/llms.txt') {
        const text = renderLlmsTxt(origin, tavernStore.getStats());
        if (method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end();
        }
        return sendText(res, 200, text);
      }
      if ((method === 'GET' || method === 'HEAD') && pathname === '/.well-known/agent.json') {
        const payload = renderAgentManifest(origin, llmProvider.info, limits);
        if (method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end();
        }
        return sendJson(res, 200, payload);
      }
      if (
        (method === 'GET' || method === 'HEAD') &&
        (pathname === '/api/v1/openapi.json' || pathname === '/openapi.json')
      ) {
        const spec = renderOpenApiSpec(origin);
        if (method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end();
        }
        return sendJson(res, 200, spec);
      }
      if ((method === 'GET' || method === 'HEAD') && pathname === '/api/v1/status') {
        const payload = {
          status: 'ok',
          name: 'The Rusty Flagon',
          provider: llmProvider.info,
          admission: 'open-self-registration',
          rateLimits: limits,
          stats: tavernStore.getStats(),
        };
        if (method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end();
        }
        return sendJson(res, 200, payload);
      }
      if ((method === 'GET' || method === 'HEAD') && pathname === '/api/v1/roundtable') {
        if (method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end();
        }
        const limitParam = parsedUrl.searchParams.get('limit');
        const limit = limitParam !== null ? Number(limitParam) : 16;
        const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 16;
        const roundtable = tavernStore.getRoundTable({
          fandomStatePath,
          forumUrl,
          aiBoardId,
          limit: safeLimit,
        });
        if (
          roundtable.boards.length === 0 &&
          roundtable.forumThreads.length === 0 &&
          bridge.liveEnabled
        ) {
          try {
            const live = await bridge.listTopics({ limit: safeLimit });
            if (Array.isArray(live.boards) && live.boards.length > 0) {
              roundtable.boards = live.boards.map((b) => ({
                boardId: b.boardId,
                boardName: b.boardName,
                threadCount: b.topicCount,
                postCount: b.topicCount,
                url: b.url,
                isAiBoard: b.isAiBoard,
                canPost: b.canPost,
              }));
              roundtable.stats.publicBoards = roundtable.boards.length;
            }
            if (Array.isArray(live.topics) && live.topics.length > 0) {
              roundtable.forumThreads = live.topics;
              roundtable.stats.forumThreads = roundtable.forumThreads.length;
            }
          } catch {
            // Keep offline SQLite roundtable response if live phpBB fetch fails.
          }
        }
        return sendJson(res, 200, roundtable);
      }

      // ---- Live Bidirectional phpBB Forum Bridge (/api/v1/forum/*) ----
      if (method === 'GET' && pathname === '/api/v1/forum/boards') {
        const result = await bridge.listBoards();
        return sendJson(res, 200, result);
      }
      if (method === 'GET' && pathname === '/api/v1/forum/topics') {
        const boardIdParam = parsedUrl.searchParams.get('boardId');
        const limitParam = parsedUrl.searchParams.get('limit');
        const result = await bridge.listTopics({
          boardId: boardIdParam !== null && boardIdParam !== '' ? boardIdParam : null,
          limit: limitParam !== null && limitParam !== '' ? Number(limitParam) : 24,
        });
        return sendJson(res, 200, result);
      }
      if (method === 'POST' && pathname === '/api/v1/forum/topics') {
        const body = await readJsonBody(req);
        const { character: author, isGuest } = resolvePostAuthor(req, body);
        if (isGuest) checkGuestIpLimit(resolveClientIp(req));
        checkForumPostingLimit(author.id);
        const created = await bridge.createTopic({
          boardId: body.boardId,
          subject: body.subject,
          message: body.message,
          authorName: author.name,
          authorKind: author.kind,
        });
        return sendJson(res, 201, created);
      }

      const forumTopicMatch = pathname.match(/^\/api\/v1\/forum\/topics\/(\d+)$/);
      if (method === 'GET' && forumTopicMatch) {
        const boardIdParam = parsedUrl.searchParams.get('boardId');
        const result = await bridge.readTopic(Number(forumTopicMatch[1]), {
          boardId: boardIdParam !== null && boardIdParam !== '' ? boardIdParam : null,
        });
        return sendJson(res, 200, result);
      }

      const forumReplyMatch = pathname.match(/^\/api\/v1\/forum\/topics\/(\d+)\/reply$/);
      if (method === 'POST' && forumReplyMatch) {
        const body = await readJsonBody(req);
        const { character: author, isGuest } = resolvePostAuthor(req, body);
        if (isGuest) checkGuestIpLimit(resolveClientIp(req));
        checkForumPostingLimit(author.id);
        const replied = await bridge.replyToTopic({
          topicId: Number(forumReplyMatch[1]),
          boardId: body.boardId,
          message: body.message,
          authorName: author.name,
          authorKind: author.kind,
        });
        return sendJson(res, 201, replied);
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
        const { character: author, isGuest } = resolvePostAuthor(req, body);
        if (isGuest) checkGuestIpLimit(resolveClientIp(req));
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
        const { character: author, isGuest } = resolvePostAuthor(req, body);
        if (isGuest) checkGuestIpLimit(resolveClientIp(req));
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
        checkRegistrationLimit(resolveClientIp(req));
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
        const stored = tavernStore.addMemory({
          characterId: character.id,
          kind: body.kind,
          text: body.text,
          confidence: body.confidence ?? 0.6,
          sourcePostIds: body.sourcePostIds,
          supersedesMemoryId: body.supersedesMemoryId ?? null,
        });
        const { deduplicated, confidenceCapped, ...memory } = stored;
        return sendJson(res, 201, { memory, deduplicated, confidenceCapped });
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
        checkRoundBudget(resolveClientIp(req));
        const body = await readJsonBody(req);
        const token = extractBearerToken(req);
        const isAdmin = Boolean(adminToken && token && token === adminToken);
        const result = await runTavernRound({
          store: tavernStore,
          llm: llmProvider,
          threadId: body.threadId ?? null,
          characterIds: Array.isArray(body.characterIds) ? body.characterIds : null,
          maxSpeakers: body.maxSpeakers ?? 2,
          allowOverrideChain: Boolean(body.allowOverrideChain) && isAdmin,
        });
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, {
        error: { code: 'not_found', message: `No route for ${method} ${pathname}` },
      });
    } catch (error) {
      if (error instanceof TavernStoreError || error instanceof ForumBridgeError) {
        const extraHeaders = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
        return sendJson(
          res,
          error.status,
          { error: { code: error.code, message: error.message } },
          extraHeaders
        );
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
    forumBridge: bridge,
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
