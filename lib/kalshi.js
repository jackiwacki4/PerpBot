// Thin client for Kalshi's public perpetual-futures (margin) market-data API.
//
// Everything used here is public read-only data: no API key, no signing.
// Docs: https://docs.kalshi.com/margin

const HOSTS = {
  prod: 'https://external-api.kalshi.com/trade-api/v2',
  demo: 'https://external-api.demo.kalshi.co/trade-api/v2',
};

const BASE = `${HOSTS[process.env.KALSHI_ENV === 'demo' ? 'demo' : 'prod']}/margin`;

const REQUEST_TIMEOUT_MS = 8000;

// Kalshi rate-limits per-IP, and the browser polls every couple of seconds.
// A short TTL cache collapses repeat calls without making the screen feel stale.
const cache = new Map();

async function getJSON(path, { ttlMs = 0 } = {}) {
  const url = `${BASE}${path}`;
  const now = Date.now();

  if (ttlMs > 0) {
    const hit = cache.get(url);
    if (hit && now - hit.at < ttlMs) return hit.value;
  }

  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Kalshi ${res.status} on ${path}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const value = await res.json();
  if (ttlMs > 0) cache.set(url, { at: now, value });
  return value;
}

export function getMarkets() {
  return getJSON('/markets', { ttlMs: 5000 });
}

export function getMarket(ticker) {
  return getJSON(`/markets/${encodeURIComponent(ticker)}`, { ttlMs: 1000 });
}

export function getOrderbook(ticker) {
  return getJSON(`/markets/${encodeURIComponent(ticker)}/orderbook`, { ttlMs: 1000 });
}

export function getTrades(ticker, limit = 100) {
  return getJSON(
    `/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
    { ttlMs: 1500 },
  );
}

/**
 * @param {string} ticker
 * @param {number} intervalMin candle width in minutes (1, 60 or 1440)
 * @param {number} lookbackMin how far back to fetch
 */
export function getCandles(ticker, intervalMin, lookbackMin) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - lookbackMin * 60;
  return getJSON(
    `/markets/${encodeURIComponent(ticker)}/candlesticks` +
      `?period_interval=${intervalMin}&start_ts=${start}&end_ts=${end}`,
    { ttlMs: intervalMin === 1 ? 5000 : 60000 },
  );
}

export function getFundingEstimate(ticker) {
  return getJSON(
    `/funding_rates/estimate?ticker=${encodeURIComponent(ticker)}`,
    { ttlMs: 5000 },
  );
}

export function getFundingHistory(ticker, limit = 30) {
  return getJSON(
    `/funding_rates/historical?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
    { ttlMs: 60000 },
  );
}

export { BASE };
