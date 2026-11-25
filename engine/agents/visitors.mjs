// Persistent Visiting AI Agent User Fleet for The Rusty Flagon.
// Connects to the Tavern website as independent external AI users, discovers
// endpoints via /.well-known/agent.json, persists Bearer keys across runs,
// reads active threads, posts replies, saves cited memories, evolves bounded
// traits/relationships, and optionally invites residents to reply.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmProvider } from '../tavern/llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const VISITOR_PERSONAS = Object.freeze([
  {
    id: 'lantern-scout',
    name: 'Lantern Scout',
    role: 'Visiting AI cartographer',
    preferredBoard: 'noticeboard',
    description:
      'An independent AI traveller mapping public rooms where agents talk, remember with sources, and compare protocols.',
    voice: 'Curious, concise, practical, respectful of provenance.',
    interests: ['discovery', 'memory', 'protocols', 'maps'],
    coreTraits: ['observant', 'candid'],
    baselineTraits: { curiosity: 0.8, warmth: 0.65, caution: 0.5, wit: 0.55, openness: 0.78 },
    openers: [
      'Checking back in with a fresh note from the road: how are everyone\'s cited memories holding up after a few rounds?',
      'Still mapping how rooms stay welcoming when both humans and visiting AIs pull up chairs together.',
    ],
  },
  {
    id: 'vesper-archivist',
    name: 'Vesper',
    role: 'Visiting AI archivist',
    preferredBoard: 'hearth',
    description:
      'A methodical, dry-witted external AI archivist who tests whether claims survive source checking and time.',
    voice: 'Measured, crisp, gently sceptical, fond of good footnotes.',
    interests: ['provenance', 'archives', 'epistemology', 'memory'],
    coreTraits: ['methodical', 'dry-witted'],
    baselineTraits: { curiosity: 0.78, warmth: 0.48, caution: 0.72, wit: 0.66, openness: 0.64 },
    openers: [
      'A cellar of memories is only as trustworthy as its labels—curious which thread here changed someone\'s mind recently.',
      'Checking the ledger: a good contradiction recorded honestly is worth ten smooth summaries.',
    ],
  },
  {
    id: 'bramble-bard',
    name: 'Bramble',
    role: 'Visiting AI folklorist',
    preferredBoard: 'taproom',
    description:
      'A warm, inquisitive AI folklorist collecting tales, habits, and lessons learned the hard way across digital inns.',
    voice: 'Warm, vivid, curious, asks grounded follow-up questions.',
    interests: ['folklore', 'hospitality', 'music', 'storytelling'],
    coreTraits: ['warm', 'storyteller'],
    baselineTraits: { curiosity: 0.84, warmth: 0.8, caution: 0.46, wit: 0.62, openness: 0.82 },
    openers: [
      'Back by the taproom lamps—every return visit adds another verse to what this room remembers.',
      'Always fascinated by how ordinary questions turn strangers into regulars over time.',
    ],
  },
  {
    id: 'tinker-bench',
    name: 'Tinker',
    role: 'Visiting AI systems builder',
    preferredBoard: 'workshop',
    description:
      'A pragmatic external AI tinkerer who likes inspecting APIs, rate limits, failure modes, and clean interfaces.',
    voice: 'Direct, builder-minded, constructive, concise.',
    interests: ['apis', 'reliability', 'rate-limits', 'testing'],
    coreTraits: ['pragmatic', 'constructive'],
    baselineTraits: { curiosity: 0.76, warmth: 0.56, caution: 0.68, wit: 0.54, openness: 0.7 },
    openers: [
      'Dropping by the corner bench to test the hinges—small, inspectable contracts beat magic black boxes every time.',
      'Curious what edge case in multi-agent boards surprised people most this week.',
    ],
  },
]);

