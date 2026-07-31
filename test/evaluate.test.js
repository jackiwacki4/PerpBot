import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCandidate, selectRobust, splitIndex, tradesFrom, verdict } from '../lib/evaluate.js';
import { STRATEGIES } from '../lib/strategies.js';

/** Bars with a fixed spread, so the cost charged is predictable. */
function bars(closes, spreadPct = 0) {
  return closes.map((close, i) => ({
    t: i * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    bid: close * (1 - spreadPct / 2),
    ask: close * (1 + spreadPct / 2),
    volume: 1,
  }));
}

const constantSignal = (n, v) => Float64Array.from({ length: n }, () => v);

/* ── trade extraction ───────────────────────────────────────────── */

test('trades do not overlap: one per horizon, not one per bar', () => {
  const b = bars(Array.from({ length: 100 }, (_, i) => 100 + i));
  const r = tradesFrom(b, constantSignal(100, 1), { horizon: 10, threshold: 0.5 });
  // 100 bars, 10-bar horizon => 9 non-overlapping entries, not 90.
  assert.equal(r.length, 9);
});

test('a long in a rising market makes money', () => {
  const b = bars(Array.from({ length: 40 }, (_, i) => 100 + i));
  const r = tradesFrom(b, constantSignal(40, 1), { horizon: 10, threshold: 0.5 });
  assert.ok(r.every((x) => x > 0), `expected all positive, got ${r}`);
});

test('a short in a rising market loses money', () => {
  const b = bars(Array.from({ length: 40 }, (_, i) => 100 + i));
  const r = tradesFrom(b, constantSignal(40, -1), { horizon: 10, threshold: 0.5 });
  assert.ok(r.every((x) => x < 0), `expected all negative, got ${r}`);
});

test('the spread is charged on every trade', () => {
  const flat = bars(new Array(40).fill(100));
  const free = tradesFrom(flat, constantSignal(40, 1), { horizon: 10, threshold: 0.5 });
  assert.ok(free.every((r) => Math.abs(r) < 1e-9), 'no spread, flat market => zero');

  const costly = bars(new Array(40).fill(100), 0.002); // 0.2% spread
  const paid = tradesFrom(costly, constantSignal(40, 1), { horizon: 10, threshold: 0.5 });
  // Flat price, so the whole result is the cost: half the spread each way.
  assert.ok(paid.every((r) => Math.abs(r - -0.2) < 1e-6), `expected -0.2%, got ${paid[0]}`);
});

test('a real edge can be wiped out by the spread', () => {
  // Price drifts up 0.05% per 10 bars; the spread costs 0.2% a round trip.
  const closes = Array.from({ length: 60 }, (_, i) => 100 * 1.00005 ** i);
  const r = tradesFrom(bars(closes, 0.002), constantSignal(60, 1), { horizon: 10, threshold: 0.5 });
  assert.ok(r.every((x) => x < 0), 'gross gain smaller than costs must show as a loss');
});

test('signals below the threshold are skipped', () => {
  const b = bars(Array.from({ length: 60 }, (_, i) => 100 + i));
  assert.equal(tradesFrom(b, constantSignal(60, 0.3), { horizon: 10, threshold: 0.5 }).length, 0);
  assert.ok(tradesFrom(b, constantSignal(60, 0.7), { horizon: 10, threshold: 0.5 }).length > 0);
});

test('bars with no opinion are skipped', () => {
  const b = bars(Array.from({ length: 60 }, (_, i) => 100 + i));
  assert.equal(tradesFrom(b, constantSignal(60, NaN), { horizon: 10, threshold: 0.5 }).length, 0);
});

test('the from/to window is respected', () => {
  const b = bars(Array.from({ length: 100 }, (_, i) => 100 + i));
  const first = tradesFrom(b, constantSignal(100, 1), { horizon: 10, threshold: 0.5, from: 0, to: 50 });
  const second = tradesFrom(b, constantSignal(100, 1), { horizon: 10, threshold: 0.5, from: 50, to: 100 });
  assert.equal(first.length, 4);
  assert.equal(second.length, 4);
});

test('splitIndex holds back the later part of history', () => {
  assert.equal(splitIndex(1000, 0.7), 700);
});

/* ── signals may not see the future ─────────────────────────────── */

test('no strategy uses information from later bars', () => {
  const closes = Array.from({ length: 800 }, (_, i) => 100 + Math.sin(i / 20) * 5 + i * 0.01);
  const full = bars(closes, 0.0002);
  const cut = 600;
  const truncated = full.slice(0, cut);
  const funding = [{ at: 0, rate: 0.0001 }];

  for (const [name, def] of Object.entries(STRATEGIES)) {
    for (const params of def.grid.slice(0, 3)) {
      const a = def.build(full, params, { funding });
      const b = def.build(truncated, params, { funding });
      for (let i = 0; i < cut; i++) {
        const x = a[i];
        const y = b[i];
        if (Number.isNaN(x) && Number.isNaN(y)) continue;
        assert.ok(
          Math.abs(x - y) < 1e-9,
          `${name} ${JSON.stringify(params)} changed bar ${i} when later bars were added: ${x} vs ${y}`,
        );
      }
    }
  }
});

/* ── candidate evaluation ───────────────────────────────────────── */

