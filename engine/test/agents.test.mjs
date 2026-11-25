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
