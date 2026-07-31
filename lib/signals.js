// The "co-pilot" brain.
//
// Every factor below reduces one observable thing about the market to a score
// between -1 (bearish) and +1 (bullish). The factors are then weighted into a
// single bias. This is mechanical pattern-reading, not a prediction and not
// financial advice - the point is to put the numbers you would otherwise have
// to eyeball onto one screen while you trade.

import { atr, clamp, ema, num, pctChange, rsi, squash, stdev } from './indicators.js';

/** Kalshi charges funding every 8 hours => three periods a day. */
export const FUNDING_PERIODS_PER_DAY = 3;
export const FUNDING_PERIOD_HOURS = 24 / FUNDING_PERIODS_PER_DAY;

const WEIGHTS = {
  trend: 0.24,
  momentum: 0.16,
  meanReversion: 0.10,
  book: 0.16,
  tape: 0.14,
  funding: 0.10,
  basis: 0.10,
};

/** Depth is measured this far either side of the mid. */
const DEPTH_BAND_PCT = 0.5;
/** Trades in this window feed the tape-pressure factor. */
const TAPE_WINDOW_MS = 5 * 60 * 1000;
/** Below this the bias is not worth acting on. */
const DECISION_THRESHOLD = 0.30;

/** Turns a raw magnitude into a word, so the UI never has to say "0.83 ATR". */
function strength(x) {
  const v = Math.abs(x);
  if (v > 1.5) return 'strongly';
  if (v > 0.7) return 'clearly';
  return 'slightly';
}

function closes(bars, count) {
  return bars.slice(-count).map((b) => b.close);
}

/** Notional value resting within DEPTH_BAND_PCT of the mid, per side. */
export function depth(book, mid, contractSize, bandPct = DEPTH_BAND_PCT) {
  const band = mid * (bandPct / 100);
  const sum = (levels, inRange) =>
    levels
      .filter((l) => inRange(l.price))
      .reduce((acc, l) => acc + l.contracts * contractSize * l.price, 0);

  return {
    bidUsd: sum(book.bids, (p) => p >= mid - band),
    askUsd: sum(book.asks, (p) => p <= mid + band),
  };
}

function trendFactor(bars) {
  const series = closes(bars, 120);
  if (series.length < 25) return null;
  const fast = ema(series, 9);
  const slow = ema(series, 21);
  const range = atr(bars.slice(-60), 14);
  if (!Number.isFinite(range) || range <= 0) return null;

  // Distance between the EMAs, measured in ATRs, so it means the same thing
  // on a $0.15 coin and on a $60,000 one.
  const spreadInAtr = (fast - slow) / range;
  return {
    key: 'trend',
    label: 'Which way is it drifting?',
    note: 'trend · EMA 9 vs 21',
    short: 'the trend',
    score: squash(spreadInAtr, 0.8),
    value: `${strength(spreadInAtr)} ${fast > slow ? 'up' : 'down'}`,
    detail:
      fast > slow
        ? 'Short-term average is above the longer one - buyers in control.'
        : 'Short-term average is below the longer one - sellers in control.',
  };
}

function momentumFactor(bars) {
  const series = closes(bars, 16);
  if (series.length < 10) return null;
  const change = pctChange(series);
  const returns = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    if (prev) returns.push(((bars[i].close - prev) / prev) * 100);
  }
  // Normalise the move by how much this market usually moves in 15 minutes.
  const noise = (stdev(returns.slice(-120)) || 0.05) * Math.sqrt(15);
  return {
    key: 'momentum',
    label: 'How hard is it moving?',
    note: 'momentum · last 15 min',
    short: 'the last few minutes',
    score: squash(change / (noise || 0.05), 1.5),
    value: `${change >= 0 ? '+' : ''}${change.toFixed(3)}%`,
    detail: `Last 15 minutes moved ${Math.abs(change / (noise || 0.05)).toFixed(1)}x a normal 15-minute swing.`,
  };
}