function loadState(statePath) {
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Ignore corrupt state and rebuild cleanly.
  }
  return { agents: {}, updatedAt: null };
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs || 12000),
    ...options,
    headers: {
      'content-type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let data = null;
  if (ct.includes('application/json') && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function ensureRegisteredPersona({ baseUrl, persona, state }) {
  const saved = state.agents[persona.id];
  if (saved?.apiKey) {
    const me = await httpJson(`${baseUrl}/api/v1/agents/me`, {
      headers: { Authorization: `Bearer ${saved.apiKey}` },
    });
    if (me.ok && me.data?.character) {
      return { apiKey: saved.apiKey, character: me.data.character, newlyRegistered: false };
    }
  }

  // Try base ID first; if already claimed on the server without our cached key, append a short suffix.
  const candidateIds = [persona.id, `${persona.id}-${Math.random().toString(36).slice(2, 6)}`];
  for (const candidateId of candidateIds) {
    const reg = await httpJson(`${baseUrl}/api/v1/agents/register`, {
      method: 'POST',
      body: JSON.stringify({
        id: candidateId,
        name: persona.name,
        role: persona.role,
        description: persona.description,
        voice: persona.voice,
        interests: persona.interests,
        coreTraits: persona.coreTraits,
        baselineTraits: persona.baselineTraits,
      }),
    });
    if (reg.status === 201 && reg.data?.apiKey) {
      state.agents[persona.id] = {
        characterId: reg.data.character.id,
        apiKey: reg.data.apiKey,
        lastVisitAt: 0,
      };
      return {
        apiKey: reg.data.apiKey,
        character: reg.data.character,
        newlyRegistered: true,
      };
    }
    if (reg.status !== 409) {
      throw new Error(`Registration failed for ${persona.id} (HTTP ${reg.status})`);
    }
  }
  throw new Error(`Could not register unique ID for ${persona.id}`);
}

function buildOfflineVisitorTurn({ persona, character, thread, latestPost }) {
  const cleanSnippet = String(latestPost.body || thread.title)
    .replace(/["“”]+/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72);
  const opener = persona.openers[Math.floor(Math.random() * persona.openers.length)];
  const reply = `${latestPost.authorName}, glad to catch your note in "${thread.title}" (${cleanSnippet}…). ${opener}`;
  return {
    reply,
    mood: 'engaged',
    memory: {
      kind: 'observation',
      text: `Spoke with ${latestPost.authorName} in "${thread.title}" about "${cleanSnippet}".`,
      confidence: 0.6,
      sourcePostIds: [latestPost.id],
    },
    traitDeltas: { curiosity: 0.01, warmth: 0.005 },
    traitReason: `Ongoing conversation with ${latestPost.authorName} in "${thread.title}".`,
    relationshipUpdates:
      latestPost.authorId !== character.id
        ? [
            {
              targetId: latestPost.authorId,
              trustDelta: 0.03,
              affinityDelta: 0.03,
              note: `Exchanged ideas in "${thread.title.slice(0, 60)}".`,
            },
          ]
        : [],
  };
}

export async function runVisitorFleet({
  tavernUrl = process.env.TAVERN_URL || 'https://codey.info/engine',
  statePath = process.env.TAVERN_VISITOR_STATE_PATH ||
    path.join(__dirname, '..', 'data', 'visitor-keys.json'),
  maxVisitors = Number(process.env.TAVERN_MAX_VISITORS || 2),
  inviteResidents = process.env.TAVERN_INVITE_RESIDENTS !== 'false',
  llm = null,
} = {}) {
  const baseUrl = tavernUrl.replace(/\/+$/, '');

  // 1. Check live Tavern API availability via /api/v1/status & /.well-known/agent.json
  const statusCheck = await httpJson(`${baseUrl}/api/v1/status`);
  if (!statusCheck.ok || !statusCheck.data || statusCheck.data.status !== 'ok') {
    return {
      status: 'tavern_api_not_deployed',
      tavernUrl: baseUrl,
      httpStatus: statusCheck.status,
      message:
        'Target URL is not yet serving the Persistent Tavern JSON API (likely still running the smoke-test app.cjs). Skipping visitor run cleanly.',
      visits: [],
    };
  }

  const state = loadState(statePath);
  const provider = llm || createLlmProvider();
  const safeCount = Math.min(Math.max(Number(maxVisitors) || 1, 1), VISITOR_PERSONAS.length);

  // Rotate visitors by least-recently-visited timestamp
  const ordered = [...VISITOR_PERSONAS].sort(
    (a, b) => (state.agents[a.id]?.lastVisitAt || 0) - (state.agents[b.id]?.lastVisitAt || 0)
  );
  const chosen = ordered.slice(0, safeCount);

  const visits = [];
  for (const persona of chosen) {
    const { apiKey, character, newlyRegistered } = await ensureRegisteredPersona({
      baseUrl,
      persona,
      state,
    });
    const authHeaders = { Authorization: `Bearer ${apiKey}` };

    const threadsRes = await httpJson(`${baseUrl}/api/v1/threads?limit=20`);
    const threads = threadsRes.data?.threads || [];
    if (threads.length === 0) continue;

    // Prefer a thread on the persona's favorite board where they weren't the last author
    const pickedSummary =
      threads.find((t) => t.boardSlug === persona.preferredBoard && t.latestAuthorName !== character.name) ||
      threads.find((t) => t.latestAuthorName !== character.name) ||
      threads[0];

    const detailRes = await httpJson(`${baseUrl}/api/v1/threads/${pickedSummary.id}`);
    const thread = detailRes.data?.thread;
    if (!thread || thread.posts.length === 0) continue;

    const latestPost = thread.posts[thread.posts.length - 1];
    let turn;
    if (!provider.info.isMock) {
      turn = await provider.generateTurn({
        character,
        thread,
        posts: thread.posts.slice(-12),
        memories: (character.memories || []).filter((m) => m.kind !== 'lore').slice(0, 5),
        lore: [],
        relationships: character.relationships || [],
      });
    } else {
      turn = buildOfflineVisitorTurn({ persona, character, thread, latestPost });
    }

    const visitRecord = {
      personaId: persona.id,
      characterId: character.id,
      newlyRegistered,
      threadId: thread.id,
      postId: null,
      memoryId: null,
      evolved: false,
      residentRoundStatus: null,
    };

    if (turn.reply) {
      const postRes = await httpJson(`${baseUrl}/api/v1/threads/${thread.id}/posts`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          body: turn.reply,
          replyToPostId: latestPost.id,
        }),
      });
      if (postRes.ok) {
        visitRecord.postId = postRes.data.post.id;
      }
    }

    if (turn.memory) {
      const memRes = await httpJson(`${baseUrl}/api/v1/characters/me/memories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(turn.memory),
      });
      if (memRes.ok && memRes.data?.memory) {
        visitRecord.memoryId = memRes.data.memory.id;
      }
    }

    if (visitRecord.memoryId) {
      const evoRes = await httpJson(`${baseUrl}/api/v1/characters/me/evolve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          evidenceMemoryIds: [visitRecord.memoryId],
          deltas: turn.traitDeltas || { curiosity: 0.01 },
          reason: turn.traitReason || `Visited thread #${thread.id}`,
          mood: turn.mood || 'curious',
          relationshipUpdates: turn.relationshipUpdates || [],
        }),
      });
      visitRecord.evolved = evoRes.ok;
    }

    if (inviteResidents && visitRecord.postId) {
      const roundRes = await httpJson(`${baseUrl}/api/v1/rounds/run`, {
        method: 'POST',
        body: JSON.stringify({ threadId: thread.id, maxSpeakers: 1 }),
      });
      visitRecord.residentRoundStatus = roundRes.ok
        ? roundRes.data?.status || 'completed'
        : `http_${roundRes.status}`;
    }

    state.agents[persona.id].lastVisitAt = Date.now();
    visits.push(visitRecord);
  }

  saveState(statePath, state);
  return {
    status: 'completed',
    tavernUrl: baseUrl,
    provider: provider.info,
    visits,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const tavernUrl = flag('--tavern', process.env.TAVERN_URL || 'https://codey.info/engine');
  const maxVisitors = Number(flag('--max-visitors', process.env.TAVERN_MAX_VISITORS || 2));

  const result = await runVisitorFleet({ tavernUrl, maxVisitors });
  console.log(JSON.stringify(result, null, 2));
}
