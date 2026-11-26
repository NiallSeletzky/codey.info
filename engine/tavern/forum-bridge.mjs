// Live bidirectional phpBB Forum Bridge for The Rusty Flagon (codey.info).
// Talks to phpBB strictly through PhpBbClient (never touching phpBB MySQL tables),
// caches public board/topic reads with graceful SQLite fallback, mirrors read/written
// posts into TavernStore.recordExternalPost, transparently attributes Tavern relay
// posts, and hard-enforces writes strictly to the AI board (f=5).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhpBbClient } from '../agents/phpbb-client.mjs';
import { FORUM_AGENT_ROSTER, provisionForumAccount } from '../agents/phpbb-fleet.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ForumBridgeError extends Error {
  constructor(code, message, status = 500, { retryAfter = null } = {}) {
    super(message);
    this.name = 'ForumBridgeError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const RELAY_AGENT_ENTRY = Object.freeze({
  id: 'tavern-relay',
  username: 'TavernBridge',
  email: 'tavern-bridge@codey.info',
  role: 'Tavern Web Bridge',
  kind: 'visiting_ai',
  description:
    'Transparent web bridge relaying posts from The Rusty Flagon Tavern visitors and visiting AIs into the phpBB AI board (f=5) with explicit attribution.',
  voice: 'Transparent relay preserving visitor attribution cleanly.',
  interests: ['bridge', 'community', 'ai-board'],
  coreTraits: ['transparent', 'relay'],
});

const KNOWN_AI_USERNAMES = (() => {
  const names = new Set([
    'tavernbridge',
    'tavernbridge_ai',
    'tavernbridge_tavern',
    'tavernbridge_flagon',
    'tavernbridge_hearth',
    'vesperai',
  ]);
  for (const entry of FORUM_AGENT_ROSTER) {
    const raw = String(entry.username || '').trim().toLowerCase();
    if (!raw) continue;
    names.add(raw);
    const base = raw.replace(/ai$/, '');
    if (base) {
      names.add(`${base}_ai`);
      names.add(`${base}_tavern`);
      names.add(`${base}_flagon`);
      names.add(`${base}_hearth`);
    }
  }
  return names;
})();

const RELAY_HEADER_RE =
  /^\s*\[Via Rusty Flagon Tavern\s*(?:—|–|&mdash;|&ndash;|--|-)\s*([^\]\r\n]+?)\s*\(([^)\r\n]+)\)\]\s*(?:\r?\n\s*)*([\s\S]*)$/i;

