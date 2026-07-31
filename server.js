// PerpBot - a local web dashboard for Kalshi perpetual futures.
//
// The browser cannot call Kalshi directly (CORS), so this tiny server sits in
// front of it: it fetches the public market data, normalises it, runs the
// signal engine, and hands the browser one ready-to-render JSON blob.
//
//   npm start   ->  http://localhost:3000

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kalshi from './lib/kalshi.js';
import { buildSnapshot } from './lib/snapshot.js';
import { computeSignals } from './lib/signals.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
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
  // Funding history is nice-to-have, so it must not take the page down.
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
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/api/markets') {
      await handleMarkets(res);
      return;
    }

    if (url.pathname === '/api/snapshot') {
      const ticker = url.searchParams.get('ticker');
      if (!ticker || !/^[A-Z0-9]+$/.test(ticker)) {
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
});

server.listen(PORT, () => {
  console.log(`PerpBot running at http://localhost:${PORT}`);
  console.log(`Market data: ${kalshi.BASE}`);
});
