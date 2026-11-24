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
