// The request handler, kept separate from any particular way of listening.
//
//   server.js    wraps this in a long-running node:http server (local, Docker,
//                Render, Fly, Railway, any VPS)
//   api/index.js hands the same function to a serverless platform (Vercel)
//
// The browser is not allowed to call Kalshi directly, so every data request
// lands here first. That is also where the caching lives: one set of upstream
// calls serves every viewer, no matter how many tabs are open.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kalshi from './kalshi.js';
import { buildSnapshot } from './snapshot.js';
import { computeSignals } from './signals.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ── abuse protection ───────────────────────────────────────────── */

// Once this is on a public URL the proxy endpoints are open to the world.
// The upstream cache already shields Kalshi from repeat calls; this stops one
// client from burning the whole budget on cache misses.
const RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120),
};

const hits = new Map();

export function rateLimit(key, now = Date.now(), limit = RATE_LIMIT) {
  const window = hits.get(key);

  if (!window || now - window.start >= limit.windowMs) {
    hits.set(key, { start: now, count: 1 });
    return { allowed: true, retryAfterSec: 0 };
  }

  window.count += 1;
  if (window.count > limit.maxRequests) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((limit.windowMs - (now - window.start)) / 1000),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

// Without this the map grows one entry per visitor IP, forever.
export function pruneRateLimits(now = Date.now(), limit = RATE_LIMIT) {
  for (const [key, window] of hits) {
    if (now - window.start >= limit.windowMs) hits.delete(key);
  }
}

function clientKey(req) {
  // Hosting platforms terminate TLS upstream, so the real client address
  // arrives in x-forwarded-for.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Optional shared-password gate, off unless SITE_PASSWORD is set.
 * Only worth turning on if you would rather the URL not be usable by anyone
 * who stumbles across it.
 */
function isAuthorised(req) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) return true;

  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [, password = ''] = Buffer.from(header.slice(6), 'base64').toString().split(':');

  // Constant-time-ish: compare full length regardless of where they diverge.
  if (password.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= password.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/* ── responses ──────────────────────────────────────────────────── */

function sendJSON(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function handleMarkets(res) {
  const { markets = [] } = await kalshi.getMarkets();
  sendJSON(
    res,
    200,
    markets
      .map((m) => ({
        ticker: m.ticker,
        title: m.title,
        status: m.status,
        asset: String(m.ticker || '').replace(/^KX/, '').replace(/PERP$/, ''),
        volume24hUsd: Number(m.volume_24h_notional_value_dollars ?? 0),
        openInterestUsd: Number(m.open_interest_notional_value_dollars ?? 0),
      }))
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd),
  );
}

async function handleSnapshot(res, ticker) {
  // One round of every data source the dashboard needs, fetched in parallel.
  // Funding is nice-to-have, so it must not take the whole page down.
  const [market, orderbook, trades, candles1m, candles1h, fundingEstimate, fundingHistory] =
    await Promise.all([
      kalshi.getMarket(ticker),
      kalshi.getOrderbook(ticker),
      kalshi.getTrades(ticker, 100),
      kalshi.getCandles(ticker, 1, 240),
      kalshi.getCandles(ticker, 60, 60 * 24 * 7),
      kalshi.getFundingEstimate(ticker).catch(() => null),
      kalshi.getFundingHistory(ticker, 24).catch(() => null),
    ]);

  const snapshot = buildSnapshot({
    market: market.market ?? market,
    orderbook: orderbook.orderbook ?? orderbook,
    trades: trades.trades ?? [],
    candles1m: candles1m.candlesticks ?? [],
    candles1h: candles1h.candlesticks ?? [],
    fundingEstimate,
    fundingHistory: fundingHistory?.funding_rates ?? [],
  });

  sendJSON(res, 200, { snapshot, signals: computeSignals(snapshot) });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // Never let a crafted path escape the public directory.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

/* ── entry point ────────────────────────────────────────────────── */

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // Uptime pings, and a quick way to tell a live deploy from a sleeping one.
  if (url.pathname === '/healthz') {
    sendJSON(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()) });
    return;
  }

  if (!isAuthorised(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="PerpBot"' }).end('Unauthorized');
    return;
  }

  const { allowed, retryAfterSec } = rateLimit(clientKey(req));
  if (!allowed) {
    sendJSON(res, 429, { error: 'Too many requests, slow down.' }, { 'retry-after': String(retryAfterSec) });
    return;
  }

  try {
    if (url.pathname === '/api/markets') {
      await handleMarkets(res);
      return;
    }

    if (url.pathname === '/api/snapshot') {
      const ticker = url.searchParams.get('ticker');
      if (!ticker || !/^[A-Z0-9]{1,32}$/.test(ticker)) {
        sendJSON(res, 400, { error: 'ticker query parameter is required' });
        return;
      }
      await handleSnapshot(res, ticker);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJSON(res, 404, { error: 'unknown endpoint' });
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err.message);
    sendJSON(res, err.status === 429 ? 429 : 502, { error: err.message });
  }
}
