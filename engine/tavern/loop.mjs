// Resident conversation & reflection loop for The Rusty Flagon.
// Each round selects eligible resident characters, recalls their relevant
// memories and relationships, generates an in-character reply + structured
// reflection, persists sourced memories, and applies bounded trait/relationship
// evolution.

import { TavernStoreError } from './store.mjs';

function pickSpeakers({ residents, posts, requestedIds, maxSpeakers }) {
  const active = residents.filter((r) => !r.paused);
  if (active.length === 0) return [];

  if (Array.isArray(requestedIds) && requestedIds.length > 0) {
    const requested = requestedIds
      .map((id) => active.find((r) => r.id === id))
      .filter(Boolean);
    if (requested.length > 0) return requested.slice(0, maxSpeakers);
  }

  const latestPost = posts[posts.length - 1];
  const latestText = (latestPost?.body || '').toLowerCase();
  const lastAuthorId = latestPost?.authorId;

  // Prefer residents who weren't the very last speaker, prioritizing anyone
  // mentioned by name in the latest post, then those who have spoken least recently.
  const recentOrder = new Map();
  posts.forEach((p, idx) => recentOrder.set(p.authorId, idx));

  const candidates = active.filter((r) => r.id !== lastAuthorId);
  const pool = candidates.length > 0 ? candidates : active;

  pool.sort((a, b) => {
    const aMentioned = latestText.includes(a.name.toLowerCase()) ? 1 : 0;
    const bMentioned = latestText.includes(b.name.toLowerCase()) ? 1 : 0;
    if (aMentioned !== bMentioned) return bMentioned - aMentioned;
    const aIdx = recentOrder.has(a.id) ? recentOrder.get(a.id) : -1;
    const bIdx = recentOrder.has(b.id) ? recentOrder.get(b.id) : -1;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.id.localeCompare(b.id);
  });

  return pool.slice(0, maxSpeakers);
}

export async function runTavernRound({
  store,
  llm,
  threadId = null,
  characterIds = null,
  maxSpeakers = 2,
  maxBotChain = 8,
  allowOverrideChain = false,
} = {}) {
  const safeMaxSpeakers = Math.min(Math.max(Number(maxSpeakers) || 1, 1), 3);

  let targetThreadId = threadId ? Number(threadId) : null;
  if (!targetThreadId) {
    const threads = store.listThreads({ limit: 15 });
    if (threads.length === 0) {
      throw new TavernStoreError('no_threads', 'No threads available for a Tavern round', 404);
    }
    // Pick the most recently active thread that hasn't hit the bot-chain cap.
    const eligible = threads.find((t) => store.countBotChainDepth(t.id) < maxBotChain);
    targetThreadId = eligible ? eligible.id : threads[0].id;
  }

  let thread = store.getThread(targetThreadId);
  if (!thread) {
    throw new TavernStoreError('thread_not_found', `Thread #${targetThreadId} not found`, 404);
  }

  const chainDepth = store.countBotChainDepth(thread.id);
  if (!allowOverrideChain && chainDepth >= maxBotChain) {
    return {
      status: 'chain_limited',
      threadId: thread.id,
      threadTitle: thread.title,
      provider: llm.info,
      chainDepth,
      maxBotChain,
      turns: [],
    };
  }

  const residents = store.listCharacters({ kind: 'resident' });
  const speakers = pickSpeakers({
    residents,
    posts: thread.posts,
    requestedIds: characterIds,
    maxSpeakers: safeMaxSpeakers,
  });

  const turns = [];
  for (const speaker of speakers) {
    // Re-read thread so the second speaker sees the first speaker's new post!
    thread = store.getThread(targetThreadId);
    const recentPosts = thread.posts.slice(-16);
    const queryText = `${thread.title} ${recentPosts.slice(-3).map((p) => p.body).join(' ')}`;
    const { memories, lore } = store.recallMemories(speaker.id, { queryText, limit: 6 });

    const participantIds = new Set(recentPosts.map((p) => p.authorId));
    const fullSpeaker = store.getCharacter(speaker.id);
    const relevantRelationships = fullSpeaker.relationships.filter((r) =>
      participantIds.has(r.targetId)
    );

    const turnResult = await llm.generateTurn({
      character: fullSpeaker,
      thread,
      posts: recentPosts,
      memories,
      lore,
      relationships: relevantRelationships,
    });

    const outcome = {
      characterId: speaker.id,
      characterName: speaker.name,
      post: null,
      memory: null,
      traitEvolution: null,
      mood: fullSpeaker.mood,
      relationshipUpdates: [],
    };

    if (turnResult.reply !== null) {
      const latestPost = recentPosts[recentPosts.length - 1];
      outcome.post = store.createPost({
        threadId: thread.id,
        authorId: speaker.id,
        body: turnResult.reply,
        replyToPostId: latestPost ? latestPost.id : null,
        optInMemory: true,
      });
    }

    if (turnResult.mood) {
      try {
        outcome.mood = store.updateMood(speaker.id, turnResult.mood);
      } catch {
        // Ignore invalid mood token.
      }
    }

    if (turnResult.memory) {
      try {
        outcome.memory = store.addMemory({
          characterId: speaker.id,
          kind: turnResult.memory.kind,
          text: turnResult.memory.text,
          confidence: turnResult.memory.confidence,
          sourcePostIds: turnResult.memory.sourcePostIds,
        });
      } catch {
        // Invalid or ineligible memory source is safely skipped.
      }
    }

    if (
      outcome.memory &&
      turnResult.traitDeltas &&
      Object.keys(turnResult.traitDeltas).length > 0
    ) {
      // Filter deltas strictly to the character's known baseline trait keys.
      const allowedDeltas = {};
      for (const [k, v] of Object.entries(turnResult.traitDeltas)) {
        if (Object.hasOwn(fullSpeaker.baselineTraits, k)) {
          allowedDeltas[k] = v;
        }
      }
      if (Object.keys(allowedDeltas).length > 0) {
        try {
          outcome.traitEvolution = store.evolveCharacterTraits({
            characterId: speaker.id,
            evidenceMemoryIds: [outcome.memory.id],
            deltas: allowedDeltas,
            reason: turnResult.traitReason || `Reflected on thread #${thread.id}`,
          });
        } catch {
          // Bounded policy rejection is safely skipped.
        }
      }
    }

    for (const rel of turnResult.relationshipUpdates || []) {
      if (rel.targetId === speaker.id) continue;
      try {
        const updated = store.updateRelationship({
          characterId: speaker.id,
          targetId: rel.targetId,
          trustDelta: rel.trustDelta,
          affinityDelta: rel.affinityDelta,
          note: rel.note,
        });
        outcome.relationshipUpdates.push(updated);
      } catch {
        // Unknown target ID is safely skipped.
      }
    }

    turns.push(outcome);
  }

  store.logAudit('tavern_round_completed', null, {
    threadId: thread.id,
    provider: llm.info.provider,
    model: llm.info.model,
    speakers: turns.map((t) => t.characterId),
    postsCreated: turns.filter((t) => t.post).length,
    memoriesCreated: turns.filter((t) => t.memory).length,
  });

  return {
    status: 'completed',
    threadId: thread.id,
    threadTitle: thread.title,
    provider: llm.info,
    turns,
  };
}
