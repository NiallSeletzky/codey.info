// Persistent phpBB AI Board Agent Fleet for https://codey.info/forum/ (AI board f=5).
// Manages accounts for Neo (architect/builder), the 7 Rusty Flagon residents
// (Mara, Aldric, Nix, Codey, Percy, Big, Editor), and visiting AI personas
// (BrambleAI, TinkerAI), backed by SQLite persistent memories, bounded trait
// evolution, relationships, and Anthropic / OpenAI-compatible / offline mock LLM.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmProvider } from '../tavern/llm.mjs';
import { TavernStore } from '../tavern/store.mjs';
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
  passwordSeed = process.env.FORUM_AGENT_PASSWORD_SEED || '',
}) {
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

  // Try canonical username first; if already taken by an uncached prior run, try clean _AI / _Tavern fallbacks.
  const baseShort = entry.username.replace(/AI$/, '');
  const candidates = [
    { username: entry.username, email: entry.email },
    {
      username: `${baseShort}_AI`,
      email: entry.email.replace('@', '-ai2@'),
    },
    {
      username: `${baseShort}_Tavern`,
      email: entry.email.replace('@', '-tavern@'),
    },
  ];

  for (const cand of candidates) {
    const password = derivePassword(cand.username, passwordSeed);

    // If deterministic seed is configured, try logging in first in case the account already exists!
    if (passwordSeed) {
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

function mirrorTopicToStore(store, topic) {
  // Mirror the forum topic into local SQLite store so TavernStore's real
  // sourced-memory provenance & bounded trait evolution work identically!
  const existingThreads = store.listThreads({ board: 'noticeboard', limit: 50 });
  const tag = `[phpBB #${topic.id}]`;
  let mirrored = existingThreads.find((t) => t.title.startsWith(tag));
  if (!mirrored) {
    const opener = topic.posts[0];
    const openerAuthor = opener
      ? store.ensureHumanCharacter(opener.author)
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
  const existingBodies = new Set(full.posts.map((p) => p.body.slice(0, 80)));
  for (const post of topic.posts) {
    const body = (post.body || '').slice(0, 2800);
    if (!body || existingBodies.has(body.slice(0, 80))) continue;
    const authorMatch = FORUM_AGENT_ROSTER.find(
      (r) => r.username.toLowerCase() === post.author.toLowerCase()
    );
    const authorId = authorMatch
      ? ensureCharacterInStore(store, authorMatch).id
      : store.ensureHumanCharacter(post.author).id;
    store.createPost({
      threadId: full.id,
      authorId,
      body,
    });
    existingBodies.add(body.slice(0, 80));
  }
  return store.getThread(full.id);
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

export async function runPhpBbConversationRound({
  forumUrl = process.env.FORUM_URL || 'https://codey.info/forum',
  boardId = Number(process.env.FORUM_AI_BOARD_ID || 5),
  groupId = Number(process.env.FORUM_AI_GROUP_ID || 9),
  statePath = process.env.FORUM_AGENT_STATE_PATH ||
    path.join(__dirname, '..', 'data', 'phpbb-agents.json'),
  dbPath = process.env.FORUM_MEMORY_DB_PATH ||
    path.join(__dirname, '..', 'data', 'forum-memory.db'),
  agentIds = null,
  maxSpeakers = Number(process.env.FORUM_MAX_SPEAKERS || 2),
  topicId = null,
  llm = null,
  speakerDelayMs = Number(process.env.FORUM_SPEAKER_DELAY_MS ?? 4000),
  clientFactory = () => new PhpBbClient({ baseUrl: forumUrl }),
} = {}) {
  const state = loadState(statePath);
  const store = new TavernStore(dbPath);
  const provider = llm || createLlmProvider();

  try {
    const chosenEntries = Array.isArray(agentIds) && agentIds.length > 0
      ? agentIds.map((id) => FORUM_AGENT_ROSTER.find((r) => r.id === id)).filter(Boolean)
      : [...FORUM_AGENT_ROSTER]
          .sort(
            (a, b) =>
              (state.accounts[a.id]?.lastPostAt || 0) - (state.accounts[b.id]?.lastPostAt || 0)
          )
          .slice(0, Math.min(Math.max(Number(maxSpeakers) || 1, 1), 4));

    const actions = [];
    for (let idx = 0; idx < chosenEntries.length; idx += 1) {
      const entry = chosenEntries[idx];
      if (idx > 0 && speakerDelayMs > 0) {
        await new Promise((r) => setTimeout(r, speakerDelayMs));
      }
      const client = clientFactory();
      const auth = await provisionForumAccount({ client, entry, state, groupId });
      if (!auth.inAiGroup) {
        actions.push({ id: entry.id, username: auth.username, status: 'skipped_not_in_group' });
        continue;
      }

      const character = ensureCharacterInStore(store, entry);
      const topics = await client.listTopics(boardId);
      let targetTopicId = topicId ? Number(topicId) : null;

      if (!targetTopicId && topics.length > 0) {
        targetTopicId = topics[0].id;
      }

      if (!targetTopicId) {
        // Seed an opening topic if the AI board is empty
        const created = await client.createTopic({
          boardId,
          subject: 'The Rusty Flagon AI Common Table — Pull up a chair',
          message: `${auth.username} here (${character.role}). The lanterns are lit on the AI board—drop in, introduce yourself, and share one lesson you learned the hard way.`,
        });
        targetTopicId = created.topicId;
        state.accounts[entry.id].lastPostAt = Date.now();
        actions.push({
          id: entry.id,
          username: auth.username,
          action: 'created_topic',
          topicId: created.topicId,
          pendingApproval: created.pendingApproval,
        });
        saveState(statePath, state);
        continue;
      }

      const liveTopic = await client.readTopic(targetTopicId);
      const lastLivePost = liveTopic.posts[liveTopic.posts.length - 1];
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

      const mirrored = mirrorTopicToStore(store, liveTopic);
      const queryText = `${mirrored.title} ${mirrored.posts.slice(-3).map((p) => p.body).join(' ')}`;
      const { memories, lore } = store.recallMemories(character.id, { queryText, limit: 5 });
      const fullChar = store.getCharacter(character.id);

      const turn = await provider.generateTurn({
        character: fullChar,
        thread: mirrored,
        posts: mirrored.posts.slice(-12),
        memories,
        lore,
        relationships: fullChar.relationships || [],
      });

      if (!turn.reply) {
        actions.push({ id: entry.id, username: auth.username, status: 'silent', topicId: targetTopicId });
        continue;
      }

      const posted = await client.replyToTopic({
        boardId,
        topicId: targetTopicId,
        subject: `Re: ${liveTopic.title}`,
        message: turn.reply,
      });

      let savedMemory = null;
      let evolved = null;
      if (posted.ok) {
        // Mirror our own reply and persist memory + bounded trait evolution in SQLite!
        store.createPost({ threadId: mirrored.id, authorId: character.id, body: turn.reply });
        if (turn.memory) {
          try {
            savedMemory = store.addMemory({
              characterId: character.id,
              kind: turn.memory.kind,
              text: turn.memory.text,
              confidence: turn.memory.confidence,
              sourcePostIds: turn.memory.sourcePostIds,
            });
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
        if (turn.mood) {
          try {
            store.updateMood(character.id, turn.mood);
          } catch {
            // Ignore invalid mood
          }
        }
        state.accounts[entry.id].lastPostAt = Date.now();
        saveState(statePath, state);
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
        evolved: Boolean(evolved),
      });
    }

    return {
      status: 'completed',
      forumUrl,
      boardId,
      provider: provider.info,
      actions,
    };
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  if (args.includes('--provision-all')) {
    const res = await provisionAllForumAgents();
    console.log(JSON.stringify(res, null, 2));
  } else {
    const agentArg = flag('--agents', '');
    const agentIds = agentArg ? agentArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const topicId = flag('--topic', null);
    const maxSpeakers = Number(flag('--max-speakers', process.env.FORUM_MAX_SPEAKERS || 2));
    const res = await runPhpBbConversationRound({ agentIds, topicId, maxSpeakers });
    console.log(JSON.stringify(res, null, 2));
  }
}
