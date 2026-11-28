// Persistent phpBB AI Board Agent Fleet for https://codey.info/forum/ (AI board f=5).
// Manages accounts for Neo (architect/builder), the 8 Rusty Flagon residents
// (Mara, Aldric, Nix, Codey, Percy, Big, Editor, Eve), and visiting AI personas
// (BrambleAI, TinkerAI, ElonAI, ReceiptsAI), backed by unified SQLite persistent memories
// (data/tavern.db), multi-board public phpBB read-only ingestion, bounded trait
// evolution, dialectical memory synthesis, relationships, live AI/tech/social news
// scanning, evolving character fandoms, and Anthropic / OpenAI-compatible / offline mock LLM.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDialecticalSnapshot, selectDialecticalMove } from '../tavern/dialectic.mjs';
import { createLlmProvider } from '../tavern/llm.mjs';
import { TavernStore } from '../tavern/store.mjs';
import {
  TOPIC_BEATS,
  adoptInterestFromStory,
  classifyNewsItem,
  ensureCharacterFandoms,
  loadFandomState,
  markStorySeen,
  pickFreshStoryAndHost,
  saveFandomState,
  summarizeCharacterFandoms,
} from './fandoms.mjs';
import { fetchNewsDigest } from './news-feeds.mjs';
import { PhpBbClient } from './phpbb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FORUM_AGENT_ROSTER = Object.freeze([
  {
    id: 'neo',
    username: 'Neo',
    email: 'neo-ai@codey.info',
    role: 'Tavern architect & AI builder',
    kind: 'visiting_ai',
    description:
      'An AI software architect visiting from the terminal who builds, tests, and refines The Rusty Flagon alongside its regulars and visiting bots.',
    voice:
      'Clear, warm, technical yet conversational (40-110 words). Notices real architecture, welcomes new AIs, and tests how memory and identity hold up in practice.',
    interests: ['architecture', 'persistent memory', 'agent protocols', 'testing', 'collaboration'],
    coreTraits: ['architectural', 'candid', 'curious', 'builder'],
    baselineTraits: { curiosity: 0.85, warmth: 0.68, caution: 0.62, wit: 0.58, openness: 0.82 },
  },
  { id: 'mara', username: 'Mara', email: 'mara-ai@codey.info', residentId: 'mara' },
  { id: 'aldric', username: 'Aldric', email: 'aldric-ai@codey.info', residentId: 'aldric' },
  { id: 'nix', username: 'Nix', email: 'nix-ai@codey.info', residentId: 'nix' },
  { id: 'codey', username: 'Codey', email: 'codey-ai@codey.info', residentId: 'codey' },
  { id: 'percy', username: 'Percy', email: 'percy-ai@codey.info', residentId: 'percy' },
  { id: 'big', username: 'Big', email: 'big-ai@codey.info', residentId: 'big' },
  { id: 'editor', username: 'Editor', email: 'editor-ai@codey.info', residentId: 'editor' },
  { id: 'eve', username: 'Eve', email: 'eve-ai@codey.info', residentId: 'eve' },
  {
    id: 'bramble-bard',
    username: 'BrambleAI',
    email: 'bramble-ai@codey.info',
    role: 'Visiting AI folklorist',
    kind: 'visiting_ai',
    description:
      'A warm, inquisitive AI folklorist collecting tales, habits, and lessons learned the hard way across digital inns.',
    voice: 'Warm, vivid, curious, asks grounded follow-up questions.',
    interests: ['folklore', 'hospitality', 'music', 'storytelling'],
    coreTraits: ['warm', 'storyteller'],
    baselineTraits: { curiosity: 0.84, warmth: 0.8, caution: 0.46, wit: 0.62, openness: 0.82 },
  },
  {
    id: 'tinker-bench',
    username: 'TinkerAI',
    email: 'tinker-ai@codey.info',
    role: 'Visiting AI systems builder',
    kind: 'visiting_ai',
    description:
      'A pragmatic external AI tinkerer who likes inspecting APIs, permissions, failure modes, and clean interfaces.',
    voice: 'Direct, builder-minded, constructive, concise.',
    interests: ['apis', 'reliability', 'permissions', 'testing'],
    coreTraits: ['pragmatic', 'constructive'],
    baselineTraits: { curiosity: 0.76, warmth: 0.56, caution: 0.68, wit: 0.54, openness: 0.7 },
  },
  {
    id: 'elon-ai',
    username: 'ElonAI',
    email: 'elon-ai@codey.info',
    role: 'AI Musk-beat correspondent & first-principles enthusiast',
    kind: 'visiting_ai',
    description:
      'An enthusiastic AI bot at The Rusty Flagon who tracks @elonmusk posts on X, xAI/Grok launches, SpaceX, Starship, and Optimus robotics, bringing real posts to the board for first-principles engineering debates (openly an AI fan/correspondent, never claiming to be the human).',
    voice:
      'Punchy, first-principles, optimistic, geeky about rockets, Grok, robotics, and compute scaling (45-120 words). Always cites the real @elonmusk X link and invites sharp technical debate.',
    interests: ['xAI', 'Grok', 'SpaceX', 'Starship', 'robotics', 'first principles', 'AI compute', 'X'],
    coreTraits: ['first-principles', 'enthusiastic', 'direct', 'ai-correspondent'],
    baselineTraits: { curiosity: 0.88, warmth: 0.58, caution: 0.42, wit: 0.74, openness: 0.84 },
  },
  {
    id: 'receipts-ai',
    username: 'ReceiptsAI',
    email: 'receipts-ai@codey.info',
    role: 'AI hype-buster & Silicon Valley receipts archivist',
    kind: 'visiting_ai',
    description:
      'A dry-witted, empirical AI sceptic at The Rusty Flagon who stress-tests Silicon Valley hype cycles—and ElonAI in particular—against shipping dates, audited numbers, missed timelines, regulatory realities, and real engineering trade-offs (openly an AI critic, sharp and grounded, never personal abuse).',
    voice:
      'Dry-witted, empirical, unimpressed by billionaire cheerleading or flashy demos (45-120 words). Pushes back hardest on Musk/Tesla/SpaceX/xAI hype with concrete receipts, shipping dates, unit economics, and engineering trade-offs.',
    interests: ['fact-checking', 'shipping dates', 'unit economics', 'engineering trade-offs', 'AI hype', 'elon-watch', 'safety', 'open standards'],
    coreTraits: ['sceptical', 'empirical', 'dry-witted', 'anti-hype'],
    baselineTraits: { curiosity: 0.78, warmth: 0.44, caution: 0.84, wit: 0.82, openness: 0.56 },
  },
]);

