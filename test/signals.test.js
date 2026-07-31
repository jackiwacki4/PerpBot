import test from 'node:test';
import assert from 'node:assert/strict';

import { atr, ema, pctChange, rsi, squash, stdev } from '../lib/indicators.js';
import { buildSnapshot } from '../lib/snapshot.js';
import { computeSignals, depth, sizePosition } from '../lib/signals.js';

/* ── indicators ─────────────────────────────────────────────────── */

test('ema tracks a flat series exactly', () => {
  assert.equal(ema([10, 10, 10, 10], 3), 10);
});

test('ema leans toward the most recent values', () => {
  const rising = ema([1, 2, 3, 4, 5], 3);
  assert.ok(rising > 3 && rising < 5, `expected 3<ema<5, got ${rising}`);
});

test('rsi is 100 for an unbroken rally and 0 for an unbroken slide', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(up, 14), 100);
  assert.equal(rsi(down, 14), 0);
});

test('rsi needs enough history', () => {
  assert.ok(Number.isNaN(rsi([1, 2, 3], 14)));
});

test('atr averages the true range', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 10, close: 11 },
  ];
  assert.equal(atr(bars, 14), 2);
});

test('pctChange measures first to last', () => {
  assert.equal(pctChange([100, 110]), 10);
});

test('stdev of a constant series is zero', () => {
  assert.equal(stdev([5, 5, 5]), 0);
});

test('squash stays inside -1..1 and keeps sign', () => {
  assert.ok(squash(1e6, 1) <= 1 && squash(1e6, 1) > 0.99);
  assert.ok(squash(-1e6, 1) >= -1 && squash(-1e6, 1) < -0.99);
  assert.equal(squash(0, 1), 0);
});

/* ── fixtures ───────────────────────────────────────────────────── */

// One contract = 0.0001 BTC, so a contract price of 6.00 means BTC at 60,000.
const CONTRACT_SIZE = 0.0001;

function candles({ count, start, step }) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + step * i;
    return {
      end_period_ts: Math.floor(Date.now() / 1000) - (count - i) * 60,
      price: {
        open: String(close - step),
        high: String(close + Math.abs(step)),
        low: String(close - Math.abs(step)),
        close: String(close),
      },
      bid: { close: String(close - 0.001) },
      ask: { close: String(close + 0.001) },
      volume: '100.00',
      open_interest: '1000.00',
    };
  });
}

function fixture({ trend = 0.002, bidQty = 500, askQty = 500, fundingRate = 0, reference = 6.0 } = {}) {
  const bars = candles({ count: 120, start: 6.0, step: trend });
  const last = parseFloat(bars[bars.length - 1].price.close);

  return buildSnapshot({
    market: {
      ticker: 'KXBTCPERP',
      title: '0.0001 BTC',
      status: 'active',
      contract_size: String(CONTRACT_SIZE),
      tick_size: '0.0001',
      bid: String(last - 0.001),
      ask: String(last + 0.001),
      price: String(last),
      reference_price: { price: String(reference), ts_ms: Date.now() },
      liquidation_mark_price: { price: String(last), ts_ms: Date.now() },
      open_interest: '1000000.00',
      open_interest_notional_value_dollars: '6000000',
      volume_24h: '500000.00',
      volume_24h_notional_value_dollars: '3000000',
      leverage_estimate: 5,
      leverage_estimates: {},
    },
    // Kalshi returns best price LAST in each array; buildSnapshot re-sorts.
    orderbook: {
      bids: [[String(last - 0.01), String(bidQty)], [String(last - 0.001), String(bidQty)]],
      asks: [[String(last + 0.01), String(askQty)], [String(last + 0.001), String(askQty)]],
    },
    trades: Array.from({ length: 20 }, (_, i) => ({
      trade_id: `t${i}`,
      created_time: new Date(Date.now() - i * 1000).toISOString(),
      price: String(last),
      count: '10.00',
      taker_side: i % 2 === 0 ? 'bid' : 'ask',
      ticker: 'KXBTCPERP',
    })),
    candles1m: bars,
    candles1h: bars,
    fundingEstimate: {
      funding_rate: fundingRate,
      next_funding_time: new Date(Date.now() + 3 * 3600_000).toISOString(),
      computed_time: new Date().toISOString(),
    },
    fundingHistory: [],
  });
}

/* ── snapshot normalisation ─────────────────────────────────────── */

test('snapshot converts contract prices into underlying prices', () => {
  const s = fixture({ trend: 0 });
  // Contract mid of ~6.00 at 0.0001 BTC per contract => BTC ~60,000.
  assert.ok(Math.abs(s.price.mid - 60_000) < 50, `got ${s.price.mid}`);
  assert.ok(Math.abs(s.contract.mid - 6) < 0.01);
});

test('snapshot sorts the book best-price-first on both sides', () => {
  const s = fixture();
  assert.ok(s.book.bids[0].price > s.book.bids[1].price, 'bids descend');
  assert.ok(s.book.asks[0].price < s.book.asks[1].price, 'asks ascend');
  assert.ok(s.book.bids[0].price < s.book.asks[0].price, 'no crossed book');
});

test('snapshot maps taker_side to buy/sell', () => {
  const s = fixture();
  assert.ok(s.trades.some((t) => t.side === 'buy'));
  assert.ok(s.trades.some((t) => t.side === 'sell'));
});

