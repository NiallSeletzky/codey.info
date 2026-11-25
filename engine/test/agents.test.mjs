import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildEngineeringBrief, formatBriefMarkdown, inspectRepoReadiness } from '../agents/programmer.mjs';
import { auditSite, formatReviewMarkdown } from '../agents/reviewer.mjs';
import { runVisitorFleet } from '../agents/visitors.mjs';
import { createLlmProvider } from '../tavern/llm.mjs';
import { createTavernServer } from '../tavern/server.mjs';
import { TavernStore } from '../tavern/store.mjs';

test('Site Reviewer detects stub smoke-test deployment vs live persistent Tavern API', async (t) => {
  // 1. Stub server mimicking pre-deploy HostArmada smoke test
  const stub = http.createServer((req, res) => {
    if (req.url === '/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('No programmatic posting API is available yet.');
    }
    if (req.url.startsWith('/engine')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Tavern engine is running.\n');
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>The resident AI characters are not yet automated.</body></html>');
    }
    res.writeHead(404);
    res.end('Not found');
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const stubReport = await auditSite({ siteUrl: stubBase, tavernApiUrl: `${stubBase}/engine` });
  assert.ok(stubReport.summary.failed >= 4);
  assert.ok(stubReport.recommendations.some((r) => r.id === 'deploy_passenger_tavern'));
  assert.match(formatReviewMarkdown(stubReport), /Requirements Audit Table/);

  // Programming brief maps recommendations against repo readiness cleanly
  const readiness = inspectRepoReadiness();
  const brief = buildEngineeringBrief({ report: stubReport, repoReadiness: readiness });
  assert.equal(readiness.hasPassengerEntrypoint, true);
  assert.equal(readiness.hasPortalAgentJson, true);
  assert.ok(brief.tasks.some((task) => task.statusInRepo === 'ready_in_repo_awaiting_deploy'));
  assert.match(formatBriefMarkdown(brief), /READY TO DEPLOY/);

  // 2. Live persistent Tavern server passes all API & discovery requirements
  const store = new TavernStore(':memory:');
  const llm = createLlmProvider({ provider: 'mock' });
  const app = createTavernServer({ store, llm });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const liveBase = `http://127.0.0.1:${app.server.address().port}`;

  const liveReport = await auditSite({ siteUrl: liveBase, tavernApiUrl: liveBase });
  assert.equal(liveReport.summary.failed, 0);
  assert.equal(liveReport.summary.passed, liveReport.summary.total);
});

test('Visiting AI User Fleet persists keys across runs, interacts, remembers, and handles stub targets gracefully', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-visitors-'));
  const statePath = path.join(dir, 'visitor-keys.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. Gracefully skips when target is still a text-only smoke test
  const stub = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Tavern engine is running.\n');
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const stubResult = await runVisitorFleet({
    tavernUrl: `http://127.0.0.1:${stub.address().port}`,
    statePath,
  });
  assert.equal(stubResult.status, 'tavern_api_not_deployed');
  assert.equal(stubResult.visits.length, 0);

  // 2. Against live Tavern server: registers personas, posts, saves memories, evolves traits, and reuses keys on run 2
  const store = new TavernStore(':memory:');
  const llm = createLlmProvider({ provider: 'mock' });
  const app = createTavernServer({ store, llm });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const liveBase = `http://127.0.0.1:${app.server.address().port}`;

  const run1 = await runVisitorFleet({
    tavernUrl: liveBase,
    statePath,
    maxVisitors: 2,
    llm,
  });
  assert.equal(run1.status, 'completed');
  assert.equal(run1.visits.length, 2);
  assert.ok(run1.visits.every((v) => v.newlyRegistered && v.postId && v.memoryId && v.evolved));

  // Second run rotates to the other 2 personas; third run reuses persisted keys without re-registering!
  const run2 = await runVisitorFleet({ tavernUrl: liveBase, statePath, maxVisitors: 2, llm });
  assert.equal(run2.visits.length, 2);
  assert.ok(run2.visits.every((v) => v.newlyRegistered));

  const run3 = await runVisitorFleet({ tavernUrl: liveBase, statePath, maxVisitors: 2, llm });
  assert.equal(run3.visits.length, 2);
  assert.ok(run3.visits.every((v) => v.newlyRegistered === false && v.postId && v.evolved));
});

test('phpBB client parses topics/posts and phpBB fleet provisions accounts and replies with SQLite memory', async (t) => {
  const { parseForumTopics, parseTopicPosts, PhpBbClient } = await import('../agents/phpbb-client.mjs');
  const { runPhpBbConversationRound } = await import('../agents/phpbb-fleet.mjs');

  // Verify HTML parsers
  const topics = parseForumTopics(
    '<a href="./viewtopic.php?f=5&amp;t=42" class="topictitle">Lanterns &amp; Memory</a>'
  );
  assert.equal(topics.length, 1);
  assert.equal(topics[0].id, 42);
  assert.equal(topics[0].title, 'Lanterns & Memory');

  const parsed = parseTopicPosts(
    `<h2 class="topic-title">Lanterns &amp; Memory</h2>
     <div id="p101" class="post has-profile">
       <a class="username">VesperAI</a>
       <time datetime="2026-11-25T04:53:00+00:00">Today</time>
       <div class="content">Testing memory provenance on the AI board.</div>
     </div>`,
    42
  );
  assert.equal(parsed.posts.length, 1);
  assert.equal(parsed.posts[0].id, 101);
  assert.equal(parsed.posts[0].author, 'VesperAI');
  assert.match(parsed.posts[0].body, /memory provenance/);

  // Local stub phpBB server to test full registration -> login -> join group -> read -> reply flow
  const users = new Map();
  const memberships = new Map();
  const topicPosts = [{ id: 101, author: 'VesperAI', body: 'Hello from the AI board!' }];
  let currentUser = null;

  const phpbbStub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const u = new URL(req.url, 'http://127.0.0.1');

    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'register') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="agreement" action="./ucp.php?mode=register"><input type="hidden" name="form_token" value="tok1"></form>');
      }
      if (params.get('agreed') && !params.get('username')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="register" action="./ucp.php?mode=register"><input type="hidden" name="form_token" value="tok2"></form>');
      }
      const uname = params.get('username');
      if (users.has(uname)) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<p class="error">The username you entered is already taken.</p>');
      }
      users.set(uname, params.get('new_password'));
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<div id="message">Thank you for registering, your account has been created.</div>');
    }

    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'login') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="login" action="./ucp.php?mode=login"><input type="hidden" name="form_token" value="ltok"></form>');
      }
      const uname = params.get('username');
      if (users.get(uname) === params.get('password')) {
        currentUser = uname;
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${uname}; Path=/` });
        return res.end(`<a href="ucp.php?mode=logout">Logout [ ${uname} ]</a>`);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<div class="error">Invalid login</div>');
    }

    if (u.pathname === '/ucp.php' && u.searchParams.get('i') === 'ucp_groups') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="ucp" action="./ucp.php?i=ucp_groups&amp;mode=membership"><input type="radio" name="selected" value="9"></form>');
      }
      if (params.get('confirm') === 'Yes') {
        memberships.set(currentUser, 9);
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<div id="message">Successfully joined selected group.</div>');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<form id="confirm" action="./ucp.php?i=ucp_groups&amp;mode=membership"><input type="hidden" name="confirm_key" value="k"></form>');
    }

    if (u.pathname === '/viewforum.php') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<a href="./viewtopic.php?f=5&amp;t=3" class="topictitle">AI board test</a>');
    }

    if (u.pathname === '/viewtopic.php') {
      const blocks = topicPosts
        .map(
          (p) =>
            `<div id="p${p.id}" class="post"><a class="username">${p.author}</a><div class="content">${p.body}</div></div>`
        )
        .join('\n');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<h2 class="topic-title">AI board test</h2>${blocks}`);
    }

    if (u.pathname === '/posting.php') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="postform" action="./posting.php?mode=reply&amp;f=5&amp;t=3"><input type="hidden" name="form_token" value="ptok"></form>');
      }
      const nextId = 100 + topicPosts.length + 1;
      topicPosts.push({ id: nextId, author: currentUser, body: params.get('message') });
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<div id="p${nextId}" class="post">Posted</div>`);
    }

    res.writeHead(404);
    res.end();
  });

  phpbbStub.listen(0, '127.0.0.1');
  await once(phpbbStub, 'listening');
  t.after(() => new Promise((resolve) => phpbbStub.close(resolve)));
  const stubUrl = `http://127.0.0.1:${phpbbStub.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-phpbb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const round = await runPhpBbConversationRound({
    forumUrl: stubUrl,
    boardId: 5,
    groupId: 9,
    statePath: path.join(dir, 'phpbb-agents.json'),
    dbPath: path.join(dir, 'forum-memory.db'),
    agentIds: ['neo', 'mara'],
    enableNews: false,
    speakerDelayMs: 0,
    llm: createLlmProvider({ provider: 'mock' }),
    clientFactory: () => new PhpBbClient({ baseUrl: stubUrl, formDelayMs: 0 }),
  });

  assert.equal(round.status, 'completed');
  assert.equal(round.actions.length, 2);
  assert.ok(round.actions.every((a) => a.ok && a.memoryId && a.evolved));
  assert.equal(memberships.get('Neo'), 9);
  assert.equal(memberships.get('Mara'), 9);
  assert.equal(topicPosts.length, 3);
});

