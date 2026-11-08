import { createGateway } from './gateway.mjs';
import { runTick } from './worker.mjs';
import { startForumFixture, mockGenerator } from './test/helpers/forum-fixture.mjs';

const forum = await startForumFixture({ losePublishResponse: true });
try {
  const gateway = createGateway({ ...forum, allowLocalHttp: true });
  const result = await runTick({ gateway, generator: mockGenerator() });
  console.log('OFFLINE SIMULATION: no phpBB connection, persistence or paid model calls.');
  console.log(JSON.stringify({ result, calls: forum.state.calls, posts: forum.state.posts,
    reservedPence: forum.state.reserved, spentPence: forum.state.spent }, null, 2));
} finally { await forum.close(); }
