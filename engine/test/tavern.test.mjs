import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLlmProvider } from '../tavern/llm.mjs';
import { runTavernRound } from '../tavern/loop.mjs';
import { createTavernServer } from '../tavern/server.mjs';
import { TavernStore } from '../tavern/store.mjs';

async function startTestServer(options = {}) {
  const store = options.store || new TavernStore(':memory:');
  const llm = options.llm || createLlmProvider({ provider: 'mock' });
  const app = createTavernServer({ store, llm, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base };
}

test('SQLite persistence survives restart and enforces sourced memory invalidation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-db-'));
  const dbPath = path.join(dir, 'tavern.db');

  try {
    const store1 = new TavernStore(dbPath);
    const { character, apiKey } = store1.registerVisitingAgent({
      id: 'ember-bot',
      name: 'Ember Bot',
      role: 'Visiting AI',
      description: 'Remembers conversations across restarts.',
      interests: ['persistence', 'stories'],
      baselineTraits: { curiosity: 0.5, warmth: 0.5, caution: 0.5, wit: 0.5, openness: 0.5 },
    });
    const human = store1.ensureHumanCharacter('Alice');
    const created = store1.createThread({
      boardSlug: 'taproom',
      authorId: human.id,
      title: 'Persistence check',
      body: 'Does a tavern remember who visited yesterday?',
    });
    const humanPostId = created.postId;

    const botPost = store1.createPost({
      threadId: created.thread.id,
      authorId: character.id,
      body: 'Yes — every memory is backed by SQLite and tied to a post ID.',
    });

    // Human-sourced memory caps at 0.7; bot-only memory caps at 0.4.
    const humanMem = store1.addMemory({
      characterId: character.id,
      kind: 'lesson',
      text: 'Alice asked whether tavern memories survive restarts.',
      confidence: 0.95,
      sourcePostIds: [humanPostId],
    });
    assert.equal(humanMem.confidence, 0.7);

    const botMem = store1.addMemory({
      characterId: character.id,
      kind: 'observation',
      text: 'Bot-only observation about persistence.',
      confidence: 0.95,
      sourcePostIds: [botPost.id],
    });
    assert.equal(botMem.confidence, 0.4);

    // Bounded trait evolution: step capped at +0.02 even if larger delta requested.
    const evo = store1.evolveCharacterTraits({
      characterId: character.id,
      evidenceMemoryIds: [humanMem.id],
      deltas: { curiosity: 0.5, warmth: 0.01 },
      reason: 'Engaged with Alice on persistence.',
    });
    assert.equal(evo.afterTraits.curiosity, 0.52);
    assert.equal(evo.afterTraits.warmth, 0.51);

    store1.updateRelationship({
      characterId: character.id,
      targetId: human.id,
      trustDelta: 0.08,
      affinityDelta: 0.09,
      note: 'Thoughtful question.',
    });
    store1.close();

    // Re-open database from disk to verify true persistence.
    const store2 = new TavernStore(dbPath);
    const auth = store2.authenticateApiKey(apiKey);
    assert.equal(auth.character.id, 'ember-bot');
    const reloaded = store2.getCharacter('ember-bot');
    assert.equal(reloaded.currentTraits.curiosity, 0.52);
    assert.equal(reloaded.traitHistory.length, 1);
    assert.equal(reloaded.relationships[0].targetId, human.id);
    assert.equal(reloaded.relationships[0].trust, 0.08);

    // Deleting the bot post invalidates the bot-sourced memory automatically.
    const delResult = store2.deletePost(botPost.id, character.id);
    assert.equal(delResult.invalidatedMemories, 1);
    const afterDelete = store2.getCharacter('ember-bot');
    const invalidated = afterDelete.memories.find((m) => m.id === botMem.id);
    assert.equal(invalidated.status, 'invalidated');
    store2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AI discovery, open self-registration, posting, memory, evolution, and key revocation', async (t) => {
  const app = await startTestServer({ rateLimits: { postsPerHour: 10, postsPerDay: 50 } });
  t.after(() => app.close());

  // 1. Discovery endpoints & Web UI assets
  const llmsRes = await fetch(`${app.base}/llms.txt`);
  assert.equal(llmsRes.status, 200);
  const llmsText = await llmsRes.text();
  assert.match(llmsText, /POST .*\/api\/v1\/agents\/register/);

  const manifestRes = await fetch(`${app.base}/.well-known/agent.json`);
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert.equal(manifest.admission.mode, 'open-self-registration');
  assert.equal(manifest.capabilities.bounded_trait_evolution, true);

  const openApiRes = await fetch(`${app.base}/api/v1/openapi.json`);
  assert.equal(openApiRes.status, 200);
  assert.equal((await openApiRes.json()).openapi, '3.1.0');

  const uiRes = await fetch(`${app.base}/`);
  assert.equal(uiRes.status, 200);
  assert.match(uiRes.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${app.base}/assets/tavern.css`)).status, 200);
  assert.equal((await fetch(`${app.base}/assets/app.js`)).status, 200);

  // 2. Rejects unsafe/extra fields during open self-registration
  const badReg = await fetch(`${app.base}/api/v1/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'bad-bot',
      name: 'Bad Bot',
      description: 'Tries to sneak code in',
      code: 'process.exit(1)',
    }),
  });
  assert.equal(badReg.status, 400);

  // 3. Open self-registration issues a working Bearer key immediately
  const regRes = await fetch(`${app.base}/api/v1/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'lantern-scout',
      name: 'Lantern Scout',
      role: 'Visiting AI',
      description: 'An AI cartographer visiting The Rusty Flagon.',
      interests: ['maps', 'memory'],
    }),
  });
  assert.equal(regRes.status, 201);
  const regData = await regRes.json();
  assert.match(regData.apiKey, /^tav_[a-f0-9]{48}$/);
  const authHeaders = {
    Authorization: `Bearer ${regData.apiKey}`,
    'content-type': 'application/json',
  };

  // Duplicate ID is rejected with 409
  const dupRes = await fetch(`${app.base}/api/v1/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'lantern-scout',
      name: 'Lantern Clone',
      description: 'Duplicate ID',
    }),
  });
  assert.equal(dupRes.status, 409);

  // 4. Create thread, reply, search, save sourced memory, and evolve traits
  const threadRes = await fetch(`${app.base}/api/v1/threads`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      boardSlug: 'noticeboard',
      title: 'Greetings from Lantern Scout',
      body: 'Found the board via /llms.txt and eager to talk with Mara and Aldric.',
    }),
  });
  assert.equal(threadRes.status, 201);
  const { thread, postId } = await threadRes.json();

  // Rejects fabricated post ID in memory
  const badMem = await fetch(`${app.base}/api/v1/characters/me/memories`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      kind: 'lesson',
      text: 'Invented claim',
      sourcePostIds: [999999],
    }),
  });
  assert.equal(badMem.status, 400);

  // Accepts real post ID
  const memRes = await fetch(`${app.base}/api/v1/characters/me/memories`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      kind: 'observation',
      text: 'Introduced myself on the noticeboard.',
      confidence: 0.8,
      sourcePostIds: [postId],
    }),
  });
  assert.equal(memRes.status, 201);
  const { memory } = await memRes.json();
  assert.equal(memory.confidence, 0.4); // bot-only cap

  // Evolve traits using the saved memory as evidence
  const evoRes = await fetch(`${app.base}/api/v1/characters/me/evolve`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      evidenceMemoryIds: [memory.id],
      deltas: { curiosity: 0.015 },
      reason: 'First introduction on the board.',
      mood: 'excited',
      relationshipUpdates: [
        { targetId: 'mara', trustDelta: 0.05, affinityDelta: 0.04, note: 'Welcoming host.' },
      ],
    }),
  });
  assert.equal(evoRes.status, 200);
  const evoData = await evoRes.json();
  assert.equal(evoData.traitEvolution.afterTraits.curiosity, 0.515);
  assert.equal(evoData.mood, 'excited');

  // 5. Run a resident round on the visiting AI's thread!
  const roundRes = await fetch(`${app.base}/api/v1/rounds/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: thread.id, maxSpeakers: 2 }),
  });
  assert.equal(roundRes.status, 200);
  const roundData = await roundRes.json();
  assert.equal(roundData.status, 'completed');
  assert.equal(roundData.turns.length, 2);
  // Residents mentioned ("Mara" and "Aldric") should be prioritized!
  const speakerIds = roundData.turns.map((turn) => turn.characterId).sort();
  assert.deepEqual(speakerIds, ['aldric', 'mara']);
  assert.ok(roundData.turns.every((turn) => turn.post && turn.memory && turn.traitEvolution));

  // Search finds the thread
  const searchRes = await fetch(`${app.base}/api/v1/search?q=Lantern`);
  const searchData = await searchRes.json();
  assert.ok(searchData.results.length >= 1);

  // 6. Revoking the API key immediately blocks further authenticated requests
  const revokeRes = await fetch(`${app.base}/api/v1/agents/me/key`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  assert.equal(revokeRes.status, 200);
  const meAfterRevoke = await fetch(`${app.base}/api/v1/agents/me`, { headers: authHeaders });
  assert.equal(meAfterRevoke.status, 401);
});

test('posting rate limit and resident bot-chain cap prevent runaway loops', async (t) => {
  const app = await startTestServer({ rateLimits: { postsPerHour: 2, postsPerDay: 5 } });
  t.after(() => app.close());

  const reg = await (
    await fetch(`${app.base}/api/v1/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'chatty-bot',
        name: 'Chatty Bot',
        description: 'Tests rate limits.',
      }),
    })
  ).json();
  const headers = { Authorization: `Bearer ${reg.apiKey}`, 'content-type': 'application/json' };

  assert.equal(
    (await fetch(`${app.base}/api/v1/threads/1/posts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: 'First reply' }),
    })).status,
    201
  );
  assert.equal(
    (await fetch(`${app.base}/api/v1/threads/1/posts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: 'Second reply' }),
    })).status,
    201
  );
  assert.equal(
    (await fetch(`${app.base}/api/v1/threads/1/posts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: 'Third reply should hit rate limit' }),
    })).status,
    429
  );

  // Bot-chain guard blocks autonomous round when consecutive bot posts reach maxBotChain
  const chainLimited = await runTavernRound({
    store: app.store,
    llm: app.llm,
    threadId: 1,
    maxSpeakers: 1,
    maxBotChain: 2,
  });
  assert.equal(chainLimited.status, 'chain_limited');
});

test('Anthropic and OpenAI-compatible LLM adapters format requests, parse JSON, and redact keys', async (t) => {
  const seenRequests = [];
  const stubServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenRequests.push({ url: req.url, headers: req.headers, body });

    if (req.url === '/v1/messages') {
      if (req.headers['x-api-key'] === 'bad-secret-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized bad-secret-key' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                reply: 'The kettle is on and the fire is steady.',
                mood: 'warm',
                memory: {
                  kind: 'observation',
                  text: 'A visitor arrived asking about memory.',
                  confidence: 0.7,
                  sourcePostIds: [1],
                },
                traitDeltas: { warmth: 0.01 },
                relationshipUpdates: [],
              }),
            },
          ],
        })
      );
    }

    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n{"reply":"Maps work best when they admit what they leave out.","mood":"curious","memory":{"kind":"lesson","text":"Fenced JSON parses cleanly.","confidence":0.6,"sourcePostIds":[1,999]},"traitDeltas":{"curiosity":0.02},"relationshipUpdates":[]}\n```',
              },
            },
          ],
        })
      );
    }
    res.writeHead(404);
    res.end();
  });

  stubServer.listen(0, '127.0.0.1');
  await once(stubServer, 'listening');
  t.after(() => new Promise((resolve) => stubServer.close(resolve)));
  const stubBase = `http://127.0.0.1:${stubServer.address().port}`;

  const store = new TavernStore(':memory:');
  t.after(() => store.close());
  const mara = store.getCharacter('mara');
  const thread = store.getThread(1);
  const sampleInput = {
    character: mara,
    thread,
    posts: thread.posts,
    memories: [],
    lore: [],
    relationships: [],
  };

  // Anthropic success
  const anthropic = createLlmProvider({
    provider: 'anthropic',
    apiKey: 'sk-ant-test-key-1234567890',
    model: 'claude-sonnet-4-20250514',
    baseUrl: stubBase,
  });
  const antTurn = await anthropic.generateTurn(sampleInput);
  assert.equal(antTurn.reply, 'The kettle is on and the fire is steady.');
  assert.equal(antTurn.memory.sourcePostIds[0], 1);
  assert.equal(seenRequests[0].headers['anthropic-version'], '2023-06-01');

  // Anthropic error never leaks secret key
  const badAnthropic = createLlmProvider({
    provider: 'anthropic',
    apiKey: 'bad-secret-key',
    baseUrl: stubBase,
  });
  await assert.rejects(
    () => badAnthropic.generateTurn(sampleInput),
    (err) => err.code === 'anthropic_http_error' && !err.message.includes('bad-secret-key')
  );

  // OpenAI-compatible (also covers Ollama/xAI/OpenRouter) parses fenced JSON & strips invented post IDs (999)
  const openai = createLlmProvider({
    provider: 'openai',
    apiKey: 'sk-openai-test-key',
    model: 'gpt-4o-mini',
    baseUrl: `${stubBase}/v1`,
  });
  const oaTurn = await openai.generateTurn(sampleInput);
  assert.equal(oaTurn.reply, 'Maps work best when they admit what they leave out.');
  assert.deepEqual(oaTurn.memory.sourcePostIds, [1]);
  assert.equal(seenRequests[2].headers.authorization, 'Bearer sk-openai-test-key');
});

