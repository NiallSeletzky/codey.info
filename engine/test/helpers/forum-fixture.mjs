// In-memory protocol simulator ONLY. Not phpBB, SQL persistence or a deployable service.
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

export async function startForumFixture(options = {}) {
  const token = randomBytes(24).toString('hex');
  const state = { calls: [], claimed: false, completed: false, reserved: 0, spent: 0, posts: [] };
  const job = { id: 'demo-job-1', leaseToken: randomBytes(24).toString('hex'),
    publicationKey: 'demo-publication-1', characterId: 'mara' };
  const server = http.createServer(async (req, res) => {
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorised' });
    const route = req.url.split('/').pop();
    state.calls.push(route);
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (route === 'claim') {
      if (state.claimed) return json(200, { job: null });
      state.claimed = true;
      return json(200, { job });
    }
    if (body.jobId !== job.id || body.leaseToken !== job.leaseToken || body.publicationKey !== job.publicationKey) {
      return json(403, { error: 'invalid lease' });
    }
    if (route === 'context') return json(200, {
      posts: [{ id: 1, text: 'Hello Mara. Is this the Tavern?' }],
      policyState: { paused: options.paused ?? false, approved: true, roomAllowed: true,
        monthlySpent: 0, monthlyReserved: 0, dailySpent: 0, dailyReserved: 0,
        chainDepth: 0, postsToday: 0, now: 2000000, lastPostAt: 0 },
    });
    if (route === 'reserve') {
      if (options.denyReservation) return json(200, { status: 'denied' });
      state.reserved = body.maximumPence;
      return json(200, { status: 'reserved', maximumPence: body.maximumPence });
    }
    if (route === 'publish') {
      if (options.denyPublish) return json(403, { error: 'permission changed' });
      if (!state.posts.length && !options.unknownPublication) {
        state.posts.push({ id: 2, characterId: job.characterId, text: body.text });
      }
      if (options.losePublishResponse || options.unknownPublication) return req.socket.destroy();
      return json(200, { status: 'published', postId: 2 });
    }
    if (route === 'publication') return json(200, state.posts.length ?
      { status: 'published', postId: 2 } : { status: 'unknown' });
    if (route === 'complete') {
      if (options.loseCompletionResponse) return req.socket.destroy();
      state.completed = true; state.spent = body.actualPence; state.reserved = 0;
      return json(200, { status: 'completed' });
    }
    json(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, token, baseUrl: `http://127.0.0.1:${server.address().port}/worker/`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

export const mockGenerator = () => ({
  maximumPence: 1, // Tests exercise reservation; no money is charged.
  async generate() {
    return { text: '[Offline demo — Mara] Welcome to the Tavern. The kettle works; the magic is still being fitted.', actualPence: 0 };
  },
});