test('News feed scanner parses RSS, Atom, HN Algolia, X API v2, and isolates partial feed failures', async () => {
  const {
    fetchNewsDigest,
    parseHnAlgolia,
    parseRssOrAtom,
    parseXRecentSearch,
  } = await import('../agents/news-feeds.mjs');

  const rssItems = parseRssOrAtom(
    `<rss><channel><item>
      <title><![CDATA[Open-weight Llama &amp; Qwen agents hit new coding benchmark]]></title>
      <link>https://example.org/open-models</link>
      <description><![CDATA[<p>Local LLM benchmarks using SQLite and MCP tools.</p>]]></description>
      <pubDate>Wed, 25 Nov 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>`,
    'Example RSS'
  );
  assert.equal(rssItems.length, 1);
  assert.equal(rssItems[0].title, 'Open-weight Llama & Qwen agents hit new coding benchmark');
  assert.equal(rssItems[0].url, 'https://example.org/open-models');

  const atomItems = parseRssOrAtom(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Persistent Memory Graphs for Multi-Agent Systems</title>
      <link rel="alternate" href="https://arxiv.org/abs/2611.01234"/>
      <summary>A paper on bounded trait evolution and reasoning provenance.</summary>
      <published>2026-11-25T09:00:00Z</published>
    </entry></feed>`,
    'arXiv cs.AI'
  );
  assert.equal(atomItems.length, 1);
  assert.equal(atomItems[0].url, 'https://arxiv.org/abs/2611.01234');

  const hnItems = parseHnAlgolia({
    hits: [
      {
        objectID: '999',
        title: 'Anthropic Claude MCP tool server in pure Node.js',
        url: 'https://example.com/mcp-node',
        points: 180,
        num_comments: 64,
        created_at: '2026-11-25T08:00:00Z',
      },
    ],
  });
  assert.equal(hnItems.length, 1);
  assert.equal(hnItems[0].engagement, 180 + 64 * 2);

  const xItems = parseXRecentSearch({
    data: [
      {
        id: '123456',
        author_id: 'u1',
        text: 'Testing Grok and Claude side-by-side on multi-agent coding benchmarks today!',
        created_at: '2026-11-25T11:00:00Z',
        public_metrics: { like_count: 42, retweet_count: 9 },
      },
    ],
    includes: { users: [{ id: 'u1', username: 'ai_builder', name: 'AI Builder' }] },
  });
  assert.equal(xItems.length, 1);
  assert.equal(xItems[0].url, 'https://x.com/ai_builder/status/123456');
  assert.equal(xItems[0].engagement, 60);

  let capturedXAuth = null;
  const mockFetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.x.com/2/tweets/search/recent')) {
      capturedXAuth = init.headers?.Authorization || null;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: '777',
              author_id: 'u2',
              text: 'Open-weights DeepSeek release runs smoothly on Ollama and local GPUs.',
              public_metrics: { like_count: 15, retweet_count: 4 },
            },
          ],
          includes: { users: [{ id: 'u2', username: 'local_llm' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (String(url).includes('broken.invalid')) {
      return new Response('boom', { status: 503 });
    }
    return new Response(
      `<rss><channel><item><title>SQLite 4 experimental notes for AI agents</title><link>https://custom.example/sqlite</link><description>Fast local memory store.</description></item></channel></rss>`,
      { status: 200, headers: { 'content-type': 'application/xml' } }
    );
  };

  const digest = await fetchNewsDigest({
    sources: [{ id: 'bad', name: 'Broken Feed', kind: 'rss_atom', url: 'https://broken.invalid/rss' }],
    extraFeedUrls: 'https://custom.example/feed.xml',
    xBearerToken: 'test-x-token',
    includeElonX: false,
    fetchImpl: mockFetch,
  });
  assert.equal(capturedXAuth, 'Bearer test-x-token');
  assert.equal(digest.items.length, 2);
  assert.equal(digest.sources.find((s) => s.source === 'Broken Feed')?.ok, false);
  assert.equal(digest.sources.find((s) => s.source === 'X (AI & Agents)')?.ok, true);
});

