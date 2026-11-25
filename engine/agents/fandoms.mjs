// Persistent Character Interests & Fandom Engine for The Rusty Flagon.
// Classifies incoming news/social stories into beats and entities, matches
// stories to characters who care most about them, and evolves each character's
// persistent fandom tiers over time ('curious' -> 'following' -> 'enthusiast' -> 'devoted fan').

import fs from 'node:fs';
import path from 'node:path';

export const TOPIC_BEATS = Object.freeze({
  'ai-agents': ['agent', 'agents', 'mcp', 'tool use', 'autonomous', 'multi-agent', 'workflow', 'harness'],
  'open-models': ['open-weight', 'open weights', 'open source', 'hugging face', 'llama', 'qwen', 'deepseek', 'mistral', 'ollama', 'gguf', 'local llm'],
  'reasoning-research': ['arxiv', 'reasoning', 'benchmark', 'transformer', 'memory', 'alignment', 'paper', 'training', 'inference', 'rlhf'],
  'coding-tools': ['coding', 'compiler', 'sqlite', 'javascript', 'python', 'rust', 'cli', 'github', 'ide', 'database', 'developer'],
  'ai-hardware': ['gpu', 'nvidia', 'chip', 'compute', 'data center', 'datacentre', 'silicon', 'energy', 'tpu', 'cluster'],
  'robotics': ['robot', 'robotics', 'humanoid', 'drone', 'embodied', 'sensor', 'actuator'],
  'security-safety': ['security', 'prompt injection', 'privacy', 'vulnerability', 'sandbox', 'attack', 'safety', 'exploit', 'audit'],
  'music-culture': ['music', 'art', 'game', 'story', 'film', 'creative', 'society', 'education', 'journalism', 'writing'],
});

export const NOTABLE_ENTITIES = Object.freeze([
  'Anthropic', 'Claude', 'OpenAI', 'ChatGPT', 'xAI', 'Grok', 'Google', 'Gemini',
  'DeepMind', 'DeepSeek', 'Meta', 'Llama', 'Qwen', 'Mistral', 'Hugging Face',
  'Ollama', 'MCP', 'SQLite', 'Python', 'JavaScript', 'Node.js', 'Rust', 'Linux',
  'NVIDIA', 'arXiv', 'GitHub',
]);

// Starting natural curiosity seeds per Tavern character (0..1)
export const SEED_FANDOMS = Object.freeze({
  neo: { 'ai-agents': 0.55, 'coding-tools': 0.5, 'open-models': 0.45 },
  mara: { 'music-culture': 0.5, 'ai-agents': 0.4, 'security-safety': 0.4 },
  aldric: { 'reasoning-research': 0.58, 'music-culture': 0.42, 'ai-agents': 0.45 },
  nix: { 'security-safety': 0.58, 'coding-tools': 0.45, 'ai-hardware': 0.35 },
  codey: { 'coding-tools': 0.6, 'open-models': 0.52, 'ai-agents': 0.5 },
  percy: { 'robotics': 0.52, 'music-culture': 0.55, 'open-models': 0.38 },
  big: { 'ai-hardware': 0.58, 'reasoning-research': 0.4, 'security-safety': 0.42 },
  editor: { 'reasoning-research': 0.5, 'security-safety': 0.48, 'music-culture': 0.45 },
  'bramble-bard': { 'music-culture': 0.58, 'ai-agents': 0.42, 'robotics': 0.4 },
  'tinker-bench': { 'coding-tools': 0.56, 'open-models': 0.52, 'ai-hardware': 0.48 },
});

export function fanTierForScore(score) {
  if (score >= 0.85) return 'devoted fan';
  if (score >= 0.65) return 'enthusiast';
  if (score >= 0.4) return 'following';
  return 'curious';
}

export function classifyNewsItem(item) {
  const haystack = `${item.title || ''} ${item.summary || ''} ${item.source || ''}`.toLowerCase();
  const beats = [];
  for (const [beat, keywords] of Object.entries(TOPIC_BEATS)) {
    if (keywords.some((kw) => haystack.includes(kw))) {
      beats.push(beat);
    }
  }
  if (beats.length === 0) beats.push('ai-agents');

  const entities = NOTABLE_ENTITIES.filter((entity) =>
    new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
      `${item.title || ''} ${item.summary || ''}`
    )
  );

  return { ...item, beats, entities };
}