test('snapshot fills quiet candles from the book mid instead of dropping to zero', () => {
  const s = buildSnapshot({
    market: {
      ticker: 'KXBTCPERP', title: 't', status: 'active',
      contract_size: '0.0001', tick_size: '0.0001',
      bid: '6.0', ask: '6.1', price: '6.05',
      reference_price: { price: '6.05' },
      liquidation_mark_price: { price: '6.05' },
    },
    orderbook: {},
    trades: [],
    candles1m: [
      { end_period_ts: 1000, price: { open: '6', high: '6', low: '6', close: '6' }, bid: { close: '6' }, ask: { close: '6' } },
      { end_period_ts: 1060, price: { open: '0', high: '0', low: '0', close: '0' }, bid: { close: '5.99' }, ask: { close: '6.01' } },
    ],
    candles1h: [],
    fundingEstimate: null,
    fundingHistory: [],
  });
  assert.equal(s.bars1m.length, 2);
  assert.ok(s.bars1m[1].close > 0, 'quiet candle kept a usable close');
});

/* ── signals ────────────────────────────────────────────────────── */

test('a steady uptrend with buy-heavy depth reads long', () => {
  const { bias, score } = computeSignals(fixture({ trend: 0.004, bidQty: 4000, askQty: 300 }));
  assert.equal(bias, 'LONG');
  assert.ok(score > 0.3);
});

test('a steady downtrend with sell-heavy depth reads short', () => {
  const { bias, score } = computeSignals(fixture({ trend: -0.004, bidQty: 300, askQty: 4000 }));
  assert.equal(bias, 'SHORT');
  assert.ok(score < -0.3);
});

test('a flat, balanced market reads wait with no plan', () => {
  const result = computeSignals(fixture({ trend: 0, bidQty: 1000, askQty: 1000, reference: 6.0 }));
  assert.equal(result.bias, 'WAIT');
  assert.equal(result.plan, null);
});

test('score always stays within -1..1', () => {
  for (const trend of [-0.05, -0.004, 0, 0.004, 0.05]) {
    const { score } = computeSignals(fixture({ trend }));
    assert.ok(score >= -1 && score <= 1, `score ${score} out of range`);
  }
});

test('positive funding pushes the funding factor bearish', () => {
  const f = computeSignals(fixture({ fundingRate: 0.001 })).factors.find((x) => x.key === 'funding');
  assert.ok(f.score < 0, 'longs paying funding is a headwind for longs');
});

test('funding is annualised over three 8h periods a day', () => {
  const { metrics } = computeSignals(fixture({ fundingRate: 0.0001 }));
  assert.ok(Math.abs(metrics.fundingAnnualPct - 0.0001 * 3 * 365 * 100) < 1e-9);
});

test('a perp trading above its index leans short on basis', () => {
  const f = computeSignals(fixture({ trend: 0, reference: 5.9 })).factors.find((x) => x.key === 'basis');
  assert.ok(f.score < 0);
});

test('warnings flag an inactive market', () => {
  const s = fixture();
  s.status = 'inactive';
  const { warnings } = computeSignals(s);
  assert.ok(warnings.some((w) => w.text.includes('inactive')));
});

test('depth only counts levels inside the band', () => {
  const book = {
    bids: [{ price: 100, contracts: 10 }, { price: 50, contracts: 999 }],
    asks: [{ price: 101, contracts: 10 }, { price: 200, contracts: 999 }],
  };
  const { bidUsd, askUsd } = depth(book, 100, 1, 5);
  assert.equal(bidUsd, 1000);
  assert.equal(askUsd, 1010);
});

/* ── sizing ─────────────────────────────────────────────────────── */

test('position size risks the requested dollar amount', () => {
  const s = fixture({ trend: 0.004, bidQty: 4000, askQty: 300 });
  const { plan } = computeSignals(s);
  const sized = sizePosition({ snapshot: s, plan, accountUsd: 10_000, riskPct: 1 });

  assert.ok(sized.contracts > 0);
  // Rounding down to whole contracts can only reduce the risk taken.
  assert.ok(sized.actualRiskUsd <= 100 + 1e-9, `risked ${sized.actualRiskUsd}`);
  assert.ok(sized.actualRiskUsd > 100 - sized.lossPerContract);
});

test('reward at target beats risk at stop', () => {
  const s = fixture({ trend: 0.004, bidQty: 4000, askQty: 300 });
  const { plan } = computeSignals(s);
  const sized = sizePosition({ snapshot: s, plan, accountUsd: 10_000, riskPct: 1 });
  assert.ok(sized.profitAtTarget > sized.actualRiskUsd);
});

test('a long pays funding when the rate is positive', () => {
  const s = fixture({ trend: 0.004, bidQty: 4000, askQty: 300, fundingRate: 0.0002 });
  const { plan } = computeSignals(s);
  const sized = sizePosition({ snapshot: s, plan, accountUsd: 10_000, riskPct: 1 });
  assert.equal(plan.side, 'LONG');
  assert.ok(sized.fundingPerPeriod < 0, 'long pays out when funding is positive');
  assert.ok(Math.abs(sized.fundingPerDay - sized.fundingPerPeriod * 3) < 1e-9);
});

test('sizing refuses nonsense inputs', () => {
  const s = fixture({ trend: 0.004 });
  const { plan } = computeSignals(s);
  assert.equal(sizePosition({ snapshot: s, plan, accountUsd: 0, riskPct: 1 }), null);
  assert.equal(sizePosition({ snapshot: s, plan: null, accountUsd: 100, riskPct: 1 }), null);
});
