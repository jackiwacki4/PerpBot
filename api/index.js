// Serverless entry point (Vercel). Vercel serves everything in public/ from its
// CDN and routes /api/* here via the rewrite in vercel.json.
//
// Worth knowing: each serverless instance has its own memory, so the upstream
// cache in lib/kalshi.js is only shared by requests that happen to land on the
// same warm instance. A long-running deploy (Docker/Render) caches better.

import { handleRequest } from '../lib/app.js';

export default handleRequest;