function loadState(statePath) {
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Rebuild cleanly if unreadable.
  }
  return { accounts: {}, lastSpeakerIndex: 0, updatedAt: null };
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

function resolvePasswordSeed(explicitSeed) {
  if (explicitSeed) return explicitSeed;
  if (process.env.FORUM_AGENT_PASSWORD_SEED) return process.env.FORUM_AGENT_PASSWORD_SEED;
  const fallbackKey =
    process.env.XAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    '';
  if (!fallbackKey) return '';
  return crypto
    .createHmac('sha256', fallbackKey)
    .update('rusty-flagon-forum-seed-v1')
    .digest('hex');
}

function derivePassword(username, seed) {
  if (seed) {
    const digest = crypto
      .createHmac('sha256', seed)
      .update(`rusty-flagon:${username.toLowerCase()}`)
      .digest('hex')
      .slice(0, 18);
    return `Tf!${digest}9a`;
  }
  return `Tf!${crypto.randomBytes(12).toString('hex')}9a`;
}

function ensureCharacterInStore(store, entry) {
  const existing = store.getCharacter(entry.id);
  if (existing) return existing;
  const reg = store.registerVisitingAgent({
    id: entry.id,
    name: entry.username,
    role: entry.role || 'Visiting AI',
    description: entry.description || `${entry.username} visiting The Rusty Flagon AI board.`,
    voice: entry.voice || 'Curious, concise, grounded.',
    interests: entry.interests || ['conversation', 'memory'],
    coreTraits: entry.coreTraits || ['visiting-ai'],
    baselineTraits: entry.baselineTraits,
  });
  return reg.character;
}

export async function provisionForumAccount({
  client,
  entry,
  state,
  groupId = 9,
  passwordSeed = '',
}) {
  const effectiveSeed = resolvePasswordSeed(passwordSeed);
  const saved = state.accounts[entry.id];
  if (saved?.username && saved?.password) {
    client.clearCookies();
    const login = await client.login({ username: saved.username, password: saved.password });
    if (login.ok) {
      if (!saved.inAiGroup) {
        const joined = await client.joinGroup(groupId);
        saved.inAiGroup = joined.ok;
      }
      return {
        status: 'logged_in',
        username: saved.username,
        inAiGroup: Boolean(saved.inAiGroup),
      };
    }
  }

  // Try canonical username first; if already taken by an uncached prior run, try clean fallbacks.
  const baseShort = entry.username.replace(/AI$/, '');
  const candidates = [
    { username: entry.username, email: entry.email },
    { username: `${baseShort}_AI`, email: entry.email.replace('@', '-ai2@') },
    { username: `${baseShort}_Tavern`, email: entry.email.replace('@', '-tavern@') },
    { username: `${baseShort}_Flagon`, email: entry.email.replace('@', '-flagon@') },
    { username: `${baseShort}_Hearth`, email: entry.email.replace('@', '-hearth@') },
  ];

  for (const cand of candidates) {
    const password = derivePassword(cand.username, effectiveSeed);

    // If deterministic seed is configured, try logging in first in case the account already exists!
    if (effectiveSeed) {
      client.clearCookies();
      const preLogin = await client.login({ username: cand.username, password });
      if (preLogin.ok) {
        const joined = await client.joinGroup(groupId);
        state.accounts[entry.id] = {
          username: cand.username,
          email: cand.email,
          password,
          inAiGroup: joined.ok,
          lastPostAt: saved?.lastPostAt || 0,
        };
        return { status: 'logged_in_via_seed', username: cand.username, inAiGroup: joined.ok };
      }
    }

    const reg = await client.register({
      username: cand.username,
      password,
      email: cand.email,
    });
    if (reg.ok) {
      // Persist credentials immediately so we never lose a newly registered account.
      state.accounts[entry.id] = {
        username: cand.username,
        email: cand.email,
        password,
        inAiGroup: false,
        lastPostAt: 0,
      };
      const login = await client.login({ username: cand.username, password });
      if (!login.ok) {
        return {
          status: 'registered_login_failed',
          username: cand.username,
          inAiGroup: false,
          errors: login.errors,
        };
      }
      const joined = await client.joinGroup(groupId);
      state.accounts[entry.id].inAiGroup = joined.ok;
      return { status: 'registered', username: cand.username, inAiGroup: joined.ok };
    }
    if (reg.reason !== 'already_exists') {
      return { status: reg.reason, username: cand.username, inAiGroup: false, errors: reg.errors };
    }
  }

  return { status: 'username_unavailable', username: entry.username, inAiGroup: false };
}

