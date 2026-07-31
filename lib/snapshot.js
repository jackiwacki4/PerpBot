// Turns raw Kalshi API payloads into one normalised object the rest of the app
// (and the browser) can read without re-learning Kalshi's field names.
//
// Two price scales matter and are easy to confuse:
//   * contract price  - what you see on an order ticket, e.g. $6.29 per contract
//   * underlying price - the asset price, e.g. $62,900 per BTC
// They are related by contract_size (0.0001 BTC per contract), so
//   underlying = contract price / contract_size.

import { num } from './indicators.js';

function toBars(candlesticks = [], contractSize) {
  const bars = [];
  let prevClose = NaN;

  for (const c of candlesticks) {
    const p = c.price ?? {};
    // Quiet minutes trade nothing, so price.* comes back as 0. Fall back to the
    // bid/ask midpoint, then to the previous close, so the series has no holes.
    const bidClose = num(c.bid?.close, NaN);
    const askClose = num(c.ask?.close, NaN);
    const bookMid =
      Number.isFinite(bidClose) && Number.isFinite(askClose)
        ? (bidClose + askClose) / 2
        : NaN;

    const pick = (raw) => {
      const v = num(raw, 0);
      if (v > 0) return v;
      if (Number.isFinite(bookMid) && bookMid > 0) return bookMid;
      return prevClose;
    };

    const close = pick(p.close);
    if (!Number.isFinite(close) || close <= 0) continue;

    const open = pick(p.open);
    const high = Math.max(pick(p.high), close, open);
    const low = Math.min(pick(p.low), close, open);
    prevClose = close;

    bars.push({
      t: num(c.end_period_ts, 0) * 1000,
      open: open / contractSize,
      high: high / contractSize,
      low: low / contractSize,
      close: close / contractSize,
      volume: num(c.volume, 0),
      openInterest: num(c.open_interest, 0),
    });
  }
  return bars;
}

/**
 * Best bid / best ask sit at the END of Kalshi's orderbook arrays.
 * Returns levels sorted best-first, in underlying price units.
 */
function toBook(orderbook = {}, contractSize) {
  const levels = (side) =>
    (orderbook[side] ?? [])
      .map(([price, qty]) => ({
        price: num(price, 0) / contractSize,
        contracts: num(qty, 0),
      }))
      .filter((l) => l.price > 0 && l.contracts > 0);

  const bids = levels('bids').sort((a, b) => b.price - a.price);
  const asks = levels('asks').sort((a, b) => a.price - b.price);
  return { bids, asks };
}

function toTrades(trades = [], contractSize) {
  return trades
    .map((t) => ({
      id: t.trade_id,
      ts: Date.parse(t.created_time),
      price: num(t.price, 0) / contractSize,
      contracts: num(t.count, 0),
      // taker_side "bid" means the aggressor lifted the offer => a buy.
      // Verified against live data: trades tagged "bid" print above the mid at
      // the time of the fill, trades tagged "ask" print below it.
      side: t.taker_side === 'bid' ? 'buy' : 'sell',
    }))
    .filter((t) => t.price > 0)
    .sort((a, b) => b.ts - a.ts);
}

export function buildSnapshot({
  market,
  orderbook,
  trades,
  candles1m,
  candles1h,
  fundingEstimate,
  fundingHistory,
}) {
  const contractSize = num(market.contract_size, 1) || 1;
  const scale = (v) => (Number.isFinite(v) ? v / contractSize : NaN);

  const bidC = num(market.bid, NaN);
  const askC = num(market.ask, NaN);
  const midC = Number.isFinite(bidC) && Number.isFinite(askC) ? (bidC + askC) / 2 : NaN;

  const index = scale(num(market.reference_price?.price, NaN));
  const mark = scale(num(market.liquidation_mark_price?.price, NaN));
  const mid = scale(midC);

  const book = toBook(orderbook, contractSize);
  const bars1m = toBars(candles1m, contractSize);

  const nextFunding = fundingEstimate?.next_funding_time
    ? Date.parse(fundingEstimate.next_funding_time)
    : NaN;

  return {
    ticker: market.ticker,
    title: market.title,
    status: market.status,
    asset: String(market.ticker || '').replace(/^KX/, '').replace(/PERP$/, ''),
    contractSize,
    tickSize: num(market.tick_size, 0.0001),
    updatedAt: Date.now(),

    contract: { bid: bidC, ask: askC, mid: midC, last: num(market.price, NaN) },

    price: {
      bid: scale(bidC),
      ask: scale(askC),
      mid,
      last: scale(num(market.price, NaN)),
      index,
      mark,
      spread: scale(askC - bidC),
      spreadPct: Number.isFinite(mid) && mid ? ((askC - bidC) / midC) * 100 : NaN,
      // Perp premium over the index. Positive = perp trading rich.
      basisPct: Number.isFinite(index) && index ? ((mid - index) / index) * 100 : NaN,
    },

    stats: {
      openInterest: num(market.open_interest, 0),
      openInterestUsd: num(market.open_interest_notional_value_dollars, 0),
      volume24h: num(market.volume_24h, 0),
      volume24hUsd: num(market.volume_24h_notional_value_dollars, 0),
      leverageEstimate: num(market.leverage_estimate, NaN),
      leverageEstimates: market.leverage_estimates ?? {},
    },

    book,
    trades: toTrades(trades, contractSize),
    bars1m,
    bars1h: toBars(candles1h, contractSize),

    funding: {
      // Kalshi returns the rate as a decimal fraction charged each 8h period.
      rate: num(fundingEstimate?.funding_rate, 0),
      computedAt: fundingEstimate?.computed_time
        ? Date.parse(fundingEstimate.computed_time)
        : NaN,
      nextFundingAt: nextFunding,
      history: (fundingHistory ?? []).map((f) => ({
        rate: num(f.funding_rate, 0),
        at: Date.parse(f.funding_time),
        mark: scale(num(f.mark_price, NaN)),
      })),
    },
  };
}
