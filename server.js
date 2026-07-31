// Long-running server: local development, Docker, Render, Fly, Railway, a VPS.
// All the actual logic lives in lib/app.js so the serverless entry point in
// api/index.js can share it.
//
//   node server.js   ->  http://localhost:3000

import http from 'node:http';

import { handleRequest, pruneRateLimits } from './lib/app.js';
import { BASE } from './lib/kalshi.js';

const PORT = Number(process.env.PORT ?? 3000);
// Hosting platforms route traffic to the container from outside, so listening
// only on localhost would make the app unreachable there.
const HOST = process.env.HOST ?? '0.0.0.0';

const server = http.createServer(handleRequest);

const pruner = setInterval(() => pruneRateLimits(), 60_000);
pruner.unref();

server.listen(PORT, HOST, () => {
  console.log(`PerpBot listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Market data: ${BASE}`);
  if (process.env.SITE_PASSWORD) console.log('Password protection: on');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
