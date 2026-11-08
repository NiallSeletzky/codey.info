import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, portFromEnvironment } from '../app.cjs';

test('bootstrap serves only its smoke-test routes and supports HEAD', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/engine', '/engine/', '/engine/?check=1']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Tavern engine is running.\n');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const head = await fetch(base + '/engine/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('bootstrap cannot publish posts or expose files', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = await fetch(base + '/', { method: 'POST', body: 'test' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  for (const path of ['/app.cjs', '/.env', '/api/posts']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});

test('invalid port configuration fails instead of silently using a default', () => {
  assert.equal(portFromEnvironment(undefined), 3000);
  assert.equal(portFromEnvironment('8123'), 8123);
  for (const value of ['', '0', '-1', '65536', 'abc', '3000garbage']) {
    assert.throws(() => portFromEnvironment(value), /PORT/);
  }
});