function meanReversionFactor(bars) {
  const series = closes(bars, 120);
  const value = rsi(series, 14);
  if (!Number.isFinite(value)) return null;
  // Only speaks up at the extremes, and it leans against the move.
  const stretch = value > 70 ? -(value - 70) / 30 : value < 30 ? (30 - value) / 30 : 0;
  return {
    key: 'meanReversion',
    label: 'Has it gone too far?',
    note: 'RSI 14',
    short: 'how stretched it is',
    score: clamp(stretch, -1, 1),
    value: value.toFixed(1),
    detail:
      value > 70
        ? 'Overbought - chasing longs here often buys the top of the move.'
        : value < 30
          ? 'Oversold - a bounce is more likely than a fresh leg down.'
          : 'Neither stretched nor squeezed; no edge from this one.',
  };
}

function bookFactor(book, mid, contractSize) {
  const { bidUsd, askUsd } = depth(book, mid, contractSize);
  const total = bidUsd + askUsd;
  if (!total) return null;
  const imbalance = (bidUsd - askUsd) / total;
  return {
    key: 'book',
    label: 'Orders waiting to fill',
    note: `order book · within ${DEPTH_BAND_PCT}% of price`,
    short: 'the orders waiting',
    score: squash(imbalance, 0.45),
    value:
      Math.abs(imbalance) < 0.05
        ? 'evenly matched'
        : `${Math.abs(imbalance * 100).toFixed(0)}% more ${imbalance >= 0 ? 'buy' : 'sell'} orders`,
    detail: `$${Math.round(bidUsd).toLocaleString()} of buy orders vs $${Math.round(askUsd).toLocaleString()} of sell orders near the price.`,
    extra: { bidUsd, askUsd, imbalance },
  };
}

function tapeFactor(trades, now = Date.now()) {
  const recent = trades.filter((t) => now - t.ts <= TAPE_WINDOW_MS);
  if (recent.length < 5) return null;
  let buys = 0;
  let sells = 0;
  for (const t of recent) {
    if (t.side === 'buy') buys += t.contracts;
    else sells += t.contracts;
  }
  const total = buys + sells;
  if (!total) return null;
  const imbalance = (buys - sells) / total;
  return {
    key: 'tape',
    label: 'Who is actually buying?',
    note: 'live trades · last 5 min',
    short: 'who is buying right now',
    score: squash(imbalance, 0.4),
    value: `${(imbalance * 100).toFixed(0)}% ${imbalance >= 0 ? 'buying' : 'selling'}`,
    detail: `${recent.length} trades: ${Math.round(buys).toLocaleString()} contracts bought at the offer, ${Math.round(sells).toLocaleString()} sold at the bid.`,
    extra: { buys, sells, imbalance },
  };
}

function fundingFactor(funding) {
  const rate = funding.rate ?? 0;
  const annualPct = rate * FUNDING_PERIODS_PER_DAY * 365 * 100;
  // Positive funding means longs pay shorts, which is a mild headwind for longs
  // and a crowding signal when it gets extreme.
  return {
    key: 'funding',
    label: 'What it costs to hold',
    note: 'funding rate',
    short: 'the cost to hold',
    score: squash(-annualPct, 40),
    value: rate === 0 ? 'free right now' : `${(rate * 100).toFixed(4)}% every ${FUNDING_PERIOD_HOURS}h`,
    detail:
      rate > 0
        ? 'Longs are paying shorts - holding a long costs money and the crowd is already long.'
        : rate < 0
          ? 'Shorts are paying longs - holding a long earns money here.'
          : 'Funding is flat; holding either side is free this period.',
    extra: { annualPct },
  };
}

function basisFactor(price) {
  const basis = price.basisPct;
  if (!Number.isFinite(basis)) return null;
  return {
    key: 'basis',
    label: 'Gap to the real price',
    note: 'premium to index',
    short: 'the gap to spot',
    score: squash(-basis, 0.25),
    value: `${basis >= 0 ? '+' : ''}${basis.toFixed(3)}%`,
    detail:
      basis > 0
        ? 'The perp is trading above spot - it tends to get pulled back down toward the index.'
        : 'The perp is trading below spot - it tends to get pulled back up toward the index.',
  };
}