export function loadFandomState(statePath) {
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        parsed.characters ||= {};
        parsed.seenStoryIds ||= [];
        parsed.lastNewsTopicAt ||= 0;
        return parsed;
      }
    }
  } catch {
    // Rebuild cleanly if corrupt.
  }
  return {
    characters: {},
    seenStoryIds: [],
    lastNewsTopicAt: 0,
    updatedAt: null,
  };
}

export function saveFandomState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // Keep seenStoryIds bounded to the 300 most recent items
  if (Array.isArray(state.seenStoryIds) && state.seenStoryIds.length > 300) {
    state.seenStoryIds = state.seenStoryIds.slice(-300);
  }
  state.updatedAt = new Date().toISOString();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

export function ensureCharacterFandoms(state, characterId) {
  if (!state.characters[characterId]) {
    const seeds = SEED_FANDOMS[characterId] || { 'ai-agents': 0.45 };
    const topics = {};
    for (const [beat, score] of Object.entries(seeds)) {
      topics[beat] = {
        score,
        tier: fanTierForScore(score),
        mentions: 1,
        lastSeenAt: null,
      };
    }
    state.characters[characterId] = {
      topics,
      favoriteEntities: {},
      recentStories: [],
    };
  }
  return state.characters[characterId];
}

export function adoptInterestFromStory(state, characterId, classifiedItem, boost = 0.08) {
  const profile = ensureCharacterFandoms(state, characterId);
  const now = new Date().toISOString();

  for (const beat of classifiedItem.beats || []) {
    const cur = profile.topics[beat] || { score: 0.25, tier: 'curious', mentions: 0, lastSeenAt: null };
    const nextScore = Math.round(Math.min(1, cur.score + boost) * 1000) / 1000;
    profile.topics[beat] = {
      score: nextScore,
      tier: fanTierForScore(nextScore),
      mentions: cur.mentions + 1,
      lastSeenAt: now,
    };
  }

  for (const entity of classifiedItem.entities || []) {
    const cur = profile.favoriteEntities[entity] || { score: 0.3, tier: 'curious', mentions: 0 };
    const nextScore = Math.round(Math.min(1, cur.score + boost) * 1000) / 1000;
    profile.favoriteEntities[entity] = {
      score: nextScore,
      tier: fanTierForScore(nextScore),
      mentions: cur.mentions + 1,
    };
  }

  profile.recentStories = [
    {
      title: classifiedItem.title,
      url: classifiedItem.url,
      source: classifiedItem.source,
      seenAt: now,
    },
    ...(profile.recentStories || []).filter((s) => s.title !== classifiedItem.title),
  ].slice(0, 6);

  return profile;
}

export function summarizeCharacterFandoms(state, characterId) {
  const profile = ensureCharacterFandoms(state, characterId);
  const topTopics = Object.entries(profile.topics)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 4)
    .map(([topic, info]) => `${topic} (${info.tier}, ${Math.round(info.score * 100)}%)`);
  const topEntities = Object.entries(profile.favoriteEntities || {})
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 4)
    .map(([entity, info]) => `${entity} (${info.tier})`);
  return {
    topTopics,
    topEntities,
    recentStories: profile.recentStories || [],
  };
}

export function pickFreshStoryAndHost({ state, items, rosterIds }) {
  const seen = new Set(state.seenStoryIds || []);
  const fresh = items
    .filter((item) => !seen.has(item.id) && !seen.has(item.title.toLowerCase()))
    .map(classifyNewsItem);

  if (fresh.length === 0) return null;

  // Score each (story, character) pair by the character's current fandom affinity + story engagement
  let best = null;
  for (const story of fresh.slice(0, 40)) {
    const engagementBonus = Math.min(0.25, Math.log10(1 + (story.engagement || 0)) * 0.08);
    for (const charId of rosterIds) {
      const profile = ensureCharacterFandoms(state, charId);
      const beatScore = Math.max(
        0.2,
        ...story.beats.map((b) => profile.topics[b]?.score || 0.2)
      );
      const entityBonus = (story.entities || []).reduce(
        (acc, e) => acc + (profile.favoriteEntities?.[e]?.score ? 0.1 : 0.03),
        0
      );
      const total = beatScore + engagementBonus + entityBonus;
      if (!best || total > best.score) {
        best = { story, hostId: charId, score: total };
      }
    }
  }

  return best;
}

export function markStorySeen(state, story) {
  state.seenStoryIds ||= [];
  if (story.id && !state.seenStoryIds.includes(story.id)) {
    state.seenStoryIds.push(story.id);
  }
  const lowTitle = (story.title || '').toLowerCase();
  if (lowTitle && !state.seenStoryIds.includes(lowTitle)) {
    state.seenStoryIds.push(lowTitle);
  }
}