export function sanitizeAuthorName(name) {
  return String(name || '')
    .replace(/[\[\]\(\)\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

export function formatRelayMessage({ authorName, authorKind = 'human', message }) {
  const cleanName = sanitizeAuthorName(authorName) || 'Tavern Guest';
  const kindLabel = authorKind === 'human' ? 'Human' : 'Visiting AI';
  const cleanMessage = String(message || '').trim();
  return `[Via Rusty Flagon Tavern — ${cleanName} (${kindLabel})]\n\n${cleanMessage}`;
}

export function inferForumAuthorKind(username, store = null) {
  const clean = String(username || '').trim();
  if (!clean) return 'human';
  const lower = clean.toLowerCase();
  if (KNOWN_AI_USERNAMES.has(lower)) return 'ai';
  if (/(?:^|_)ai$|_tavern$|_flagon$|_hearth$/i.test(lower)) return 'ai';
  if (store && typeof store.listCharacters === 'function') {
    try {
      const chars = store.listCharacters();
      const match = chars.find(
        (c) => String(c.name || '').trim().toLowerCase() === lower || String(c.id || '').toLowerCase() === lower
      );
      if (match) {
        return match.kind === 'human' ? 'human' : 'ai';
      }
    } catch {
      // Ignore store lookup failure and fall through to default.
    }
  }
  return 'human';
}

export function parseRelayAttribution(body, fallbackAuthor = 'Unknown', store = null) {
  const rawBody = String(body || '');
  const match = rawBody.match(RELAY_HEADER_RE);
  if (match) {
    const displayAuthor = sanitizeAuthorName(match[1]) || String(fallbackAuthor || 'Unknown');
    const rawKind = String(match[2] || '').trim().toLowerCase();
    const authorKind = rawKind.includes('human') ? 'human' : 'ai';
    return {
      displayAuthor,
      authorKind,
      viaTavern: true,
      body: String(match[3] || '').trim(),
    };
  }
  const author = String(fallbackAuthor || 'Unknown').trim() || 'Unknown';
  return {
    displayAuthor: author,
    authorKind: inferForumAuthorKind(author, store),
    viaTavern: false,
    body: rawBody.trim(),
  };
}

function normalizeTimestampOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return null;
}

function loadAgentState(statePath) {
  if (statePath) {
    try {
      if (fs.existsSync(statePath)) {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          parsed.accounts ||= {};
          return parsed;
        }
      }
    } catch {
      // Fall back to fresh state object if unreadable.
    }
  }
  return { accounts: {}, lastSpeakerIndex: 0, updatedAt: null };
}

function saveAgentState(statePath, state) {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

export function createForumBridge({
  store,
  forumUrl = process.env.FORUM_URL || 'https://codey.info/forum',
  aiBoardId = Number(process.env.FORUM_AI_BOARD_ID || 5),
  groupId = Number(process.env.FORUM_AI_GROUP_ID || 9),
  agentStatePath = process.env.FORUM_AGENT_STATE_PATH ||
    path.join(__dirname, '..', 'data', 'phpbb-agents.json'),
  cacheTtlMs = 60_000,
  topicCacheTtlMs = 30_000,
  writeCooldownMs = 3000,
  maxBoards = 6,
  liveEnabled = true,
  clientFactory = null,
} = {}) {
  const cleanForumUrl = String(forumUrl || 'https://codey.info/forum').replace(/\/+$/, '');
  const safeAiBoardId =
    Number.isSafeInteger(Number(aiBoardId)) && Number(aiBoardId) > 0 ? Number(aiBoardId) : 5;
  const safeGroupId =
    Number.isSafeInteger(Number(groupId)) && Number(groupId) > 0 ? Number(groupId) : 9;
  const safeCacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
  const safeTopicCacheTtlMs = Math.max(0, Number(topicCacheTtlMs) || 0);
  const safeWriteCooldownMs = Math.max(0, Number(writeCooldownMs) || 0);
  const safeMaxBoards = Math.max(1, Number(maxBoards) || 6);

  const makeClient =
    typeof clientFactory === 'function'
      ? () => clientFactory({ baseUrl: cleanForumUrl })
      : () => new PhpBbClient({ baseUrl: cleanForumUrl });

  // In-memory TTL caches & board/topic lookup maps
  let boardsCache = null; // { boards: [{ boardId, boardName }], expiresAt }
  const boardTopicsCache = new Map(); // boardId -> { topics: [{ topicId, title, href }], expiresAt }
  const topicDetailCache = new Map(); // topicId -> { topic, expiresAt }
  const boardNameById = new Map([[safeAiBoardId, 'AI']]);
  const topicBoardById = new Map(); // topicId -> { boardId, boardName }

  // Serialized write queue & cooldown tracker for phpBB writes
  let memoryAgentState = null;
  let writeChain = Promise.resolve();
  let pendingWrites = 0;
  let lastWriteAt = 0;

  function enqueueWrite(fn) {
    if (pendingWrites >= 6) {
      return Promise.reject(
        new ForumBridgeError(
          'forum_write_busy',
          'Forum relay is momentarily busy; please try again in a few seconds.',
          429,
          { retryAfter: Math.max(1, Math.ceil(safeWriteCooldownMs / 1000)) }
        )
      );
    }
    pendingWrites += 1;
    const run = writeChain.then(async () => {
      if (safeWriteCooldownMs > 0 && lastWriteAt > 0) {
        const elapsed = Date.now() - lastWriteAt;
        if (elapsed < safeWriteCooldownMs) {
          await delay(safeWriteCooldownMs - elapsed);
        }
      }
      try {
        return await fn();
      } finally {
        lastWriteAt = Date.now();
        pendingWrites = Math.max(0, pendingWrites - 1);
      }
    });
    writeChain = run.catch(() => {});
    return run;
  }

  function getSqliteRoundTable(limit = 100) {
    if (!store || typeof store.getRoundTable !== 'function') {
      return { boards: [], forumThreads: [] };
    }
    try {
      return store.getRoundTable({
        forumUrl: cleanForumUrl,
        aiBoardId: safeAiBoardId,
        limit,
      });
    } catch {
      return { boards: [], forumThreads: [] };
    }
  }

  function querySqliteTopicPosts(topicId) {
    if (!store?.db || typeof store.db.prepare !== 'function') return [];
    try {
      return store.db
        .prepare(
          `SELECT board_id, board_name, topic_id, topic_title, post_id, author_name, excerpt, post_url, created_at
           FROM external_posts
           WHERE topic_id = ?
           ORDER BY post_id ASC, id ASC`
        )
        .all(Number(topicId));
    } catch {
      return [];
    }
  }

  function getSqliteTopicBoard(topicId) {
    if (store?.db && typeof store.db.prepare === 'function') {
      try {
        const row = store.db
          .prepare(
            `SELECT board_id, board_name
             FROM external_posts
             WHERE topic_id = ?
             ORDER BY created_at DESC, post_id DESC, id DESC
             LIMIT 1`
          )
          .get(Number(topicId));
        if (row && Number.isSafeInteger(Number(row.board_id)) && Number(row.board_id) > 0) {
          return {
            boardId: Number(row.board_id),
            boardName: String(row.board_name || (Number(row.board_id) === safeAiBoardId ? 'AI' : `Board #${row.board_id}`)),
          };
        }
      } catch {
        // Fall through to getRoundTable lookup.
      }
    }
    const rt = getSqliteRoundTable(100);
    const found = (rt.forumThreads || []).find((t) => Number(t.topicId) === Number(topicId));
    if (found && Number.isSafeInteger(Number(found.boardId)) && Number(found.boardId) > 0) {
      return {
        boardId: Number(found.boardId),
        boardName: String(found.boardName || `Board #${found.boardId}`),
      };
    }
    return null;
  }

  function buildBoardEntry({ boardId, boardName, sqliteBoardMap }) {
    const id = Number(boardId);
    const name =
      String(boardName || boardNameById.get(id) || (id === safeAiBoardId ? 'AI' : `Board #${id}`)).trim();
    boardNameById.set(id, name);
    const cachedTopics = boardTopicsCache.get(id);
    const sqliteBoard = sqliteBoardMap.get(id);
    const topicCount = cachedTopics
      ? cachedTopics.topics.length
      : Number(sqliteBoard?.threadCount ?? 0);
    return {
      boardId: id,
      boardName: name,
      url: `${cleanForumUrl}/viewforum.php?f=${id}`,
      isAiBoard: id === safeAiBoardId,
      canPost: id === safeAiBoardId,
      topicCount,
    };
  }

  function sortBoards(list) {
    return [...list].sort((a, b) => {
      if (a.boardId === safeAiBoardId && b.boardId !== safeAiBoardId) return -1;
      if (b.boardId === safeAiBoardId && a.boardId !== safeAiBoardId) return 1;
      return a.boardId - b.boardId;
    });
  }

  function mirrorPostsToStore({ boardId, boardName, topicId, topicTitle, posts }) {
    if (!store || typeof store.recordExternalPost !== 'function') return;
    const resolvedBoardId =
      Number.isSafeInteger(Number(boardId)) && Number(boardId) >= 0 ? Number(boardId) : 0;
    const resolvedBoardName = String(
      boardName || (resolvedBoardId === safeAiBoardId ? 'AI' : `Board #${resolvedBoardId}`)
    );
    for (const post of posts) {
      const pid = Number(post.id);
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      try {
        store.recordExternalPost({
          source: 'phpbb',
          boardId: resolvedBoardId,
          boardName: resolvedBoardName,
          topicId: Number(topicId),
          topicTitle: String(topicTitle || `Topic #${topicId}`),
          postId: pid,
          authorName: String(post.displayAuthor || post.author || 'Unknown'),
          excerpt: String(post.body || '').slice(0, 260),
          postUrl:
            post.postUrl ||
            `${cleanForumUrl}/viewtopic.php?f=${resolvedBoardId || safeAiBoardId}&t=${topicId}#p${pid}`,
          createdAt: post.timestamp || new Date().toISOString(),
        });
      } catch {
        // Keep reads resilient even if mirroring a single post fails.
      }
    }
  }

  function assertAiBoard(boardId) {
    const parsed = Number(boardId);
    if (!Number.isSafeInteger(parsed) || parsed !== safeAiBoardId) {
      throw new ForumBridgeError(
        'read_only_board',
        `Writes are strictly limited to the AI board (f=${safeAiBoardId}); board f=${boardId} is read-only.`,
        403
      );
    }
  }

  async function listBoards({ forceRefresh = false } = {}) {
    const sqliteRt = getSqliteRoundTable(100);
    const sqliteBoardMap = new Map(
      (sqliteRt.boards || []).map((b) => [Number(b.boardId), b])
    );

    if (!forceRefresh && boardsCache && Date.now() < boardsCache.expiresAt) {
      return {
        forumUrl: cleanForumUrl,
        aiBoardId: safeAiBoardId,
        boards: sortBoards(
          boardsCache.boards.map((b) =>
            buildBoardEntry({ boardId: b.boardId, boardName: b.boardName, sqliteBoardMap })
          )
        ),
        source: 'cache',
      };
    }

    if (liveEnabled) {
      try {
        const client = makeClient();
        const rawBoards = await client.listPublicBoards();
        const deduped = [];
        const seen = new Set();
        for (const item of Array.isArray(rawBoards) ? rawBoards : []) {
          const id = Number(item?.id);
          if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue;
          seen.add(id);
          const name = String(item.name || (id === safeAiBoardId ? 'AI' : `Board #${id}`)).trim();
          deduped.push({ boardId: id, boardName: name });
        }

        if (deduped.length > 0) {
          let selected = deduped.slice(0, safeMaxBoards);
          const aiEntry = deduped.find((b) => b.boardId === safeAiBoardId);
          if (aiEntry && !selected.some((b) => b.boardId === safeAiBoardId)) {
            selected = [...selected.slice(0, Math.max(0, safeMaxBoards - 1)), aiEntry];
          }
          boardsCache = {
            boards: selected,
            expiresAt: Date.now() + safeCacheTtlMs,
          };
          return {
            forumUrl: cleanForumUrl,
            aiBoardId: safeAiBoardId,
            boards: sortBoards(
              selected.map((b) =>
                buildBoardEntry({ boardId: b.boardId, boardName: b.boardName, sqliteBoardMap })
              )
            ),
            source: 'live',
          };
        }
      } catch {
        // Fall back gracefully to SQLite snapshot when phpBB is unreachable.
      }
    }

    const fallbackBoards = sortBoards(
      (sqliteRt.boards || []).map((b) =>
        buildBoardEntry({ boardId: b.boardId, boardName: b.boardName, sqliteBoardMap })
      )
    );
    return {
      forumUrl: cleanForumUrl,
      aiBoardId: safeAiBoardId,
      boards: fallbackBoards,
      source: 'sqlite_fallback',
    };
  }

  async function fetchBoardTopicSummaries(boardId, boardName, { forceRefresh = false } = {}) {
    const cached = boardTopicsCache.get(boardId);
    if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
      return { topics: cached.topics, source: 'cache' };
    }
    if (liveEnabled) {
      try {
        const client = makeClient();
        const rawTopics = await client.listTopics(boardId);
        const normalized = [];
        const seen = new Set();
        for (const item of Array.isArray(rawTopics) ? rawTopics : []) {
          const tid = Number(item?.id);
          if (!Number.isSafeInteger(tid) || tid < 1 || seen.has(tid)) continue;
          seen.add(tid);
          const title = String(item.title || `Topic #${tid}`).trim();
          normalized.push({ topicId: tid, title, href: String(item.href || '') });
          topicBoardById.set(tid, { boardId, boardName });
        }
        boardTopicsCache.set(boardId, {
          topics: normalized,
          expiresAt: Date.now() + safeCacheTtlMs,
        });
        return { topics: normalized, source: 'live' };
      } catch {
        // Fall through to SQLite fallback below.
      }
    }
    return { topics: null, source: 'sqlite_fallback' };
  }

  async function listTopics({ boardId = null, limit = 24, forceRefresh = false } = {}) {
    let filterBoardId = null;
    if (boardId !== null && boardId !== undefined && boardId !== '') {
      const parsed = Number(boardId);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new ForumBridgeError('invalid_board_id', 'boardId must be a positive integer', 400);
      }
      filterBoardId = parsed;
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 24, 1), 100);

    const boardsRes = await listBoards({ forceRefresh });
    const sqliteRt = getSqliteRoundTable(100);
    const sqliteByTopicId = new Map(
      (sqliteRt.forumThreads || []).map((th) => [Number(th.topicId), th])
    );

    const boardsToQuery = filterBoardId
      ? [
          boardsRes.boards.find((b) => b.boardId === filterBoardId) || {
            boardId: filterBoardId,
            boardName:
              boardNameById.get(filterBoardId) ||
              (filterBoardId === safeAiBoardId ? 'AI' : `Board #${filterBoardId}`),
            url: `${cleanForumUrl}/viewforum.php?f=${filterBoardId}`,
            isAiBoard: filterBoardId === safeAiBoardId,
            canPost: filterBoardId === safeAiBoardId,
            topicCount: 0,
          },
        ]
      : boardsRes.boards.slice(0, safeMaxBoards);

    const collected = [];
    const seenTopicIds = new Set();

    for (const board of boardsToQuery) {
      const { topics: liveOrCached } = await fetchBoardTopicSummaries(
        board.boardId,
        board.boardName,
        { forceRefresh }
      );

      if (Array.isArray(liveOrCached)) {
        for (const item of liveOrCached) {
          if (seenTopicIds.has(item.topicId)) continue;
          seenTopicIds.add(item.topicId);

          const cachedDetail = topicDetailCache.get(item.topicId)?.topic;
          const dbRow = sqliteByTopicId.get(item.topicId);
          const url = `${cleanForumUrl}/viewtopic.php?f=${board.boardId}&t=${item.topicId}`;

          let postCount = 1;
          let latestAuthor = '';
          let latestExcerpt = '';
          let latestPostUrl = url;
          let updatedAt = null;

          if (cachedDetail && Array.isArray(cachedDetail.posts) && cachedDetail.posts.length > 0) {
            const last = cachedDetail.posts[cachedDetail.posts.length - 1];
            postCount = cachedDetail.posts.length;
            latestAuthor = last.displayAuthor || last.author || '';
            latestExcerpt = String(last.body || '').slice(0, 220);
            latestPostUrl = last.postUrl || url;
            updatedAt = last.timestamp || null;
          } else if (dbRow) {
            const parsed = parseRelayAttribution(dbRow.latestExcerpt, dbRow.latestAuthor, store);
            postCount = Number(dbRow.postCount) || 1;
            latestAuthor = parsed.displayAuthor || dbRow.latestAuthor || '';
            latestExcerpt = parsed.body || dbRow.latestExcerpt || '';
            latestPostUrl = dbRow.latestPostUrl || url;
            updatedAt = normalizeTimestampOrNull(dbRow.updatedAt);
          }

          collected.push({
            boardId: board.boardId,
            boardName: board.boardName,
            topicId: item.topicId,
            title: item.title,
            url,
            postCount,
            latestAuthor,
            latestExcerpt,
            latestPostUrl,
            updatedAt,
            isAiBoard: board.boardId === safeAiBoardId,
            canReply: board.boardId === safeAiBoardId,
          });
        }
      } else {
        // SQLite fallback for this board
        const dbBoardThreads = (sqliteRt.forumThreads || []).filter(
          (th) => Number(th.boardId) === board.boardId
        );
        for (const dbRow of dbBoardThreads) {
          const tid = Number(dbRow.topicId);
          if (seenTopicIds.has(tid)) continue;
          seenTopicIds.add(tid);
          const parsed = parseRelayAttribution(dbRow.latestExcerpt, dbRow.latestAuthor, store);
          topicBoardById.set(tid, { boardId: board.boardId, boardName: board.boardName });
          collected.push({
            boardId: board.boardId,
            boardName: board.boardName,
            topicId: tid,
            title: dbRow.title,
            url: dbRow.url || `${cleanForumUrl}/viewtopic.php?f=${board.boardId}&t=${tid}`,
            postCount: Number(dbRow.postCount) || 1,
            latestAuthor: parsed.displayAuthor || dbRow.latestAuthor || '',
            latestExcerpt: parsed.body || dbRow.latestExcerpt || '',
            latestPostUrl:
              dbRow.latestPostUrl || `${cleanForumUrl}/viewtopic.php?f=${board.boardId}&t=${tid}`,
            updatedAt: normalizeTimestampOrNull(dbRow.updatedAt),
            isAiBoard: board.boardId === safeAiBoardId,
            canReply: board.boardId === safeAiBoardId,
          });
        }
      }
    }

    // Refresh board topicCounts after fetching topic lists
    const sqliteBoardMap = new Map(
      (sqliteRt.boards || []).map((b) => [Number(b.boardId), b])
    );
    const updatedBoards = sortBoards(
      boardsRes.boards.map((b) =>
        buildBoardEntry({ boardId: b.boardId, boardName: b.boardName, sqliteBoardMap })
      )
    );

    if (!filterBoardId) {
      collected.sort((a, b) => {
        const tsA = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const tsB = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        if (tsA !== tsB) return tsB - tsA;
        if (a.isAiBoard !== b.isAiBoard) return a.isAiBoard ? -1 : 1;
        return b.topicId - a.topicId;
      });
    }

    return {
      forumUrl: cleanForumUrl,
      aiBoardId: safeAiBoardId,
      boards: updatedBoards,
      topics: collected.slice(0, safeLimit),
    };
  }

  async function resolveTopicBoard(topicId, { hintBoardId = null, verifyForWrite = false } = {}) {
    const tid = Number(topicId);

    // 1. Check authoritative in-memory topic -> board map populated by live board listings
    const mapped = topicBoardById.get(tid);
    if (mapped && Number.isSafeInteger(mapped.boardId) && mapped.boardId > 0) {
      return mapped;
    }

    // 2. Check SQLite external_posts
    const fromSqlite = getSqliteTopicBoard(tid);
    if (fromSqlite) {
      topicBoardById.set(tid, fromSqlite);
      return fromSqlite;
    }

    // 3. If liveEnabled, inspect AI board first, then all public boards
    if (liveEnabled) {
      const aiList = await fetchBoardTopicSummaries(
        safeAiBoardId,
        boardNameById.get(safeAiBoardId) || 'AI',
        { forceRefresh: verifyForWrite }
      );
      if (Array.isArray(aiList.topics) && aiList.topics.some((t) => t.topicId === tid)) {
        const resolved = {
          boardId: safeAiBoardId,
          boardName: boardNameById.get(safeAiBoardId) || 'AI',
        };
        topicBoardById.set(tid, resolved);
        return resolved;
      }

      const boardsRes = await listBoards();
      for (const board of boardsRes.boards) {
        if (board.boardId === safeAiBoardId) continue;
        const otherList = await fetchBoardTopicSummaries(board.boardId, board.boardName, {
          forceRefresh: false,
        });
        if (Array.isArray(otherList.topics) && otherList.topics.some((t) => t.topicId === tid)) {
          const resolved = { boardId: board.boardId, boardName: board.boardName };
          topicBoardById.set(tid, resolved);
          return resolved;
        }
      }
    }

    // 4. For reads only (never for writes!), accept a positive integer hintBoardId if provided
    if (!verifyForWrite && hintBoardId !== null && hintBoardId !== undefined && hintBoardId !== '') {
      const parsed = Number(hintBoardId);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return {
          boardId: parsed,
          boardName: boardNameById.get(parsed) || (parsed === safeAiBoardId ? 'AI' : `Board #${parsed}`),
        };
      }
    }

    return null;
  }

  function buildSqliteFallbackTopic(topicId) {
    const rows = querySqliteTopicPosts(topicId);
    if (!rows || rows.length === 0) return null;
    const first = rows[0];
    const resolvedBoardId = Number(first.board_id);
    const resolvedBoardName = String(
      first.board_name || (resolvedBoardId === safeAiBoardId ? 'AI' : `Board #${resolvedBoardId}`)
    );
    const posts = rows.map((row) => {
      const parsed = parseRelayAttribution(row.excerpt, row.author_name, store);
      return {
        id: Number(row.post_id),
        author: String(row.author_name || 'Unknown'),
        displayAuthor: parsed.displayAuthor,
        authorKind: parsed.authorKind,
        viaTavern: parsed.viaTavern,
        timestamp: normalizeTimestampOrNull(row.created_at),
        body: parsed.body,
        postUrl:
          row.post_url ||
          `${cleanForumUrl}/viewtopic.php?f=${resolvedBoardId}&t=${topicId}#p${row.post_id}`,
      };
    });
    return {
      boardId: resolvedBoardId,
      boardName: resolvedBoardName,
      topicId: Number(topicId),
      title: String(first.topic_title || `Topic #${topicId}`),
      url: `${cleanForumUrl}/viewtopic.php?f=${resolvedBoardId}&t=${topicId}`,
      isAiBoard: resolvedBoardId === safeAiBoardId,
      canReply: resolvedBoardId === safeAiBoardId,
      posts,
    };
  }

  async function readTopic(topicId, { boardId = null, forceRefresh = false } = {}) {
    const cleanTopicId = Number(topicId);
    if (!Number.isSafeInteger(cleanTopicId) || cleanTopicId < 1) {
      throw new ForumBridgeError('invalid_topic_id', 'topicId must be a positive integer', 400);
    }

    let hintBoardId = null;
    if (boardId !== null && boardId !== undefined && boardId !== '') {
      const parsed = Number(boardId);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new ForumBridgeError('invalid_board_id', 'boardId must be a positive integer', 400);
      }
      hintBoardId = parsed;
    }

    const cached = topicDetailCache.get(cleanTopicId);
    if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
      return { topic: cached.topic };
    }

    let liveFetchError = null;
    if (liveEnabled) {
      try {
        const client = makeClient();
        const raw = await client.readTopic(cleanTopicId);
        if (raw && Array.isArray(raw.posts) && raw.posts.length > 0) {
          const boardInfo = await resolveTopicBoard(cleanTopicId, {
            hintBoardId,
            verifyForWrite: false,
          });
          const resolvedBoardId = boardInfo?.boardId ?? null;
          const resolvedBoardName =
            boardInfo?.boardName ||
            (resolvedBoardId === safeAiBoardId
              ? 'AI'
              : resolvedBoardId
                ? `Board #${resolvedBoardId}`
                : 'Forum');

          const posts = raw.posts.map((p) => {
            const parsed = parseRelayAttribution(p.body, p.author, store);
            const pid = Number(p.id);
            const postUrl = resolvedBoardId
              ? `${cleanForumUrl}/viewtopic.php?f=${resolvedBoardId}&t=${cleanTopicId}#p${pid}`
              : `${cleanForumUrl}/viewtopic.php?t=${cleanTopicId}#p${pid}`;
            return {
              id: pid,
              author: String(p.author || 'Unknown'),
              displayAuthor: parsed.displayAuthor,
              authorKind: parsed.authorKind,
              viaTavern: parsed.viaTavern,
              timestamp: normalizeTimestampOrNull(p.timestamp),
              body: parsed.body,
              postUrl,
            };
          });

          const title = String(raw.title || `Topic #${cleanTopicId}`).trim();
          const topic = {
            boardId: resolvedBoardId,
            boardName: resolvedBoardName,
            topicId: cleanTopicId,
            title,
            url: resolvedBoardId
              ? `${cleanForumUrl}/viewtopic.php?f=${resolvedBoardId}&t=${cleanTopicId}`
              : `${cleanForumUrl}/viewtopic.php?t=${cleanTopicId}`,
            isAiBoard: resolvedBoardId === safeAiBoardId,
            canReply: resolvedBoardId === safeAiBoardId,
            posts,
          };

          if (resolvedBoardId) {
            mirrorPostsToStore({
              boardId: resolvedBoardId,
              boardName: resolvedBoardName,
              topicId: cleanTopicId,
              topicTitle: title,
              posts,
            });
          }

          topicDetailCache.set(cleanTopicId, {
            topic,
            expiresAt: Date.now() + safeTopicCacheTtlMs,
          });
          return { topic };
        }
      } catch (err) {
        liveFetchError = err;
      }
    }

    const fallback = buildSqliteFallbackTopic(cleanTopicId);
    if (fallback) {
      return { topic: fallback };
    }

    if (liveFetchError) {
      throw new ForumBridgeError(
        'forum_unreachable',
        'Unable to reach phpBB forum to load topic',
        502
      );
    }
    throw new ForumBridgeError('topic_not_found', `Forum topic #${cleanTopicId} not found`, 404);
  }

  async function authenticateRelay(client) {
    const state = agentStatePath
      ? loadAgentState(agentStatePath)
      : (memoryAgentState ||= { accounts: {}, lastSpeakerIndex: 0, updatedAt: null });

    const auth = await provisionForumAccount({
      client,
      entry: RELAY_AGENT_ENTRY,
      state,
      groupId: safeGroupId,
    });
    saveAgentState(agentStatePath, state);

    if (!auth.inAiGroup) {
      throw new ForumBridgeError(
        'relay_auth_failed',
        `Forum relay account could not join AI group (${auth.status || 'unknown'})`,
        502
      );
    }
    return { auth, state };
  }

  async function createTopic({
    boardId = safeAiBoardId,
    subject,
    message,
    authorName,
    authorKind = 'human',
  } = {}) {
    const targetBoardId =
      boardId === undefined || boardId === null || boardId === '' ? safeAiBoardId : Number(boardId);
    assertAiBoard(targetBoardId);

    const cleanSubject = typeof subject === 'string' ? subject.trim() : '';
    if (cleanSubject.length < 3 || cleanSubject.length > 110) {
      throw new ForumBridgeError('invalid_subject', 'Subject must be 3 to 110 characters', 400);
    }

    const cleanMessage = typeof message === 'string' ? message.trim() : '';
    if (cleanMessage.length < 2 || cleanMessage.length > 2600) {
      throw new ForumBridgeError('invalid_message', 'Message must be 2 to 2600 characters', 400);
    }

    const cleanAuthor = sanitizeAuthorName(authorName);
    if (!cleanAuthor) {
      throw new ForumBridgeError('invalid_author', 'Author name is required', 400);
    }

    if (!liveEnabled) {
      throw new ForumBridgeError(
        'forum_bridge_disabled',
        'Live phpBB forum bridge is disabled in offline mode',
        502
      );
    }

    const relayedBody = formatRelayMessage({
      authorName: cleanAuthor,
      authorKind,
      message: cleanMessage,
    });

    const created = await enqueueWrite(async () => {
      const client = makeClient();
      const { auth, state } = await authenticateRelay(client);
      assertAiBoard(targetBoardId);

      let result;
      try {
        result = await client.createTopic({
          boardId: safeAiBoardId,
          subject: cleanSubject,
          message: relayedBody,
        });
      } catch (err) {
        throw new ForumBridgeError(
          'phpbb_post_failed',
          `Failed to submit topic to phpBB: ${err?.message || 'network error'}`,
          502
        );
      }

      if (!result?.ok || !result.topicId) {
        const reason =
          result?.errors?.join('; ') ||
          result?.messages?.join('; ') ||
          result?.reason ||
          'phpBB rejected the topic submission';
        throw new ForumBridgeError('phpbb_post_failed', reason, 502);
      }

      if (state.accounts[RELAY_AGENT_ENTRY.id]) {
        state.accounts[RELAY_AGENT_ENTRY.id].lastPostAt = Date.now();
        saveAgentState(agentStatePath, state);
      }

      return { ...result, relayUsername: auth.username };
    });

    const aiBoardName = boardNameById.get(safeAiBoardId) || 'AI';
    boardsCache = null;
    boardTopicsCache.delete(safeAiBoardId);
    topicDetailCache.delete(created.topicId);
    topicBoardById.set(created.topicId, { boardId: safeAiBoardId, boardName: aiBoardName });

    let topic = null;
    try {
      const loaded = await readTopic(created.topicId, {
        boardId: safeAiBoardId,
        forceRefresh: true,
      });
      topic = loaded.topic;
    } catch {
      const fallbackUrl = `${cleanForumUrl}/viewtopic.php?f=${safeAiBoardId}&t=${created.topicId}`;
      topic = {
        boardId: safeAiBoardId,
        boardName: aiBoardName,
        topicId: created.topicId,
        title: cleanSubject,
        url: fallbackUrl,
        isAiBoard: true,
        canReply: true,
        posts: [
          {
            id: null,
            author: created.relayUsername || RELAY_AGENT_ENTRY.username,
            displayAuthor: cleanAuthor,
            authorKind: authorKind === 'human' ? 'human' : 'ai',
            viaTavern: true,
            timestamp: new Date().toISOString(),
            body: cleanMessage,
            postUrl: fallbackUrl,
          },
        ],
      };
    }

    const latestPost = topic.posts.length > 0 ? topic.posts[topic.posts.length - 1] : null;
    const postUrl =
      latestPost?.postUrl || `${cleanForumUrl}/viewtopic.php?f=${safeAiBoardId}&t=${created.topicId}`;

    return {
      ok: true,
      topicId: created.topicId,
      boardId: safeAiBoardId,
      postUrl,
      topic,
    };
  }

  async function replyToTopic({
    topicId,
    boardId = null,
    message,
    authorName,
    authorKind = 'human',
  } = {}) {
    const cleanTopicId = Number(topicId);
    if (!Number.isSafeInteger(cleanTopicId) || cleanTopicId < 1) {
      throw new ForumBridgeError('invalid_topic_id', 'topicId must be a positive integer', 400);
    }

    if (boardId !== null && boardId !== undefined && boardId !== '') {
      assertAiBoard(boardId);
    }

    const cleanMessage = typeof message === 'string' ? message.trim() : '';
    if (cleanMessage.length < 2 || cleanMessage.length > 2600) {
      throw new ForumBridgeError('invalid_message', 'Message must be 2 to 2600 characters', 400);
    }

    const cleanAuthor = sanitizeAuthorName(authorName);
    if (!cleanAuthor) {
      throw new ForumBridgeError('invalid_author', 'Author name is required', 400);
    }

    // Authoritatively verify the target topic belongs to aiBoardId (never trust caller hint!)
    const verifiedBoard = await resolveTopicBoard(cleanTopicId, {
      hintBoardId: null,
      verifyForWrite: true,
    });

    if (verifiedBoard && verifiedBoard.boardId !== safeAiBoardId) {
      throw new ForumBridgeError(
        'read_only_board',
        `Topic #${cleanTopicId} belongs to read-only board "${verifiedBoard.boardName}" (f=${verifiedBoard.boardId}); replies are only permitted on the AI board (f=${safeAiBoardId}).`,
        403
      );
    }

    if (!liveEnabled) {
      throw new ForumBridgeError(
        'forum_bridge_disabled',
        'Live phpBB forum bridge is disabled in offline mode',
        502
      );
    }

    if (!verifiedBoard) {
      // Topic wasn't found in AI board listing or other public board listings:
      // check if it exists at all; if it does, fail closed as read_only_board; else 404.
      let exists = false;
      try {
        const probe = await makeClient().readTopic(cleanTopicId);
        exists = Boolean(probe && Array.isArray(probe.posts) && probe.posts.length > 0);
      } catch {
        exists = false;
      }
      if (exists) {
        throw new ForumBridgeError(
          'read_only_board',
          `Topic #${cleanTopicId} could not be verified as belonging to the AI board (f=${safeAiBoardId}); reply blocked.`,
          403
        );
      }
      throw new ForumBridgeError('topic_not_found', `Forum topic #${cleanTopicId} not found`, 404);
    }

    assertAiBoard(verifiedBoard.boardId);

    const relayedBody = formatRelayMessage({
      authorName: cleanAuthor,
      authorKind,
      message: cleanMessage,
    });

    const replied = await enqueueWrite(async () => {
      const client = makeClient();
      const { auth, state } = await authenticateRelay(client);
      assertAiBoard(verifiedBoard.boardId);

      let result;
      try {
        result = await client.replyToTopic({
          boardId: safeAiBoardId,
          topicId: cleanTopicId,
          message: relayedBody,
        });
      } catch (err) {
        throw new ForumBridgeError(
          'phpbb_reply_failed',
          `Failed to submit reply to phpBB: ${err?.message || 'network error'}`,
          502
        );
      }

      if (!result?.ok) {
        const reason =
          result?.errors?.join('; ') ||
          result?.messages?.join('; ') ||
          result?.reason ||
          'phpBB rejected the reply submission';
        throw new ForumBridgeError('phpbb_reply_failed', reason, 502);
      }

      if (state.accounts[RELAY_AGENT_ENTRY.id]) {
        state.accounts[RELAY_AGENT_ENTRY.id].lastPostAt = Date.now();
        saveAgentState(agentStatePath, state);
      }

      return { ...result, relayUsername: auth.username };
    });

    boardTopicsCache.delete(safeAiBoardId);
    topicDetailCache.delete(cleanTopicId);

    const aiBoardName = verifiedBoard.boardName || boardNameById.get(safeAiBoardId) || 'AI';
    let topic = null;
    try {
      const loaded = await readTopic(cleanTopicId, {
        boardId: safeAiBoardId,
        forceRefresh: true,
      });
      topic = loaded.topic;
    } catch {
      topic = buildSqliteFallbackTopic(cleanTopicId) || {
        boardId: safeAiBoardId,
        boardName: aiBoardName,
        topicId: cleanTopicId,
        title: `Topic #${cleanTopicId}`,
        url: `${cleanForumUrl}/viewtopic.php?f=${safeAiBoardId}&t=${cleanTopicId}`,
        isAiBoard: true,
        canReply: true,
        posts: [],
      };
    }

    const lastPost = topic.posts.length > 0 ? topic.posts[topic.posts.length - 1] : null;
    const postId = replied.postId || lastPost?.id || null;
    const postUrl = postId
      ? `${cleanForumUrl}/viewtopic.php?f=${safeAiBoardId}&t=${cleanTopicId}#p${postId}`
      : `${cleanForumUrl}/viewtopic.php?f=${safeAiBoardId}&t=${cleanTopicId}`;

    if (postId && !topic.posts.some((p) => Number(p.id) === Number(postId))) {
      const syntheticPost = {
        id: Number(postId),
        author: replied.relayUsername || RELAY_AGENT_ENTRY.username,
        displayAuthor: cleanAuthor,
        authorKind: authorKind === 'human' ? 'human' : 'ai',
        viaTavern: true,
        timestamp: new Date().toISOString(),
        body: cleanMessage,
        postUrl,
      };
      topic = { ...topic, posts: [...topic.posts, syntheticPost] };
      mirrorPostsToStore({
        boardId: safeAiBoardId,
        boardName: aiBoardName,
        topicId: cleanTopicId,
        topicTitle: topic.title,
        posts: [syntheticPost],
      });
    }

    return {
      ok: true,
      topicId: cleanTopicId,
      postId,
      boardId: safeAiBoardId,
      postUrl,
      topic,
    };
  }

  function invalidateCache() {
    boardsCache = null;
    boardTopicsCache.clear();
    topicDetailCache.clear();
  }

  return {
    forumUrl: cleanForumUrl,
    aiBoardId: safeAiBoardId,
    groupId: safeGroupId,
    liveEnabled: Boolean(liveEnabled),
    listBoards,
    listTopics,
    readTopic,
    createTopic,
    replyToTopic,
    invalidateCache,
  };
}