/**
 * The factors that need nothing but the candle history. Split out so the
 * backtest can score historical bars with the exact same code the live
 * dashboard runs, rather than a re-implementation that could drift.
 */
export function priceFactors(bars) {
  return [trendFactor(bars), momentumFactor(bars), meanReversionFactor(bars)].filter(Boolean);
}

/** Weighted average of a set of factors, renormalised over whatever is present. */
export function blend(factors) {
  const weighted = factors.map((f) => ({ ...f, weight: WEIGHTS[f.key] ?? 0 }));
  const total = weighted.reduce((a, f) => a + f.weight, 0);
  if (!total) return 0;
  return weighted.reduce((a, f) => a + clamp(f.score, -1, 1) * f.weight, 0) / total;
}

function buildWarnings(s, metrics) {
  const w = [];
  if (s.status !== 'active') {
    w.push({ level: 'high', text: `Market status is "${s.status}" - it may not be tradeable right now.` });
  }
  if (Number.isFinite(s.price.spreadPct) && s.price.spreadPct > 0.15) {
    w.push({
      level: 'high',
      text: `Spread is ${s.price.spreadPct.toFixed(3)}% wide. A market order pays that twice on a round trip.`,
    });
  }
  if (metrics.depthUsd < 5000) {
    w.push({
      level: 'medium',
      text: `Only $${Math.round(metrics.depthUsd).toLocaleString()} resting within ±${DEPTH_BAND_PCT}% of price - size will slip.`,
    });
  }
  if (Number.isFinite(metrics.minutesToFunding) && metrics.minutesToFunding <= 15 && Math.abs(metrics.fundingAnnualPct) > 5) {
    w.push({
      level: 'medium',
      text: `Funding settles in ${Math.round(metrics.minutesToFunding)} min at ${metrics.fundingAnnualPct >= 0 ? '+' : ''}${metrics.fundingAnnualPct.toFixed(1)}% annualised. Positions open at that moment pay or receive it.`,
    });
  }
  if (Number.isFinite(metrics.atrPct) && metrics.atrPct > 0.25) {
    w.push({
      level: 'medium',
      text: `Fast tape: an average minute moves ${metrics.atrPct.toFixed(2)}%. Widen stops or cut size.`,
    });
  }
  if (Number.isFinite(s.price.basisPct) && Math.abs(s.price.basisPct) > 0.3) {
    w.push({
      level: 'medium',
      text: `Perp is ${s.price.basisPct.toFixed(2)}% away from the index price - unusually dislocated.`,
    });
  }
  return w;
}

/**
 * Suggested entry / stop / target, derived from recent volatility rather than
 * from any view about where price is going.
 */
function buildPlan(bias, snapshot, atr1m) {
  const entry = snapshot.price.mid;
  if (!Number.isFinite(entry) || !Number.isFinite(atr1m) || atr1m <= 0 || bias === 'WAIT') {
    return null;
  }
  const stopDistance = atr1m * 2.5;
  const targetDistance = stopDistance * 1.8;
  const dir = bias === 'LONG' ? 1 : -1;
  return {
    side: bias,
    entry,
    stop: entry - dir * stopDistance,
    target: entry + dir * targetDistance,
    stopDistance,
    targetDistance,
    stopPct: (stopDistance / entry) * 100,
    riskReward: targetDistance / stopDistance,
  };
}

