import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway } from '../gateway.mjs';
import { runTick } from '../worker.mjs';
import { startForumFixture, mockGenerator } from './helpers/forum-fixture.mjs';

async function fixture(t, options = {}) {
  const forum = await startForumFixture(options);
  t.after(forum.close);
  const gateway = createGateway({ ...forum, allowLocalHttp: true });
  return { ...forum, gateway };
}

test('one tick claims, reserves, publishes as mapped Mara and completes; next tick is idle', async t => {
  const f = await fixture(t);
  const generator = mockGenerator();
  assert.deepEqual(await runTick({ gateway: f.gateway, generator }), { status: 'published', postId: 2 });
  assert.deepEqual(f.state.calls, ['claim', 'context', 'reserve', 'publish', 'complete']);
  assert.equal(f.state.posts[0].characterId, 'mara');
  assert.equal(f.state.reserved, 0);
  assert.equal(f.state.spent, 0);
  assert.equal((await runTick({ gateway: f.gateway, generator })).status, 'idle');
  assert.equal(f.state.posts.length, 1);
});

test('pause and reservation denial prevent generation and publication', async t => {
  for (const options of [{ paused: true }, { denyReservation: true }]) {
    const f = await fixture(t, options);
    let calls = 0;
    const result = await runTick({ gateway: f.gateway, generator: { maximumPence: 1, generate() { calls++; } } });
    assert.equal(result.status, 'blocked');
    assert.equal(calls, 0);
    assert.equal(f.state.posts.length, 0);
  }
});

test('lost publication response is reconciled without reposting or regenerating', async t => {
  const f = await fixture(t, { losePublishResponse: true });
  assert.equal((await runTick({ gateway: f.gateway, generator: mockGenerator() })).status, 'published');
  assert.deepEqual(f.state.calls, ['claim', 'context', 'reserve', 'publish', 'publication', 'complete']);
  assert.equal(f.state.posts.length, 1);
});

test('unknown publication keeps reservation and never completes or retries', async t => {
  const f = await fixture(t, { unknownPublication: true });
  const result = await runTick({ gateway: f.gateway, generator: mockGenerator() });
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(f.state.reserved, 1);
  assert.equal(f.state.calls.filter(x => x === 'publish').length, 1);
  assert.equal(f.state.completed, false);
});

test('permission revocation before publication is respected', async t => {
  const f = await fixture(t, { denyPublish: true });
  const result = await runTick({ gateway: f.gateway, generator: mockGenerator() });
  assert.equal(result.reason, 'publication_permission_denied');
  assert.equal(f.state.posts.length, 0);
  assert.equal(f.state.completed, false);
});

test('silence settles zero usage without creating a forum post', async t => {
  const f = await fixture(t);
  const generator = { maximumPence: 1, generate: async () => ({ text: null, actualPence: 0 }) };
  assert.equal((await runTick({ gateway: f.gateway, generator })).status, 'silent');
  assert.equal(f.state.posts.length, 0);
  assert.equal(f.state.reserved, 0);
});

test('generation failure, over-budget usage and invalid output preserve uncertain reservations', async t => {
  for (const generate of [async () => { throw new Error('provider failed'); },
    async () => ({ text: 'reply', actualPence: 2 }), async () => ({ text: 'x'.repeat(2001), actualPence: 0 })]) {
    const f = await fixture(t);
    assert.equal((await runTick({ gateway: f.gateway, generator: { maximumPence: 1, generate } })).status, 'reconciliation_required');
    assert.equal(f.state.reserved, 1);
    assert.equal(f.state.posts.length, 0);
  }
});

test('lost completion response does not republish a visible reply', async t => {
  const f = await fixture(t, { loseCompletionResponse: true });
  const result = await runTick({ gateway: f.gateway, generator: mockGenerator() });
  assert.equal(result.reason, 'completion_outcome_unknown');
  assert.equal(result.postId, 2);
  assert.equal(f.state.posts.length, 1);
});

test('invalid worker credential fails and is never included in the error', async t => {
  const f = await fixture(t);
  const token = 'incorrect-worker-credential-123456';
  const gateway = createGateway({ baseUrl: f.baseUrl, token, allowLocalHttp: true });
  await assert.rejects(gateway.claim(), error => error.status === 401 && !error.message.includes(token));
});

test('gateway refuses unsafe destinations', () => {
  const token = 'test-worker-credential-123456789';
  for (const baseUrl of ['http://example.com/', 'https://user:password@example.com/', 'https://example.com/?token=a']) {
    assert.throws(() => createGateway({ baseUrl, token, allowLocalHttp: true }));
  }
  assert.throws(() => createGateway({ baseUrl: 'http://127.0.0.1/', token }));
});

test('gateway times out a stalled request without leaking its credential', async t => {
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const token = 'test-worker-credential-123456789';
  const gateway = createGateway({ baseUrl: `http://127.0.0.1:${server.address().port}/`,
    token, allowLocalHttp: true, timeoutMs: 50 });
  await assert.rejects(gateway.claim(), error => error.code === 'gateway_unavailable_or_invalid' && !error.message.includes(token));
});

test('malformed claimed identity or oversized context cannot reach reservation or generation', async () => {
  const job = { id: 'j', leaseToken: 'lease', publicationKey: 'p', characterId: 'mara' };
  for (const invalid of ['identity', 'context']) {
    let reserved = false;
    const gateway = {
      claim: async () => ({ job: { ...job, characterId: invalid === 'identity' ? 'administrator' : 'mara' } }),
      context: async () => ({ policyState: {}, posts: [{ id: 1, text: 'x'.repeat(4001) }] }),
      reserve: async () => { reserved = true; },
    };
    await assert.rejects(runTick({ gateway, generator: mockGenerator() }), /Invalid/);
    assert.equal(reserved, false);
  }
});

test('gateway rejects redirects, oversized replies and non-JSON responses', async t => {
  let destinationHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect/claim') { res.writeHead(302, { Location: '/destination' }); return res.end(); }
    if (req.url === '/destination') { destinationHits++; return res.end('unexpected'); }
    if (req.url === '/large/claim') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ text: 'x'.repeat(70000) })); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('not JSON');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const path of ['redirect', 'large', 'html']) {
    const gateway = createGateway({ baseUrl: `http://127.0.0.1:${server.address().port}/${path}/`,
      token: 'test-worker-credential-123456789', allowLocalHttp: true });
    await assert.rejects(gateway.claim());
  }
  assert.equal(destinationHits, 0);
});