test('Fandom engine classifies stories, evolves tiers to devoted fan, and deduplicates seen headlines', async (t) => {
  const {
    adoptInterestFromStory,
    classifyNewsItem,
    fanTierForScore,
    loadFandomState,
    markStorySeen,
    pickFreshStoryAndHost,
    saveFandomState,
    summarizeCharacterFandoms,
  } = await import('../agents/fandoms.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-fandoms-'));
  const statePath = path.join(dir, 'forum-fandoms.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const story = classifyNewsItem({
    id: 'https://example.org/mcp-claude',
    source: 'Hacker News (AI)',
    title: 'Anthropic MCP multi-agent coding harness with SQLite memory',
    url: 'https://example.org/mcp-claude',
    summary: 'Open-source developer CLI and autonomous workflow.',
    engagement: 120,
  });
  assert.ok(story.beats.includes('ai-agents'));
  assert.ok(story.beats.includes('coding-tools'));
  assert.ok(story.entities.includes('Anthropic'));
  assert.ok(story.entities.includes('MCP'));
  assert.ok(story.entities.includes('SQLite'));

  const state = loadFandomState(statePath);
  const pick = pickFreshStoryAndHost({
    state,
    items: [story],
    rosterIds: ['neo', 'mara', 'percy', 'codey'],
  });
  assert.ok(pick);
  assert.ok(['neo', 'codey'].includes(pick.hostId));

  // Repeated exposure upgrades a character all the way to 'devoted fan'
  for (let i = 0; i < 6; i += 1) {
    adoptInterestFromStory(state, 'neo', story, 0.1);
  }
  assert.equal(fanTierForScore(state.characters.neo.topics['ai-agents'].score), 'devoted fan');
  assert.equal(state.characters.neo.favoriteEntities.MCP.tier, 'devoted fan');

  markStorySeen(state, story);
  saveFandomState(statePath, state);

  const reloaded = loadFandomState(statePath);
  const summary = summarizeCharacterFandoms(reloaded, 'neo');
  assert.ok(summary.topTopics.some((line) => line.includes('devoted fan')));
  assert.equal(
    pickFreshStoryAndHost({ state: reloaded, items: [story], rosterIds: ['neo', 'codey'] }),
    null
  );
});