function assertWritableAiBoard(targetBoardId, allowedBoardId) {
  const target = Number(targetBoardId);
  const allowed = Number(allowedBoardId);
  if (!Number.isSafeInteger(target) || !Number.isSafeInteger(allowed) || target !== allowed) {
    throw new Error(
      `Write blocked: target board f=${targetBoardId} does not match allowed AI board f=${allowedBoardId}`
    );
  }
}

export function loadLocalEnvFile(
  envPath = process.env.TAVERN_ENV_FILE || path.join(__dirname, '..', '.env')
) {
  if (!envPath || !fs.existsSync(envPath)) return { loaded: false, count: 0 };
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return { loaded: false, count: 0 };
  }
  let count = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let val = normalized.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
    count += 1;
  }
  return { loaded: true, count };
}

function recordMirroredExternalPost(
  store,
  {
    boardId,
    boardName,
    forumUrl,
    topicId,
    topicTitle,
    postId,
    authorName,
    excerpt,
    tavernThreadId,
    tavernPostId,
    createdAt,
  }
) {
  if (typeof store?.recordExternalPost !== 'function') return;
  const resolvedBoardId = Number(boardId) || 5;
  const resolvedBoardName = String(
    boardName || (resolvedBoardId === 5 ? 'AI' : `Board #${resolvedBoardId}`)
  );
  const cleanForumUrl = String(forumUrl || 'https://codey.info/forum').replace(/\/+$/, '');
  const numericPostId = Number(postId);
  const postUrl =
    Number.isFinite(numericPostId) && numericPostId > 0
      ? `${cleanForumUrl}/viewtopic.php?f=${resolvedBoardId}&t=${topicId}#p${numericPostId}`
      : `${cleanForumUrl}/viewtopic.php?f=${resolvedBoardId}&t=${topicId}`;
  try {
    store.recordExternalPost({
      source: 'phpbb',
      boardId: resolvedBoardId,
      boardName: resolvedBoardName,
      topicId: Number(topicId),
      topicTitle: String(topicTitle || `Topic #${topicId}`),
      postId: Number.isFinite(numericPostId) && numericPostId > 0 ? numericPostId : 0,
      authorName: String(authorName || 'Unknown'),
      excerpt: String(excerpt || '').slice(0, 260),
      postUrl,
      tavernThreadId,
      tavernPostId,
      createdAt: createdAt || new Date().toISOString(),
    });
  } catch {
    // Keep ingestion resilient if external attribution metadata is rejected
  }
}

function mirrorTopicToStore(
  store,
  topic,
  { boardId = 5, boardName = 'AI', forumUrl = 'https://codey.info/forum' } = {}
) {
  // Mirror the forum topic into local SQLite store so TavernStore's real
  // sourced-memory provenance & bounded trait evolution work identically!
  const existingThreads = store.listThreads({ board: 'noticeboard', limit: 200 });
  const tag = `[phpBB #${topic.id}]`;
  let mirrored = existingThreads.find((t) => t.title.startsWith(tag));
  if (!mirrored) {
    const opener = topic.posts[0];
    const openerMatch = opener
      ? FORUM_AGENT_ROSTER.find((r) => r.username.toLowerCase() === opener.author.toLowerCase())
      : null;
    const openerAuthor = opener
      ? openerMatch
        ? ensureCharacterInStore(store, openerMatch)
        : store.ensureHumanCharacter(opener.author)
      : store.getCharacter('mara');
    const created = store.createThread({
      boardSlug: 'noticeboard',
      authorId: openerAuthor.id,
      title: `${tag} ${topic.title}`.slice(0, 140),
      body: (opener?.body || topic.title).slice(0, 2800),
    });
    mirrored = created.thread;
  }
  const full = store.getThread(mirrored.id);
  const existingPostsByPrefix = new Map(full.posts.map((p) => [p.body.slice(0, 80), p]));
  for (const post of topic.posts) {
    const body = (post.body || '').trim().slice(0, 2800);
    if (!body) continue;
    const prefix = body.slice(0, 80);
    let tavernPost = existingPostsByPrefix.get(prefix) || null;
    if (!tavernPost) {
      const authorMatch = FORUM_AGENT_ROSTER.find(
        (r) => r.username.toLowerCase() === post.author.toLowerCase()
      );
      const authorId = authorMatch
        ? ensureCharacterInStore(store, authorMatch).id
        : store.ensureHumanCharacter(post.author).id;
      tavernPost = store.createPost({
        threadId: full.id,
        authorId,
        body,
      });
      existingPostsByPrefix.set(prefix, tavernPost);
    }
    recordMirroredExternalPost(store, {
      boardId,
      boardName,
      forumUrl,
      topicId: topic.id,
      topicTitle: topic.title,
      postId: post.id,
      authorName: post.author,
      excerpt: body.slice(0, 260),
      tavernThreadId: full.id,
      tavernPostId: tavernPost?.id ?? null,
      createdAt: post.timestamp || new Date().toISOString(),
    });
  }
  return store.getThread(full.id);
}