export function computeSignals(snapshot, now = Date.now()) {
  const { bars1m, book, trades, funding, price, contractSize } = snapshot;
  const mid = price.mid;

  const factors = [
    ...priceFactors(bars1m),
    Number.isFinite(mid) ? bookFactor(book, mid, contractSize) : null,
    tapeFactor(trades, now),
    fundingFactor(funding),
    basisFactor(price),
  ]
    .filter(Boolean)
    .map((f) => ({ ...f, weight: WEIGHTS[f.key], score: clamp(f.score, -1, 1) }));

  const totalWeight = factors.reduce((a, f) => a + f.weight, 0) || 1;
  const score = factors.reduce((a, f) => a + f.score * f.weight, 0) / totalWeight;

  const bias = score >= DECISION_THRESHOLD ? 'LONG' : score <= -DECISION_THRESHOLD ? 'SHORT' : 'WAIT';

  // How much of the weight actually agrees with the headline call.
  const agreeing = factors
    .filter((f) => Math.sign(f.score) === Math.sign(score) && f.score !== 0)
    .reduce((a, f) => a + f.weight, 0);
  const agreement = agreeing / totalWeight;
  const confidence = Math.round(
    100 * clamp(Math.abs(score) / 0.6, 0, 1) * (0.5 + 0.5 * agreement),
  );

  const atr1m = atr(bars1m.slice(-60), 14);
  const { bidUsd, askUsd } = Number.isFinite(mid)
    ? depth(book, mid, contractSize)
    : { bidUsd: 0, askUsd: 0 };

  const metrics = {
    ema9: ema(closes(bars1m, 120), 9),
    ema21: ema(closes(bars1m, 120), 21),
    rsi14: rsi(closes(bars1m, 120), 14),
    atr1m,
    atrPct: Number.isFinite(atr1m) && mid ? (atr1m / mid) * 100 : NaN,
    change5m: pctChange(closes(bars1m, 6)),
    change15m: pctChange(closes(bars1m, 16)),
    change1h: pctChange(closes(bars1m, 61)),
    change24h: pctChange(closes(snapshot.bars1h, 25)),
    depthUsd: bidUsd + askUsd,
    bidDepthUsd: bidUsd,
    askDepthUsd: askUsd,
    fundingAnnualPct: (funding.rate ?? 0) * FUNDING_PERIODS_PER_DAY * 365 * 100,
    minutesToFunding: Number.isFinite(funding.nextFundingAt)
      ? (funding.nextFundingAt - now) / 60000
      : NaN,
  };

  return {
    score,
    bias,
    confidence,
    agreement,
    threshold: DECISION_THRESHOLD,
    factors,
    metrics,
    plan: buildPlan(bias, snapshot, atr1m),
    warnings: buildWarnings(snapshot, metrics),
  };
}

/**
 * Turn a plan into a concrete order ticket: how many contracts to click, and
 * what that position costs to hold.
 *
 * @param {object} args
 * @param {number} args.accountUsd account equity in dollars
 * @param {number} args.riskPct  percent of the account risked if the stop hits
 */
export function sizePosition({ snapshot, plan, accountUsd, riskPct }) {
  if (!plan || !(accountUsd > 0) || !(riskPct > 0)) return null;

  const { contractSize, price, stats, funding } = snapshot;
  const riskUsd = accountUsd * (riskPct / 100);

  // Each contract loses `stopDistance * contractSize` dollars if the stop hits.
  const lossPerContract = plan.stopDistance * contractSize;
  if (!(lossPerContract > 0)) return null;

  const contracts = Math.floor(riskUsd / lossPerContract);
  const notional = contracts * contractSize * plan.entry;
  const leverage = notional / accountUsd;

  const fundingPerPeriod = notional * (funding.rate ?? 0) * (plan.side === 'LONG' ? -1 : 1);

  // Rough only: real liquidation depends on maintenance margin and the rest of
  // the account, which needs an authenticated /margin/risk call.
  const maxLeverage = num(stats.leverageEstimate, NaN);
  const liquidationMove = Number.isFinite(maxLeverage) && maxLeverage > 0 ? 1 / maxLeverage : NaN;

  return {
    riskUsd,
    contracts,
    notional,
    leverage,
    lossPerContract,
    actualRiskUsd: contracts * lossPerContract,
    profitAtTarget: contracts * plan.targetDistance * contractSize,
    fundingPerPeriod,
    fundingPerDay: fundingPerPeriod * FUNDING_PERIODS_PER_DAY,
    maxLeverage,
    roughLiquidationPrice: Number.isFinite(liquidationMove)
      ? plan.entry * (1 - (plan.side === 'LONG' ? 1 : -1) * liquidationMove)
      : NaN,
    // What a market order would cost right now versus the mid.
    slippageEstimate: Number.isFinite(price.spread) ? (price.spread / 2) * contractSize * contracts : NaN,
  };
}