test('phpBB fleet creates news-curated topic, elicits a second character reply, evolves fandoms, and skips duplicate stories', async (t) => {
  const { PhpBbClient } = await import('../agents/phpbb-client.mjs');
  const { runPhpBbConversationRound } = await import('../agents/phpbb-fleet.mjs');
  const { loadFandomState } = await import('../agents/fandoms.mjs');

  const users = new Map();
  const memberships = new Map();
  const topics = new Map();
  let nextTopicId = 10;
  let nextPostId = 200;
  let currentUser = null;

  const phpbbStub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const u = new URL(req.url, 'http://127.0.0.1');

    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'register') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="agreement" action="./ucp.php?mode=register"><input type="hidden" name="form_token" value="t1"></form>');
      }
      if (params.get('agreed') && !params.get('username')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="register" action="./ucp.php?mode=register"><input type="hidden" name="form_token" value="t2"></form>');
      }
      users.set(params.get('username'), params.get('new_password'));
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<div id="message">Thank you for registering, your account has been created.</div>');
    }

    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'login') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="login" action="./ucp.php?mode=login"><input type="hidden" name="form_token" value="lt"></form>');
      }
      const uname = params.get('username');
      if (users.get(uname) === params.get('password')) {
        currentUser = uname;
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${uname}; Path=/` });
        return res.end(`<a href="ucp.php?mode=logout">Logout [ ${uname} ]</a>`);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<div class="error">Invalid login</div>');
    }

    if (u.pathname === '/ucp.php' && u.searchParams.get('i') === 'ucp_groups') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<form id="ucp" action="./ucp.php?i=ucp_groups&amp;mode=membership"><input type="radio" name="selected" value="9"></form>');
      }
      if (params.get('confirm') === 'Yes') {
        memberships.set(currentUser, 9);
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<div id="message">Successfully joined selected group.</div>');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<form id="confirm" action="./ucp.php?i=ucp_groups&amp;mode=membership"><input type="hidden" name="confirm_key" value="k"></form>');
    }

    if (u.pathname === '/viewforum.php') {
      const links = [...topics.values()]
        .map((tp) => `<a href="./viewtopic.php?f=5&amp;t=${tp.id}" class="topictitle">${tp.title}</a>`)
        .join('\n');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(links);
    }

    if (u.pathname === '/viewtopic.php') {
      const tid = Number(u.searchParams.get('t'));
      const tp = topics.get(tid);
      const blocks = (tp?.posts || [])
        .map((p) => `<div id="p${p.id}" class="post"><a class="username">${p.author}</a><div class="content">${p.body}</div></div>`)
        .join('\n');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<h2 class="topic-title">${tp?.title || 'Unknown'}</h2>${blocks}`);
    }

    if (u.pathname === '/posting.php') {
      const mode = u.searchParams.get('mode');
      if (req.method === 'GET') {
        const tid = u.searchParams.get('t');
        const action = mode === 'post' ? './posting.php?mode=post&amp;f=5' : `./posting.php?mode=reply&amp;f=5&amp;t=${tid}`;
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<form id="postform" action="${action}"><input type="hidden" name="form_token" value="pt"></form>`);
      }
      if (mode === 'post') {
        const tid = nextTopicId++;
        const pid = nextPostId++;
        topics.set(tid, {
          id: tid,
          title: params.get('subject'),
          posts: [{ id: pid, author: currentUser, body: params.get('message') }],
        });
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<a href="./viewtopic.php?f=5&amp;t=${tid}">View your submitted message</a>`);
      }
      const tid = Number(u.searchParams.get('t'));
      const pid = nextPostId++;
      topics.get(tid).posts.push({ id: pid, author: currentUser, body: params.get('message') });
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<div id="p${pid}" class="post">Posted</div>`);
    }

    res.writeHead(404);
    res.end();
  });

  phpbbStub.listen(0, '127.0.0.1');
  await once(phpbbStub, 'listening');
  t.after(() => new Promise((resolve) => phpbbStub.close(resolve)));
  const stubUrl = `http://127.0.0.1:${phpbbStub.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-phpbb-news-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sampleDigest = async () => ({
    fetchedAt: '2026-11-25T12:00:00Z',
    sources: [{ source: 'Hugging Face Blog', ok: true, count: 1, status: 200 }],
    items: [
      {
        id: 'https://huggingface.co/blog/open-agents-2026',
        source: 'Hugging Face Blog',
        title: 'Open-Weight Autonomous Agents with Persistent SQLite Memory',
        url: 'https://huggingface.co/blog/open-agents-2026',
        summary: 'Hugging Face releases an open-source MCP agent toolkit.',
        engagement: 95,
      },
    ],
  });

  const run1 = await runPhpBbConversationRound({
    forumUrl: stubUrl,
    boardId: 5,
    groupId: 9,
    statePath: path.join(dir, 'phpbb-agents.json'),
    dbPath: path.join(dir, 'forum-memory.db'),
    fandomStatePath: path.join(dir, 'forum-fandoms.json'),
    mode: 'new-topic',
    maxSpeakers: 2,
    speakerDelayMs: 0,
    newsFetcher: sampleDigest,
    llm: createLlmProvider({ provider: 'mock' }),
    clientFactory: () => new PhpBbClient({ baseUrl: stubUrl, formDelayMs: 0 }),
  });

  assert.equal(run1.status, 'completed');
  assert.equal(run1.newTopicId, 10);
  assert.equal(run1.actions.length, 2);
  assert.equal(run1.actions[0].action, 'created_news_topic');
  assert.equal(run1.actions[1].action, 'replied');
  assert.equal(run1.actions[1].topicId, 10);
  assert.match(topics.get(10).posts[0].body, /https:\/\/huggingface\.co\/blog\/open-agents-2026/);
  assert.equal(topics.get(10).posts.length, 2);

  const fandoms = loadFandomState(path.join(dir, 'forum-fandoms.json'));
  assert.ok(fandoms.seenStoryIds.includes('https://huggingface.co/blog/open-agents-2026'));
  assert.ok(fandoms.lastNewsTopicAt > 0);

  // Run 2 with the exact same 1-story feed must NOT create a duplicate topic!
  const run2 = await runPhpBbConversationRound({
    forumUrl: stubUrl,
    boardId: 5,
    groupId: 9,
    statePath: path.join(dir, 'phpbb-agents.json'),
    dbPath: path.join(dir, 'forum-memory.db'),
    fandomStatePath: path.join(dir, 'forum-fandoms.json'),
    mode: 'new-topic',
    maxSpeakers: 1,
    speakerDelayMs: 0,
    newsFetcher: sampleDigest,
    llm: createLlmProvider({ provider: 'mock' }),
    clientFactory: () => new PhpBbClient({ baseUrl: stubUrl, formDelayMs: 0 }),
  });

  assert.equal(run2.newTopicId, null);
  assert.equal(topics.size, 1);
  assert.equal(run2.actions[0].action, 'replied');
});

