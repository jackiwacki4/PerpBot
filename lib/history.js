// Bulk historical candles, cached on disk.
//
// Kalshi caps one request at 5000 candles, so a couple of months of one-minute
// bars is ~20 requests per market. The search re-reads that data constantly, so
// it is fetched once and cached; delete .cache/ to force a refresh.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kalshi from './kalshi.js';
import { buildSnapshot } from './snapshot.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(ROOT, '.cache');

const MAX_PER_REQUEST = 4800;
/** Stop walking back after this many consecutive empty windows. */
const EMPTY_WINDOWS_BEFORE_STOP = 2;

async function readCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every one-minute bar Kalshi still has for a market, oldest first.
 * @param {string} ticker
 * @param {{maxDays?: number, refresh?: boolean, onProgress?: (msg: string) => void}} opts
 */
export async function loadBars(ticker, { maxDays = 90, refresh = false, onProgress } = {}) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${ticker}-1m.json`);

  if (!refresh) {
    const cached = await readCache(file);
    // Reuse the cache while it is still fresh enough to be worth it.
    if (cached?.bars?.length && Date.now() - cached.fetchedAt < 6 * 3600_000) {
      onProgress?.(`${ticker}: ${cached.bars.length} bars (cached)`);
      return cached.bars;
    }
  }

  const market = (await kalshi.getMarket(ticker)).market;
  const chunks = [];
  let end = Math.floor(Date.now() / 1000);
  let empties = 0;
  const floor = end - maxDays * 86400;

  while (end > floor && empties < EMPTY_WINDOWS_BEFORE_STOP) {
    const start = Math.max(floor, end - MAX_PER_REQUEST * 60);
    const res = await kalshi.getCandlesRange(ticker, 1, start, end);
    const candles = res.candlesticks ?? [];

    if (candles.length) {
      chunks.unshift(candles);
      empties = 0;
      onProgress?.(`${ticker}: ${chunks.reduce((a, c) => a + c.length, 0)} bars…`);
    } else {
      empties += 1;
    }
    end = start;
  }

  // Reuse the normaliser so the search sees exactly the bars the live app would,
  // including the rejection of corrupt maintenance-window prints.
  const bars = buildSnapshot({
    market,
    orderbook: {},
    trades: [],
    candles1m: chunks.flat(),
    candles1h: [],
    fundingEstimate: null,
    fundingHistory: [],
  }).bars1m;

  await fs.writeFile(file, JSON.stringify({ ticker, fetchedAt: Date.now(), bars }));
  onProgress?.(`${ticker}: ${bars.length} bars (fetched)`);
  return bars;
}

/** Historical funding rates, cached the same way. */
export async function loadFunding(ticker, { refresh = false } = {}) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${ticker}-funding.json`);

  if (!refresh) {
    const cached = await readCache(file);
    if (cached?.rates && Date.now() - cached.fetchedAt < 6 * 3600_000) return cached.rates;
  }

  const res = await kalshi.getFundingHistory(ticker, 1000).catch(() => null);
  const rates = (res?.funding_rates ?? [])
    .map((f) => ({ at: Date.parse(f.funding_time), rate: Number(f.funding_rate) || 0 }))
    .filter((f) => Number.isFinite(f.at))
    .sort((a, b) => a.at - b.at);

  await fs.writeFile(file, JSON.stringify({ ticker, fetchedAt: Date.now(), rates }));
  return rates;
}

/** Markets worth testing: active, and liquid enough that fills are realistic. */
export async function liquidTickers(minVolumeUsd = 1e6) {
  const { markets = [] } = await kalshi.getMarkets();
  return markets
    .filter((m) => m.status === 'active' && Number(m.volume_24h_notional_value_dollars) > minVolumeUsd)
    .sort(
      (a, b) =>
        Number(b.volume_24h_notional_value_dollars) - Number(a.volume_24h_notional_value_dollars),
    )
    .map((m) => m.ticker);
}