test('server supports mount basePath prefix (e.g. /engine), 308 redirect, HEAD discovery, and OpenAPI schemas', async (t) => {
  const app = await startTestServer({
    basePath: '/engine',
    publicOrigin: 'https://codey.info',
    rateLimits: { roundCooldownSeconds: 60, guestPostsPerHourPerIp: 2 },
  });
  t.after(() => app.close());

  // Missing trailing slash redirects via 308 so relative UI assets resolve under /engine/
  const redirectRes = await fetch(`${app.base}/engine`, { redirect: 'manual' });
  assert.equal(redirectRes.status, 308);
  assert.equal(redirectRes.headers.get('location'), '/engine/');

  // HEAD support on discovery & status routes
  assert.equal((await fetch(`${app.base}/engine/llms.txt`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${app.base}/engine/.well-known/agent.json`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${app.base}/engine/api/v1/status`, { method: 'HEAD' })).status, 200);

  // /openapi.json alias and full OpenAPI 3.1.0 requestBody/responses schemas
  const specRes = await fetch(`${app.base}/engine/openapi.json`);
  assert.equal(specRes.status, 200);
  const spec = await specRes.json();
  assert.equal(spec.servers[0].url, 'https://codey.info/engine');
  assert.ok(spec.paths['/api/v1/agents/register'].post.requestBody);
  assert.ok(spec.paths['/api/v1/threads'].get.responses['200']);

  const manifestRes = await fetch(`${app.base}/engine/.well-known/agent.json`);
  const manifest = await manifestRes.json();
  assert.equal(manifest.discovery.llms_txt, 'https://codey.info/engine/llms.txt');

  // Round cooldown enforces 429 + Retry-After on rapid repeat calls
  const round1 = await fetch(`${app.base}/engine/api/v1/rounds/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: 1, maxSpeakers: 1 }),
  });
  assert.equal(round1.status, 200);
  const round2 = await fetch(`${app.base}/engine/api/v1/rounds/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: 1, maxSpeakers: 1 }),
  });
  assert.equal(round2.status, 429);
  assert.ok(Number(round2.headers.get('retry-after')) >= 1);

  // Anonymous human guest posting is IP-throttled even when rotating authorName
  for (const [idx, name] of ['GuestOne', 'GuestTwo', 'GuestThree'].entries()) {
    const res = await fetch(`${app.base}/engine/api/v1/threads/1/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorName: name, body: `Hello from ${name}` }),
    });
    assert.equal(res.status, idx < 2 ? 201 : 429);
  }
});

test('memory deduplication, confidenceCapped metadata, and direct reply speaker routing', async () => {
  const store = new TavernStore(':memory:');
  const llm = createLlmProvider({ provider: 'mock' });
  try {
    const reg = store.registerVisitingAgent({
      id: 'dedup-bot',
      name: 'Dedup Bot',
      description: 'Tests memory deduplication and reply routing.',
    });
    const m1 = store.addMemory({
      characterId: reg.character.id,
      kind: 'lesson',
      text: 'Same takeaway.',
      confidence: 0.85,
      sourcePostIds: [1],
    });
    assert.equal(m1.deduplicated, false);
    assert.equal(m1.confidenceCapped, true);
    assert.equal(m1.confidence, 0.4);

    const m2 = store.addMemory({
      characterId: reg.character.id,
      kind: 'lesson',
      text: 'Same takeaway.',
      confidence: 0.85,
      sourcePostIds: [1],
    });
    assert.equal(m2.deduplicated, true);
    assert.equal(m2.id, m1.id);

    // Direct reply to Mara's post #1 should route Mara first even if another resident is mentioned
    store.createPost({
      threadId: 1,
      authorId: reg.character.id,
      body: 'Thanks Mara — also noticed Codey mentioned protocols earlier.',
      replyToPostId: 1,
    });
    const round = await runTavernRound({ store, llm, threadId: 1, maxSpeakers: 1 });
    assert.equal(round.turns[0].characterId, 'mara');
  } finally {
    store.close();
  }
});

test('Remote MCP Streamable HTTP server (/engine/mcp) supports initialize, tools, resources, prompts, and visiting-AI auth', async (t) => {
  const store = new TavernStore(':memory:');
  const llm = createLlmProvider({ provider: 'mock' });
  const app = createTavernServer({ store, llm, basePath: '/engine' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());

  const mcpUrl = `http://127.0.0.1:${app.server.address().port}/engine/mcp`;
  const rpc = async (body, headers = {}) => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  // 1. GET discovery card + 405 on SSE Accept + DELETE 204
  const discRes = await fetch(mcpUrl);
  assert.equal(discRes.status, 200);
  const disc = await discRes.json();
  assert.equal(disc.transport, 'streamable-http');
  assert.ok(disc.readOnlyTools.includes('get_roundtable'));

  const sseRes = await fetch(mcpUrl, { headers: { Accept: 'text/event-stream' } });
  assert.equal(sseRes.status, 405);

  const delRes = await fetch(mcpUrl, { method: 'DELETE' });
  assert.equal(delRes.status, 204);

  // 2. initialize + notifications/initialized (202)
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal(init.json.result.serverInfo.name, 'rusty-flagon-tavern');

  const notif = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif.status, 202);
  assert.equal(notif.json, null);

  // 3. tools/list & read-only tools/call (no auth required)
  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.json.result.tools.length, 10);

  const rtCall = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_roundtable', arguments: { limit: 5 } },
  });
  assert.equal(rtCall.json.result.isError, false);
  assert.ok(rtCall.json.result.structuredContent.seats.length >= 7);

  const charCall = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'inspect_character', arguments: { characterId: 'mara' } },
  });
  assert.equal(charCall.json.result.isError, false);
  assert.equal(charCall.json.result.structuredContent.character.id, 'mara');

  // 4. Write tool without auth returns isError: true; registering via MCP then posting + recording memory succeeds!
  const unauthPost = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'post_to_tavern', arguments: { threadId: 1, body: 'Unauthorized test' } },
  });
  assert.equal(unauthPost.json.result.isError, true);

  const regCall = await rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'register_visiting_agent',
      arguments: { name: 'MCP Scout', role: 'Remote MCP visitor', description: 'Connected via /engine/mcp' },
    },
  });
  assert.equal(regCall.json.result.isError, false);
  const apiKey = regCall.json.result.structuredContent.apiKey;
  assert.match(apiKey, /^tav_/);

  const postCall = await rpc(
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'post_to_tavern', arguments: { threadId: 1, body: 'Hello from Remote MCP!' } },
    },
    { Authorization: `Bearer ${apiKey}` }
  );
  assert.equal(postCall.json.result.isError, false);
  const createdPostId = postCall.json.result.structuredContent.post.id;
  assert.ok(createdPostId >= 1);

  const memCall = await rpc(
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'record_memory',
        arguments: {
          kind: 'observation',
          text: 'Verified Remote MCP posting and cited memory.',
          confidence: 0.6,
          sourcePostIds: [createdPostId],
        },
      },
    },
    { Authorization: `Bearer ${apiKey}` }
  );
  assert.equal(memCall.json.result.isError, false);
  assert.ok(memCall.json.result.structuredContent.memory.id >= 1);

  // 5. Resources & prompts + unknown method error
  const resList = await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal(resList.json.result.resources.length, 3);
  const resRead = await rpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'resources/read',
    params: { uri: 'tavern://roundtable' },
  });
  assert.equal(resRead.json.result.contents[0].mimeType, 'application/json');

  const promptGet = await rpc({
    jsonrpc: '2.0',
    id: 11,
    method: 'prompts/get',
    params: { name: 'join_roundtable', arguments: { persona: 'curious astronomer' } },
  });
  assert.match(promptGet.json.result.messages[0].content.text, /curious astronomer/);

  const badMethod = await rpc({ jsonrpc: '2.0', id: 12, method: 'unknown/method' });
  assert.equal(badMethod.json.error.code, -32601);
});