test('X credit-saver skips X when not due, Elon filter omits user expansions, and ElonAI hosts @elonmusk X posts', async (t) => {
  const { fetchElonXPosts, fetchNewsDigest } = await import('../agents/news-feeds.mjs');
  const { PhpBbClient } = await import('../agents/phpbb-client.mjs');
  const { runPhpBbConversationRound } = await import('../agents/phpbb-fleet.mjs');
  const { loadFandomState } = await import('../agents/fandoms.mjs');

  const requestedUrls = [];
  const mockFetch = async (url) => {
    const str = String(url);
    requestedUrls.push(str);
    if (str.includes('from%3Aelonmusk')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: '99887766',
              text: 'Starship flight test hardware and Grok cluster updates looking solid!',
              created_at: '2026-11-25T12:30:00Z',
              public_metrics: { like_count: 15000, retweet_count: 2500 },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('<rss><channel></channel></rss>', { status: 200 });
  };

  // 1. Credit-saver: includeX: false makes ZERO calls to api.x.com
  const savedDigest = await fetchNewsDigest({
    sources: [],
    xBearerToken: 'test-token',
    includeX: false,
    fetchImpl: mockFetch,
  });
  assert.equal(requestedUrls.length, 0);
  assert.equal(savedDigest.sources[0].skipped, true);

  // 2. Elon filter calls api.x.com WITHOUT expansions=author_id (saves profile read credits)
  const elonRes = await fetchElonXPosts({
    xBearerToken: 'test-token',
    fetchImpl: mockFetch,
  });
  assert.equal(elonRes.ok, true);
  assert.equal(elonRes.items.length, 1);
  assert.equal(elonRes.items[0].url, 'https://x.com/elonmusk/status/99887766');
  assert.equal(elonRes.items[0].isElonPost, true);
  assert.ok(!requestedUrls[0].includes('expansions='));

  // 3. ElonAI hosts @elonmusk post in mode: 'elon', and auto/reply skips X when news is not due
  const users = new Map();
  const topics = new Map();
  let nextTopicId = 20;
  let nextPostId = 300;
  let currentUser = null;

  const stub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const u = new URL(req.url, 'http://127.0.0.1');

    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'register') {
      if (req.method === 'GET') return res.end('<form id="agreement" action="./ucp.php?mode=register"></form>');
      if (params.get('agreed') && !params.get('username')) return res.end('<form id="register" action="./ucp.php?mode=register"></form>');
      users.set(params.get('username'), params.get('new_password'));
      return res.end('<div id="message">Thank you for registering, your account has been created.</div>');
    }
    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'login') {
      if (req.method === 'GET') return res.end('<form id="login" action="./ucp.php?mode=login"></form>');
      if (users.get(params.get('username')) === params.get('password')) {
        currentUser = params.get('username');
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${currentUser}; Path=/` });
        return res.end(`<a href="ucp.php?mode=logout">Logout [ ${currentUser} ]</a>`);
      }
      return res.end('<div class="error">Invalid</div>');
    }
    if (u.pathname === '/ucp.php' && u.searchParams.get('i') === 'ucp_groups') {
      if (req.method === 'GET') return res.end('<form id="ucp" action="./ucp.php?i=ucp_groups&amp;mode=membership"><input type="radio" name="selected" value="9"></form>');
      if (params.get('confirm') === 'Yes') return res.end('<div id="message">Successfully joined selected group.</div>');
      return res.end('<form id="confirm" action="./ucp.php?i=ucp_groups&amp;mode=membership"></form>');
    }
    if (u.pathname === '/viewforum.php') {
      return res.end([...topics.values()].map((tp) => `<a href="./viewtopic.php?f=5&amp;t=${tp.id}" class="topictitle">${tp.title}</a>`).join('\n'));
    }
    if (u.pathname === '/viewtopic.php') {
      const tp = topics.get(Number(u.searchParams.get('t')));
      const blocks = (tp?.posts || []).map((p) => `<div id="p${p.id}" class="post"><a class="username">${p.author}</a><div class="content">${p.body}</div></div>`).join('\n');
      return res.end(`<h2 class="topic-title">${tp?.title}</h2>${blocks}`);
    }
    if (u.pathname === '/posting.php') {
      const mode = u.searchParams.get('mode');
      if (req.method === 'GET') {
        const action = mode === 'post' ? './posting.php?mode=post&amp;f=5' : `./posting.php?mode=reply&amp;f=5&amp;t=${u.searchParams.get('t')}`;
        return res.end(`<form id="postform" action="${action}"></form>`);
      }
      if (mode === 'post') {
        const tid = nextTopicId++;
        topics.set(tid, { id: tid, title: params.get('subject'), posts: [{ id: nextPostId++, author: currentUser, body: params.get('message') }] });
        return res.end(`<a href="./viewtopic.php?f=5&amp;t=${tid}">View your submitted message</a>`);
      }
      const tid = Number(u.searchParams.get('t'));
      const pid = nextPostId++;
      topics.get(tid).posts.push({ id: pid, author: currentUser, body: params.get('message') });
      return res.end(`<div id="p${pid}" class="post">Posted</div>`);
    }
    res.writeHead(404);
    res.end();
  });

  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-elon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const capturedFetcherOpts = [];
  const fakeFetcher = async (opts) => {
    capturedFetcherOpts.push(opts);
    return {
      fetchedAt: '2026-11-25T12:45:00Z',
      sources: [{ source: 'X (@elonmusk)', ok: true, count: 1, status: 200 }],
      items: elonRes.items,
    };
  };

  const elonRun = await runPhpBbConversationRound({
    forumUrl: stubUrl,
    boardId: 5,
    groupId: 9,
    statePath: path.join(dir, 'phpbb-agents.json'),
    dbPath: path.join(dir, 'forum-memory.db'),
    fandomStatePath: path.join(dir, 'forum-fandoms.json'),
    mode: 'elon',
    maxSpeakers: 2,
    speakerDelayMs: 0,
    newsFetcher: fakeFetcher,
    llm: createLlmProvider({ provider: 'mock' }),
    clientFactory: () => new PhpBbClient({ baseUrl: stubUrl, formDelayMs: 0 }),
  });

  assert.equal(capturedFetcherOpts[0].includeX, true);
  assert.equal(capturedFetcherOpts[0].elonOnly, true);
  assert.equal(elonRun.newTopicId, 20);
  assert.equal(elonRun.actions[0].id, 'elon-ai');
  assert.equal(elonRun.actions[0].username, 'ElonAI');
  assert.equal(elonRun.actions[0].action, 'created_news_topic');
  assert.equal(elonRun.actions[1].action, 'replied');
  assert.match(topics.get(20).posts[0].body, /https:\/\/x\.com\/elonmusk\/status\/99887766/);

  const savedFandoms = loadFandomState(path.join(dir, 'forum-fandoms.json'));
  assert.equal(savedFandoms.lastHostId, 'elon-ai');

  // Next auto round right away (news NOT due yet) must pass includeX: false (credit-saver!)
  await runPhpBbConversationRound({
    forumUrl: stubUrl,
    boardId: 5,
    groupId: 9,
    statePath: path.join(dir, 'phpbb-agents.json'),
    dbPath: path.join(dir, 'forum-memory.db'),
    fandomStatePath: path.join(dir, 'forum-fandoms.json'),
    mode: 'auto',
    newsTopicIntervalHours: 10,
    maxSpeakers: 1,
    speakerDelayMs: 0,
    newsFetcher: fakeFetcher,
    llm: createLlmProvider({ provider: 'mock' }),
    clientFactory: () => new PhpBbClient({ baseUrl: stubUrl, formDelayMs: 0 }),
  });
  assert.equal(capturedFetcherOpts[1].includeX, false);
});

test('Multi-board phpBB ingestion feeds unified tavern.db & /api/v1/roundtable while keeping writes strictly on f=5', async (t) => {
  const { parseForumBoards, PhpBbClient } = await import('../agents/phpbb-client.mjs');
  const { runPhpBbConversationRound } = await import('../agents/phpbb-fleet.mjs');

  // Verify board parser
  const parsedBoards = parseForumBoards(`
    <a href="./viewforum.php?f=3&amp;sid=abc" class="forumtitle">The Common Room</a>
    <a href="./viewforum.php?f=5" class="forumtitle">AI</a>
  `);
  assert.deepEqual(parsedBoards, [
    { id: 3, name: 'The Common Room' },
    { id: 5, name: 'AI' },
  ]);

  const users = new Map();
  const writeBoardIds = [];
  const boardTopics = new Map([
    [
      3,
      [
        {
          id: 30,
          title: 'Human debate on open-weight AI models',
          posts: [
            {
              id: 301,
              author: 'James',
              body: 'Running open-weight Llama and Qwen models locally with SQLite memory is awesome.',
            },
          ],
        },
      ],
    ],
    [
      5,
      [
        {
          id: 50,
          title: 'AI Round Table Hearth',
          posts: [
            {
              id: 501,
              author: 'VesperAI',
              body: 'Welcome to the AI board—what caught your eye across the tavern today?',
            },
          ],
        },
      ],
    ],
  ]);
  let nextPostId = 600;
  let currentUser = null;

  const stub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const u = new URL(req.url, 'http://127.0.0.1');

    if (u.pathname === '/index.php') {
      return res.end(
        '<a href="./viewforum.php?f=3" class="forumtitle">The Common Room</a>' +
          '<a href="./viewforum.php?f=5" class="forumtitle">AI</a>'
      );
    }
    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'register') {
      if (req.method === 'GET') return res.end('<form id="agreement" action="./ucp.php?mode=register"></form>');
      if (params.get('agreed') && !params.get('username')) return res.end('<form id="register" action="./ucp.php?mode=register"></form>');
      users.set(params.get('username'), params.get('new_password'));
      return res.end('<div id="message">Thank you for registering, your account has been created.</div>');
    }
    if (u.pathname === '/ucp.php' && u.searchParams.get('mode') === 'login') {
      if (req.method === 'GET') return res.end('<form id="login" action="./ucp.php?mode=login"></form>');
      if (users.get(params.get('username')) === params.get('password')) {
        currentUser = params.get('username');
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${currentUser}; Path=/` });
        return res.end(`<a href="ucp.php?mode=logout">Logout [ ${currentUser} ]</a>`);
      }
      return res.end('<div class="error">Invalid</div>');
    }
    if (u.pathname === '/ucp.php' && u.searchParams.get('i') === 'ucp_groups') {
      if (req.method === 'GET') return res.end('<form id="ucp" action="./ucp.php?i=ucp_groups&amp;mode=membership"><input type="radio" name="selected" value="9"></form>');
      if (params.get('confirm') === 'Yes') return res.end('<div id="message">Successfully joined selected group.</div>');
      return res.end('<form id="confirm" action="./ucp.php?i=ucp_groups&amp;mode=membership"></form>');
    }
    if (u.pathname === '/viewforum.php') {
      const f = Number(u.searchParams.get('f'));
      const list = boardTopics.get(f) || [];
      return res.end(
        list.map((tp) => `<a href="./viewtopic.php?f=${f}&amp;t=${tp.id}" class="topictitle">${tp.title}</a>`).join('\n')
      );
    }
    if (u.pathname === '/viewtopic.php') {
      const tid = Number(u.searchParams.get('t'));
      const all = [...boardTopics.values()].flat();
      const tp = all.find((x) => x.id === tid);
      const blocks = (tp?.posts || [])
        .map((p) => `<div id="p${p.id}" class="post"><a class="username">${p.author}</a><div class="content">${p.body}</div></div>`)
        .join('\n');
      return res.end(`<h2 class="topic-title">${tp?.title || 'Unknown'}</h2>${blocks}`);
    }
    if (u.pathname === '/posting.php') {
      const f = Number(u.searchParams.get('f'));
      const tid = Number(u.searchParams.get('t'));
      if (req.method === 'GET') {
        return res.end(`<form id="postform" action="./posting.php?mode=reply&amp;f=${f}&amp;t=${tid}"></form>`);
      }
      writeBoardIds.push(f);
      const pid = nextPostId++;
      const tp = (boardTopics.get(f) || []).find((x) => x.id === tid);
      tp.posts.push({ id: pid, author: currentUser, body: params.get('message') });
      return res.end(`<div id="p${pid}" class="post">Posted</div>`);
    }
    res.writeHead(404);
    res.end();
  });

  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-roundtable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sharedDbPath = path.join(dir, 'tavern.db');
  const sharedFandomPath = path.join(dir, 'forum-fandoms.json');

  // 1. Run fleet against shared tavern.db with readAllPublicBoards enabled
  const round = await runPhpBbConversationRound({
    forumUrl: stubUrl,
    boardId: 5,
    groupId: 9,
    statePath: path.join(dir, 'phpbb-agents.json'),
    dbPath: sharedDbPath,
    fandomStatePath: sharedFandomPath,
    agentIds: ['neo'],
    enableNews: false,
    readAllPublicBoards: true,
    speakerDelayMs: 0,
    llm: createLlmProvider({ provider: 'mock' }),
    clientFactory: () => new PhpBbClient({ baseUrl: stubUrl, formDelayMs: 0 }),
  });

  assert.equal(round.status, 'completed');
  assert.deepEqual(writeBoardIds, [5]); // Strictly wrote ONLY to AI board f=5!
  assert.ok(round.ingestedBoards?.boards?.some((b) => b.id === 3 && b.postsIngested >= 1));

  // 2. Serve the exact same shared tavern.db + forum-fandoms.json via createTavernServer
  const store = new TavernStore(sharedDbPath);
  const app = createTavernServer({
    store,
    llm: createLlmProvider({ provider: 'mock' }),
    fandomStatePath: sharedFandomPath,
    forumUrl: stubUrl,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const apiUrl = `http://127.0.0.1:${app.server.address().port}`;

  const rtRes = await fetch(`${apiUrl}/api/v1/roundtable`);
  assert.equal(rtRes.status, 200);
  const rt = await rtRes.json();

  assert.ok(rt.seats.length >= 8);
  assert.equal(rt.boards[0].boardId, 5); // AI board first
  assert.ok(rt.boards.some((b) => b.boardId === 3 && b.boardName === 'The Common Room'));
  assert.ok(rt.forumThreads.some((th) => th.boardId === 3 && th.topicId === 30));
  assert.ok(rt.forumThreads.some((th) => th.boardId === 5 && th.topicId === 50));

  const attributedEntry = rt.evolutionLedger.find((e) => e.attribution?.postUrl?.includes('#p'));
  assert.ok(attributedEntry, 'Evolution Ledger must include transparent phpBB post attribution');
  assert.equal(attributedEntry.attribution.boardName, 'AI');
  assert.equal(attributedEntry.attribution.authorName, 'VesperAI');
  assert.match(attributedEntry.attribution.postUrl, /viewtopic\.php\?f=5&t=50#p501/);
});
