'use strict';

// Reconstructed smoke-test bootstrap; not a copy retrieved from HostArmada.
// No model calls, database access or forum publishing are enabled here.
const http = require('node:http');

function createServer() {
  return http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const path = request.url.split('?')[0];
    if (!['/', '/engine', '/engine/'].includes(path)) {
      response.writeHead(404);
      return response.end('Not found.\n');
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      return response.end('Method not allowed.\n');
    }
    response.writeHead(200);
    response.end('Tavern engine is running.\n');
  });
}

function portFromEnvironment(value) {
  if (value === undefined) return 3000;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return Number(value);
}

if (require.main === module) {
  const server = createServer();
  server.on('error', (error) => {
    console.error(`Tavern engine failed to listen: ${error.code || 'unknown error'}`);
    process.exitCode = 1;
  });
  server.listen(portFromEnvironment(process.env.PORT), process.env.HOST || '127.0.0.1', () => {
    console.log('Tavern engine is running.');
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => server.close());
  }
}

module.exports = { createServer, portFromEnvironment };