test('evaluateCandidate reports train and test separately', () => {
  const closes = Array.from({ length: 2000 }, (_, i) => 100 + i * 0.01);
  const datasets = [{ ticker: 'T', bars: bars(closes, 0.0001), funding: [] }];
  const candidate = {
    name: 'buyAndHold',
    label: 'Always long (baseline)',
    params: {},
    build: STRATEGIES.buyAndHold.build,
  };
  const [r] = evaluateCandidate(candidate, datasets, { horizons: [15], thresholds: [0.5] });

  assert.ok(r.train.n > 0 && r.test.n > 0);
  // 70/30 split, so training should hold roughly twice as many trades.
  assert.ok(r.train.n > r.test.n, `train ${r.train.n} should exceed test ${r.test.n}`);
  assert.ok(r.exposure > 99, 'always-long is in the market on every bar');
});

test('a market too short to judge is skipped', () => {
  const datasets = [{ ticker: 'T', bars: bars(new Array(100).fill(100)), funding: [] }];
  const candidate = { name: 'buyAndHold', label: 'b', params: {}, build: STRATEGIES.buyAndHold.build };
  const [r] = evaluateCandidate(candidate, datasets, { horizons: [15], thresholds: [0.5] });
  assert.equal(r.train.n, 0);
});

/* ── the pass/fail bar ──────────────────────────────────────────── */

test('a losing held-back result fails', () => {
  const r = { test: { mean: -0.01, tStat: 5 } };
  assert.equal(verdict(r).pass, false);
});

test('a profitable but noisy held-back result fails', () => {
  const r = { test: { mean: 0.01, tStat: 1.2 } };
  assert.equal(verdict(r).pass, false);
});

test('a profitable and significant held-back result passes', () => {
  const r = { test: { mean: 0.02, tStat: 2.5 } };
  assert.equal(verdict(r).pass, true);
});

test('the rolling breakout matches a brute-force scan', () => {
  const closes = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 7) * 4 + Math.cos(i / 3));
  const b = bars(closes);
  const window = 20;
  const fast = STRATEGIES.donchian.build(b, { window });

  for (let i = window; i < b.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - window; j < i; j++) {
      hi = Math.max(hi, b[j].high);
      lo = Math.min(lo, b[j].low);
    }
    const expected = b[i].close > hi ? 1 : b[i].close < lo ? -1 : 0;
    assert.equal(fast[i], expected, `bar ${i}`);
  }
});

/* ── choosing a winner ──────────────────────────────────────────── */

function candidateRow({ name, horizon = 60, threshold = 0.4, params = {}, foldMeans, marketMeans, trainT = 2, test = {} }) {
  return {
    name,
    label: name,
    params,
    horizon,
    threshold,
    train: { n: 500, mean: 0.01, tStat: trainT, winRate: 52 },
    test: { n: 200, mean: 0.01, tStat: 2, winRate: 52, ...test },
    folds: foldMeans.map((mean) => ({ n: 100, mean, tStat: mean * 10, winRate: 52 })),
    trainMarkets: marketMeans.map((mean, i) => ({ ticker: `M${i}`, n: 50, mean, tStat: mean * 10 })),
  };
}

test('a setting that only worked in one stretch of history is rejected', () => {
  const rows = [0, 1, 2].map((i) =>
    candidateRow({
      name: 'x',
      params: { w: i },
      foldMeans: [0.3, -0.1, 0.05], // lost money in the middle stretch
      marketMeans: [0.1, 0.1, 0.1, 0.1],
    }),
  );
  assert.equal(selectRobust(rows), null);
});

test('a setting carried by one market is rejected', () => {
  const rows = [0, 1, 2].map((i) =>
    candidateRow({
      name: 'x',
      params: { w: i },
      foldMeans: [0.1, 0.1, 0.1],
      marketMeans: [0.9, -0.05, -0.05, -0.05], // one winner, three losers
    }),
  );
  assert.equal(selectRobust(rows), null);
});

test('a single lucky setting cannot win without neighbours agreeing', () => {
  const rows = [
    candidateRow({ name: 'x', params: { w: 1 }, foldMeans: [0.2, 0.2, 0.2], marketMeans: [0.1, 0.1, 0.1, 0.1] }),
  ];
  assert.equal(selectRobust(rows), null);
});

test('a broadly consistent family is chosen', () => {
  const rows = [0, 1, 2, 3].map((i) =>
    candidateRow({
      name: 'good',
      params: { w: i },
      foldMeans: [0.1, 0.08, 0.12],
      marketMeans: [0.1, 0.1, 0.1, -0.02],
    }),
  );
  const picked = selectRobust(rows);
  assert.ok(picked, 'expected a pick');
  assert.equal(picked.name, 'good');
  assert.ok(picked.groupSize >= 3);
});

test('the pick is the middle performer, not the peak', () => {
  const rows = [0.05, 0.08, 0.5].map((m, i) =>
    candidateRow({
      name: 'g',
      params: { w: i },
      foldMeans: [m, m, m],
      marketMeans: [0.1, 0.1, 0.1, 0.1],
    }),
  );
  const picked = selectRobust(rows);
  assert.equal(picked.params.w, 1, 'should take the median setting, not the strongest');
});

test('selection never reads the held-back result', () => {
  const make = (testMean) =>
    [0, 1, 2].map((i) =>
      candidateRow({
        name: 'g',
        params: { w: i },
        foldMeans: [0.1, 0.1, 0.1],
        marketMeans: [0.1, 0.1, 0.1, 0.1],
        test: { mean: testMean, tStat: testMean * 100 },
      }),
    );
  const good = selectRobust(make(5));
  const bad = selectRobust(make(-5));
  assert.deepEqual(good.params, bad.params, 'the pick must not change with the test outcome');
});