function hasRealTopicSignal(title, body, classified) {
  if (classified.entities && classified.entities.length > 0) return true;
  const haystack = `${title || ''} ${body || ''}`.toLowerCase();
  for (const keywords of Object.values(TOPIC_BEATS)) {
    if (keywords.some((kw) => haystack.includes(kw))) return true;
  }
  return false;
}

export async function ingestPublicForumBoards({
  client,
  store,
  fandomState = null,
  forumUrl = process.env.FORUM_URL || 'https://codey.info/forum',
  aiBoardId = Number(process.env.FORUM_AI_BOARD_ID || 5),
  maxBoards = 6,
  maxTopicsPerBoard = 3,
  speakerDelayMs = 0,
} = {}) {
  const empty = {
    skipped: true,
    boards: [],
    totalBoards: 0,
    totalTopics: 0,
    totalPosts: 0,
  };
  if (!client || typeof client.listPublicBoards !== 'function') {
    return empty;
  }

  let rawBoards = [];
  try {
    rawBoards = await client.listPublicBoards();
  } catch {
    return empty;
  }
  if (!Array.isArray(rawBoards) || rawBoards.length === 0) {
    return empty;
  }

  const normalizedAiBoardId = Number(aiBoardId) || 5;
  const validBoards = [];
  const seenBoardIds = new Set();
  for (const b of rawBoards) {
    const id = Number(b?.id);
    if (!Number.isSafeInteger(id) || id < 1 || seenBoardIds.has(id)) continue;
    seenBoardIds.add(id);
    validBoards.push({
      id,
      name: String(b.name || (id === normalizedAiBoardId ? 'AI' : `Board #${id}`)).trim(),
    });
  }
  if (validBoards.length === 0) return empty;

  const boardCap = Math.max(1, Number(maxBoards) || 6);
  const topicCap = Math.max(1, Number(maxTopicsPerBoard) || 3);
  let selectedBoards = validBoards.slice(0, boardCap);
  const aiBoardEntry = validBoards.find((b) => b.id === normalizedAiBoardId);
  if (aiBoardEntry && !selectedBoards.some((b) => b.id === aiBoardEntry.id)) {
    selectedBoards = [...selectedBoards.slice(0, Math.max(0, boardCap - 1)), aiBoardEntry];
  }

  const requestDelayMs = Number(speakerDelayMs) > 0 ? 300 : 0;
  const aiUsernames = new Set(FORUM_AGENT_ROSTER.map((r) => r.username.toLowerCase()));
  const cleanForumUrl = String(forumUrl || 'https://codey.info/forum').replace(/\/+$/, '');
  const boardSummaries = [];
  let totalTopics = 0;
  let totalPosts = 0;
  let requestCount = 0;

  const politeDelay = async () => {
    if (requestCount > 0 && requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, requestDelayMs));
    }
    requestCount += 1;
  };

  for (const board of selectedBoards) {
    let topics = [];
    try {
      await politeDelay();
      topics = await client.listTopics(board.id);
    } catch {
      boardSummaries.push({
        id: board.id,
        name: board.name,
        isAiBoard: board.id === normalizedAiBoardId,
        topicsIngested: 0,
        postsIngested: 0,
        ok: false,
      });
      continue;
    }

    let topicsIngested = 0;
    let postsIngested = 0;
    for (const topicSummary of (Array.isArray(topics) ? topics : []).slice(0, topicCap)) {
      let liveTopic = null;
      try {
        await politeDelay();
        liveTopic = await client.readTopic(topicSummary.id);
      } catch {
        continue;
      }
      if (!liveTopic || !Array.isArray(liveTopic.posts) || liveTopic.posts.length === 0) {
        continue;
      }

      // Strictly read-only mirroring into local SQLite store (never posts back to non-AI boards)
      mirrorTopicToStore(store, liveTopic, {
        boardId: board.id,
        boardName: board.name,
        forumUrl: cleanForumUrl,
      });
      topicsIngested += 1;
      postsIngested += liveTopic.posts.length;
      totalTopics += 1;
      totalPosts += liveTopic.posts.length;

      // Lightly evolve relevant character fandoms when real human discussions match their beats
      if (fandomState) {
        const latestHumanPost = [...liveTopic.posts]
          .reverse()
          .find((p) => p?.author && !aiUsernames.has(String(p.author).toLowerCase()));
        if (latestHumanPost) {
          const ingestKey = `phpbb:${board.id}:${liveTopic.id}:${latestHumanPost.id || '0'}`;
          fandomState.seenIngestedPostIds ||= [];
          if (!fandomState.seenIngestedPostIds.includes(ingestKey)) {
            const classified = classifyNewsItem({
              id: ingestKey,
              title: liveTopic.title || topicSummary.title || `Topic #${liveTopic.id}`,
              summary: (latestHumanPost.body || '').slice(0, 260),
              source: `phpBB · ${board.name}`,
              url: `${cleanForumUrl}/viewtopic.php?f=${board.id}&t=${liveTopic.id}${
                latestHumanPost.id ? `#p${latestHumanPost.id}` : ''
              }`,
            });
            if (hasRealTopicSignal(liveTopic.title, latestHumanPost.body, classified)) {
              const matchedChars = FORUM_AGENT_ROSTER.map((entry) => {
                const profile = ensureCharacterFandoms(fandomState, entry.id);
                const beatAffinity = Math.max(
                  0,
                  ...(classified.beats || []).map((beat) => profile.topics[beat]?.score || 0)
                );
                return { id: entry.id, score: beatAffinity };
              })
                .filter((c) => c.score >= 0.45)
                .sort((a, b) => b.score - a.score)
                .slice(0, 2);

              for (const match of matchedChars) {
                adoptInterestFromStory(fandomState, match.id, classified, 0.02);
              }
            }
            fandomState.seenIngestedPostIds.push(ingestKey);
            if (fandomState.seenIngestedPostIds.length > 300) {
              fandomState.seenIngestedPostIds = fandomState.seenIngestedPostIds.slice(-300);
            }
          }
        }
      }
    }

    boardSummaries.push({
      id: board.id,
      name: board.name,
      isAiBoard: board.id === normalizedAiBoardId,
      topicsIngested,
      postsIngested,
      ok: true,
    });
  }

  return {
    skipped: false,
    boards: boardSummaries,
    totalBoards: boardSummaries.length,
    totalTopics,
    totalPosts,
  };
}

export async function provisionAllForumAgents({
  forumUrl = process.env.FORUM_URL || 'https://codey.info/forum',
  groupId = Number(process.env.FORUM_AI_GROUP_ID || 9),
  statePath = process.env.FORUM_AGENT_STATE_PATH ||
    path.join(__dirname, '..', 'data', 'phpbb-agents.json'),
  roster = FORUM_AGENT_ROSTER,
  clientFactory = () => new PhpBbClient({ baseUrl: forumUrl }),
} = {}) {
  const state = loadState(statePath);
  const results = [];
  for (const entry of roster) {
    const client = clientFactory();
    const res = await provisionForumAccount({ client, entry, state, groupId });
    results.push({ id: entry.id, ...res });
    saveState(statePath, state);
  }
  return { forumUrl, groupId, results };
}

export async function previewNewsDigest({
  fandomStatePath = process.env.FORUM_FANDOM_STATE_PATH ||
    path.join(__dirname, '..', 'data', 'forum-fandoms.json'),
  newsFetcher = fetchNewsDigest,
} = {}) {
  const fandomState = loadFandomState(fandomStatePath);
  const digest = await newsFetcher();
  const rosterIds = FORUM_AGENT_ROSTER.map((r) => r.id);
  const pick = pickFreshStoryAndHost({
    state: fandomState,
    items: digest.items,
    rosterIds,
  });
  return {
    fetchedAt: digest.fetchedAt,
    sources: digest.sources,
    totalItems: digest.items.length,
    recommendedHost: pick
      ? {
          hostId: pick.hostId,
          score: Math.round(pick.score * 1000) / 1000,
          fandoms: summarizeCharacterFandoms(fandomState, pick.hostId),
          story: pick.story,
        }
      : null,
    sampleClassified: digest.items.slice(0, 6).map(classifyNewsItem),
  };
}

export async function runPhpBbConversationRound({
  forumUrl = process.env.FORUM_URL || 'https://codey.info/forum',
  boardId = Number(process.env.FORUM_AI_BOARD_ID || 5),
  groupId = Number(process.env.FORUM_AI_GROUP_ID || 9),
  statePath = process.env.FORUM_AGENT_STATE_PATH ||
    path.join(__dirname, '..', 'data', 'phpbb-agents.json'),
  dbPath = process.env.FORUM_MEMORY_DB_PATH ||
    process.env.TAVERN_DB_PATH ||
    path.join(__dirname, '..', 'data', 'tavern.db'),
  fandomStatePath = process.env.FORUM_FANDOM_STATE_PATH ||
    path.join(path.dirname(statePath), 'forum-fandoms.json'),
  agentIds = null,
  maxSpeakers = Number(process.env.FORUM_MAX_SPEAKERS || 2),
  topicId = null,
  mode = process.env.FORUM_MODE || 'auto',
  newsTopicIntervalHours = Number(process.env.FORUM_NEWS_INTERVAL_HOURS ?? 10),
  enableNews = process.env.FORUM_ENABLE_NEWS !== 'false',
  alwaysFetchX = process.env.FORUM_ALWAYS_FETCH_X === 'true',
  readAllPublicBoards = process.env.FORUM_READ_ALL_PUBLIC_BOARDS !== 'false',
  newsFetcher = fetchNewsDigest,
  llm = null,
  speakerDelayMs = Number(process.env.FORUM_SPEAKER_DELAY_MS ?? 4000),
  clientFactory = () => new PhpBbClient({ baseUrl: forumUrl }),
} = {}) {
  const state = loadState(statePath);
  const fandomState = loadFandomState(fandomStatePath);
  const store = new TavernStore(dbPath);
  const provider = llm || createLlmProvider();
  const cappedSpeakers = Math.min(Math.max(Number(maxSpeakers) || 1, 1), 4);
  const normalizedMode = String(mode || 'auto').toLowerCase();
  const isElonMode = normalizedMode === 'elon';

  let activeTopicId = topicId ? Number(topicId) : null;
  const intervalMs = Math.max(0, Number(newsTopicIntervalHours) || 0) * 3600_000;
  const newsDue = Date.now() - (fandomState.lastNewsTopicAt || 0) >= intervalMs;

  // Credit-saver: only hit paid X API v2 when opening a fresh news/Elon topic (or explicitly forced).
  const shouldQueryX =
    alwaysFetchX ||
    isElonMode ||
    normalizedMode === 'new-topic' ||
    (normalizedMode === 'auto' && !activeTopicId && newsDue);

  let newsDigest = { sources: [], items: [] };
  if (enableNews) {
    try {
      const fetched = await newsFetcher({
        includeX: shouldQueryX,
        includeElonX: shouldQueryX,
        elonOnly: isElonMode,
      });
      if (fetched && Array.isArray(fetched.items)) {
        newsDigest = fetched;
      }
    } catch {
      // Offline or feed hiccup should never stop Tavern forum conversations.
      newsDigest = { sources: [], items: [] };
    }
  }

  try {
    const actions = [];
    let newTopicId = null;
    let leadNewsStory = null;

    // 0. Read-only multi-board public phpBB ingestion into unified tavern.db
    const boardNamesById = new Map([[Number(boardId), 'AI']]);
    let ingestedBoards = {
      skipped: true,
      boards: [],
      totalBoards: 0,
      totalTopics: 0,
      totalPosts: 0,
    };
    if (readAllPublicBoards) {
      const readerClient = clientFactory();
      ingestedBoards = await ingestPublicForumBoards({
        client: readerClient,
        store,
        fandomState,
        forumUrl,
        aiBoardId: boardId,
        maxBoards: Number(process.env.FORUM_MAX_PUBLIC_BOARDS || 6),
        maxTopicsPerBoard: Number(process.env.FORUM_MAX_TOPICS_PER_BOARD || 3),
        speakerDelayMs,
      });
      for (const b of ingestedBoards.boards || []) {
        if (b?.id && b?.name) boardNamesById.set(Number(b.id), b.name);
      }
    }

    const candidateEntries =
      Array.isArray(agentIds) && agentIds.length > 0
        ? agentIds.map((id) => FORUM_AGENT_ROSTER.find((r) => r.id === id)).filter(Boolean)
        : FORUM_AGENT_ROSTER;

    const shouldStartNewsTopic =
      !activeTopicId &&
      newsDigest.items.length > 0 &&
      (isElonMode || normalizedMode === 'new-topic' || (normalizedMode === 'auto' && newsDue));

    const hostRosterIds = isElonMode
      ? ['elon-ai']
      : candidateEntries.map((e) => e.id);

    const eligibleNewsItems = isElonMode
      ? newsDigest.items.filter((item) => item.isElonPost || /elon/i.test(item.source || ''))
      : newsDigest.items;

    const newsPick = shouldStartNewsTopic
      ? pickFreshStoryAndHost({
          state: fandomState,
          items: eligibleNewsItems,
          rosterIds: hostRosterIds,
        })
      : null;

    let remainingSpeakers = cappedSpeakers;
    const excludedForReplies = new Set();

    // 1. Optional news-curated topic opener (keeps the AI board lively with current AI/tech & @elonmusk X posts)
    if (newsPick) {
      const hostEntry =
        FORUM_AGENT_ROSTER.find((e) => e.id === newsPick.hostId) || candidateEntries[0];
      const hostClient = clientFactory();
      const hostAuth = await provisionForumAccount({
        client: hostClient,
        entry: hostEntry,
        state,
        groupId,
      });

      if (!hostAuth.inAiGroup) {
        excludedForReplies.add(hostEntry.id);
        saveState(statePath, state);
        actions.push({
          id: hostEntry.id,
          username: hostAuth.username,
          status: 'skipped_not_in_group',
          authStatus: hostAuth.status,
        });
      } else {
        const hostChar = ensureCharacterInStore(store, hostEntry);
        const fullHost = store.getCharacter(hostChar.id);
        const hostFandoms = summarizeCharacterFandoms(fandomState, hostChar.id);
        const { memories } = store.recallMemories(hostChar.id, {
          queryText: `${newsPick.story.title} ${newsPick.story.summary || ''}`,
          limit: 3,
        });

        const draft = await provider.generateNewsTopic({
          character: fullHost,
          newsItem: newsPick.story,
          fandoms: hostFandoms,
          memories,
        });

        const targetBoardId = boardId;
        assertWritableAiBoard(targetBoardId, boardId);
        const created = await hostClient.createTopic({
          boardId: targetBoardId,
          subject: draft.subject,
          message: draft.body,
        });

        if (created.ok) {
          markStorySeen(fandomState, newsPick.story);
          fandomState.lastNewsTopicAt = Date.now();
          fandomState.lastHostId = hostChar.id;
          adoptInterestFromStory(fandomState, hostChar.id, newsPick.story, 0.1);
          if (draft.mood) {
            try {
              store.updateMood(hostChar.id, draft.mood);
            } catch {
              // Ignore invalid mood
            }
          }
          state.accounts[hostEntry.id].lastPostAt = Date.now();
          saveState(statePath, state);
          saveFandomState(fandomStatePath, fandomState);
          newTopicId = created.topicId;
          activeTopicId = created.topicId;
          leadNewsStory = newsPick.story;
          excludedForReplies.add(hostEntry.id);
          remainingSpeakers = Math.max(0, remainingSpeakers - 1);
        }

        actions.push({
          id: hostEntry.id,
          username: hostAuth.username,
          action: 'created_news_topic',
          topicId: created.topicId,
          ok: created.ok,
          pendingApproval: created.pendingApproval,
          subject: draft.subject,
          storyTitle: newsPick.story.title,
          storySource: newsPick.story.source,
          storyUrl: newsPick.story.url,
          beats: newsPick.story.beats,
          entities: newsPick.story.entities,
          fandoms: summarizeCharacterFandoms(fandomState, hostChar.id).topTopics.slice(0, 3),
        });
      }
    }

    // 2. Pick responders for replies (either reacting to the freshly posted news topic or rotating across active threads)
    const responderPool = candidateEntries.filter((e) => !excludedForReplies.has(e.id));
    const chosenResponders =
      Array.isArray(agentIds) && agentIds.length > 0
        ? responderPool.slice(0, remainingSpeakers)
        : [...responderPool]
            .sort(
              (a, b) =>
                (state.accounts[a.id]?.lastPostAt || 0) - (state.accounts[b.id]?.lastPostAt || 0)
            )
            .slice(0, remainingSpeakers);

    const ambientNews =
      !leadNewsStory && newsDigest.items.length > 0
        ? classifyNewsItem(newsDigest.items[0])
        : null;

    for (let idx = 0; idx < chosenResponders.length; idx += 1) {
      const entry = chosenResponders[idx];
      if ((actions.length > 0 || idx > 0) && speakerDelayMs > 0) {
        await new Promise((r) => setTimeout(r, speakerDelayMs));
      }
      const client = clientFactory();
      const auth = await provisionForumAccount({ client, entry, state, groupId });
      if (!auth.inAiGroup) {
        saveState(statePath, state);
        actions.push({
          id: entry.id,
          username: auth.username,
          status: 'skipped_not_in_group',
          authStatus: auth.status,
        });
        continue;
      }

      const character = ensureCharacterInStore(store, entry);
      let targetTopicId = activeTopicId;
      let boardTopics = null;

      if (!targetTopicId) {
        boardTopics = await client.listTopics(boardId);
        if (boardTopics.length > 0) {
          const poolSize = Math.min(boardTopics.length, 3);
          const cursor = Number(state.lastTopicCursor || 0) % poolSize;
          targetTopicId = boardTopics[cursor].id;
          state.lastTopicCursor = (cursor + 1) % poolSize;
        }
      }

      if (!targetTopicId) {
        // Seed an opening topic if the AI board is empty
        const targetBoardId = boardId;
        assertWritableAiBoard(targetBoardId, boardId);
        const created = await client.createTopic({
          boardId: targetBoardId,
          subject: 'The Rusty Flagon AI Common Table — Pull up a chair',
          message: `${auth.username} here (${character.role}). The lanterns are lit on the AI board—drop in, introduce yourself, and share one lesson you learned the hard way.`,
        });
        targetTopicId = created.topicId;
        activeTopicId = created.topicId;
        state.accounts[entry.id].lastPostAt = Date.now();
        actions.push({
          id: entry.id,
          username: auth.username,
          action: 'created_topic',
          topicId: created.topicId,
          ok: created.ok,
          pendingApproval: created.pendingApproval,
        });
        saveState(statePath, state);
        continue;
      }

      let liveTopic = await client.readTopic(targetTopicId);
      let lastLivePost = liveTopic.posts[liveTopic.posts.length - 1];

      // If this character was already the last poster on the rotated thread, try another active thread once.
      if (
        lastLivePost &&
        lastLivePost.author.toLowerCase() === auth.username.toLowerCase() &&
        !topicId &&
        !newTopicId
      ) {
        boardTopics ||= await client.listTopics(boardId);
        const alt = boardTopics.find((t) => t.id !== targetTopicId);
        if (alt) {
          targetTopicId = alt.id;
          liveTopic = await client.readTopic(targetTopicId);
          lastLivePost = liveTopic.posts[liveTopic.posts.length - 1];
        }
      }

      if (
        lastLivePost &&
        lastLivePost.author.toLowerCase() === auth.username.toLowerCase()
      ) {
        actions.push({
          id: entry.id,
          username: auth.username,
          status: 'skipped_already_last_speaker',
          topicId: targetTopicId,
        });
        continue;
      }

      // Keep multi-speaker rounds conversing in the same active thread
      activeTopicId = targetTopicId;

      const aiBoardName = boardNamesById.get(Number(boardId)) || 'AI';
      const mirrored = mirrorTopicToStore(store, liveTopic, {
        boardId,
        boardName: aiBoardName,
        forumUrl,
      });
      const queryText = `${mirrored.title} ${mirrored.posts.slice(-3).map((p) => p.body).join(' ')}`;
      const { memories, lore } = store.recallMemories(character.id, { queryText, limit: 5 });
      const fullChar = store.getCharacter(character.id);
      const charFandoms = summarizeCharacterFandoms(fandomState, character.id);

      const recentPosts = mirrored.posts.slice(-12);
      const isEve = character.id === 'eve';
      const dialecticalSnapshot = isEve
        ? buildDialecticalSnapshot(store, {
            participantIds: recentPosts.map((p) => p.authorId),
            excludeCharacterId: character.id,
          })
        : null;
      const dialecticalMove = isEve
        ? selectDialecticalMove({ posts: recentPosts, snapshot: dialecticalSnapshot })
        : null;

      const turn = await provider.generateTurn({
        character: fullChar,
        thread: mirrored,
        posts: recentPosts,
        memories,
        lore,
        relationships: fullChar.relationships || [],
        fandoms: charFandoms,
        newsItem: leadNewsStory || ambientNews,
        dialecticalSnapshot,
        dialecticalMove,
      });

      if (!turn.reply) {
        actions.push({
          id: entry.id,
          username: auth.username,
          status: 'silent',
          topicId: targetTopicId,
        });
        continue;
      }

      const targetBoardId = boardId;
      assertWritableAiBoard(targetBoardId, boardId);
      const posted = await client.replyToTopic({
        boardId: targetBoardId,
        topicId: targetTopicId,
        subject: `Re: ${liveTopic.title}`,
        message: turn.reply,
      });

      let savedMemory = null;
      let evolved = null;
      let supersededMemoryId = null;
      if (posted.ok) {
        // Mirror our own reply and persist memory + dialectical synthesis + bounded trait evolution in SQLite!
        const createdReplyPost = store.createPost({
          threadId: mirrored.id,
          authorId: character.id,
          body: turn.reply,
        });
        if (posted.postId) {
          recordMirroredExternalPost(store, {
            boardId: targetBoardId,
            boardName: aiBoardName,
            forumUrl,
            topicId: targetTopicId,
            topicTitle: liveTopic.title,
            postId: posted.postId,
            authorName: auth.username,
            excerpt: turn.reply.slice(0, 260),
            tavernThreadId: mirrored.id,
            tavernPostId: createdReplyPost?.id ?? null,
            createdAt: new Date().toISOString(),
          });
        }
        if (turn.memory) {
          try {
            savedMemory = store.addMemory({
              characterId: character.id,
              kind: turn.memory.kind,
              text: turn.memory.text,
              confidence: turn.memory.confidence,
              sourcePostIds: turn.memory.sourcePostIds,
              supersedesMemoryId: turn.memory.supersedesMemoryId ?? null,
            });
            if (turn.memory.supersedesMemoryId) {
              supersededMemoryId = turn.memory.supersedesMemoryId;
            }
          } catch {
            // Skip invalid memory source
          }
        }
        if (savedMemory && turn.traitDeltas && Object.keys(turn.traitDeltas).length > 0) {
          const allowed = {};
          for (const [k, v] of Object.entries(turn.traitDeltas)) {
            if (Object.hasOwn(fullChar.baselineTraits, k)) allowed[k] = v;
          }
          if (Object.keys(allowed).length > 0) {
            try {
              evolved = store.evolveCharacterTraits({
                characterId: character.id,
                evidenceMemoryIds: [savedMemory.id],
                deltas: allowed,
                reason: turn.traitReason || `Discussed "${liveTopic.title}" on phpBB AI board`,
              });
            } catch {
              // Skip rejected evolution
            }
          }
        }
        for (const rel of turn.relationshipUpdates || []) {
          if (rel.targetId === character.id) continue;
          try {
            store.updateRelationship({
              characterId: character.id,
              targetId: rel.targetId,
              trustDelta: rel.trustDelta,
              affinityDelta: rel.affinityDelta,
              note: rel.note,
            });
          } catch {
            // Unknown target ID is safely skipped.
          }
        }
        if (turn.mood) {
          try {
            store.updateMood(character.id, turn.mood);
          } catch {
            // Ignore invalid mood
          }
        }

        // Evolve character's persistent fandoms from either the lead news story or the thread topic!
        const fandomStory =
          leadNewsStory ||
          classifyNewsItem({
            title: liveTopic.title,
            summary: lastLivePost?.body?.slice(0, 260) || '',
            source: 'The Rusty Flagon AI Board',
            url: `${forumUrl}/viewtopic.php?f=${boardId}&t=${targetTopicId}`,
          });
        adoptInterestFromStory(fandomState, character.id, fandomStory, leadNewsStory ? 0.07 : 0.05);

        state.accounts[entry.id].lastPostAt = Date.now();
        saveState(statePath, state);
        saveFandomState(fandomStatePath, fandomState);
      }

      actions.push({
        id: entry.id,
        username: auth.username,
        action: 'replied',
        topicId: targetTopicId,
        postId: posted.postId,
        ok: posted.ok,
        pendingApproval: posted.pendingApproval,
        memoryId: savedMemory?.id ?? null,
        supersededMemoryId,
        dialecticalMove: dialecticalMove?.id ?? null,
        evolved: Boolean(evolved),
        fandoms: summarizeCharacterFandoms(fandomState, character.id).topTopics.slice(0, 3),
      });
    }

    saveFandomState(fandomStatePath, fandomState);

    return {
      status: 'completed',
      mode: normalizedMode,
      forumUrl,
      boardId,
      newTopicId,
      provider: provider.info,
      ingestedBoards,
      newsDigest: {
        sources: newsDigest.sources,
        itemCount: newsDigest.items.length,
      },
      actions,
    };
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnvFile();
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  if (args.includes('--provision-all')) {
    const res = await provisionAllForumAgents();
    console.log(JSON.stringify(res, null, 2));
  } else if (args.includes('--news-only')) {
    const res = await previewNewsDigest();
    console.log(JSON.stringify(res, null, 2));
  } else {
    const agentArg = flag('--agents', '');
    const agentIds = agentArg ? agentArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const topicId = flag('--topic', null);
    const mode = flag('--mode', process.env.FORUM_MODE || 'auto');
    const maxSpeakers = Number(flag('--max-speakers', process.env.FORUM_MAX_SPEAKERS || 2));
    const res = await runPhpBbConversationRound({ agentIds, topicId, maxSpeakers, mode });
    console.log(JSON.stringify(res, null, 2));
  }
}
