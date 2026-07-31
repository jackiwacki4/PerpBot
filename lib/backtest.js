// Does the score actually predict anything?
//
// Walks historical candles one bar at a time, scores each bar using only the
// bars before it, then looks at what price did afterwards. The point is to
// replace opinion about the weights with a number.
//
// Honest limits, worth reading before you trust the output:
//
//  * Only the three price-based factors can be replayed. The order book, the
//    trade tape, funding and the index gap are not available historically, and
//    together they are half the live score. So this measures the price half.
//  * "Hit rate" is measured against the market's own drift over the same
//    window. A market that rose all week makes any long look clever, so the
//    baseline is what matters, not the raw percentage.
//  * A few days of one-minute bars is a small sample. Treat a 2-point edge as
//    noise.

import { blend, priceFactors } from './signals.js';

/** How far ahead to measure, in minutes. */
export const HORIZONS = [5, 15, 30, 60];

/** Bars of history required before a bar can be scored. */
const WARMUP = 120;

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Score every bar that has enough history in front of it and enough future
 * behind it to measure.
 *
 * @param {{close:number, high:number, low:number, t:number}[]} bars oldest first
 * @returns {{index:number, score:number, forward:Record<number, number>}[]}
 */
export function scoreHistory(bars) {
  const maxHorizon = Math.max(...HORIZONS);
  const out = [];

  for (let i = WARMUP; i < bars.length - maxHorizon; i++) {
    // Only bars up to and including i. Anything later would be lookahead.
    const history = bars.slice(Math.max(0, i - 240), i + 1);
    const factors = priceFactors(history);
    if (!factors.length) continue;

    const entry = bars[i].close;
    if (!(entry > 0)) continue;

    const forward = {};
    for (const h of HORIZONS) {
      forward[h] = ((bars[i + h].close - entry) / entry) * 100;
    }
    out.push({ index: i, t: bars[i].t, score: blend(factors), forward });
  }
  return out;
}

/**
 * Summarise scored bars into hit rates and average moves, against the
 * do-nothing baseline over the same bars.
 *
 * @param {number} threshold score magnitude required to call a direction
 */
export function summarise(scored, threshold = 0.3) {
  const report = { threshold, samples: scored.length, horizons: {} };

  for (const h of HORIZONS) {
    const all = scored.map((s) => s.forward[h]);
    const longs = scored.filter((s) => s.score >= threshold).map((s) => s.forward[h]);
    const shorts = scored.filter((s) => s.score <= -threshold).map((s) => s.forward[h]);
    const waits = scored.filter((s) => Math.abs(s.score) < threshold).map((s) => s.forward[h]);

    // Baseline: how often price simply rose over this horizon, regardless of
    // any signal. A long that beats this is doing something; one that doesn't
    // is just riding the market's drift.
    const baselineUp = (all.filter((r) => r > 0).length / (all.length || 1)) * 100;

    report.horizons[h] = {
      baseline: { up: baselineUp, avg: mean(all), n: all.length },
      long: {
        n: longs.length,
        hitRate: (longs.filter((r) => r > 0).length / (longs.length || 1)) * 100,
        edge: (longs.filter((r) => r > 0).length / (longs.length || 1)) * 100 - baselineUp,
        avg: mean(longs),
        median: median(longs),
      },
      short: {
        n: shorts.length,
        hitRate: (shorts.filter((r) => r < 0).length / (shorts.length || 1)) * 100,
        edge:
          (shorts.filter((r) => r < 0).length / (shorts.length || 1)) * 100 - (100 - baselineUp),
        avg: mean(shorts),
        median: median(shorts),
      },
      wait: { n: waits.length, avg: mean(waits) },
    };
  }
  return report;
}

/**
 * Average forward move per score bucket. If the score means anything, this
 * column should slope: more negative buckets should show worse forward
 * returns than more positive ones.
 */
export function buckets(scored, horizon = 15) {
  const edges = [-1, -0.6, -0.4, -0.2, 0.2, 0.4, 0.6, 1.0001];
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const inBucket = scored.filter((s) => s.score >= lo && s.score < hi);
    return {
      range: `${lo.toFixed(1)} to ${hi > 1 ? '1.0' : hi.toFixed(1)}`,
      n: inBucket.length,
      avg: mean(inBucket.map((s) => s.forward[horizon])),
      upPct:
        (inBucket.filter((s) => s.forward[horizon] > 0).length / (inBucket.length || 1)) * 100,
    };
  });
}

/**
 * Sweep candidate thresholds so the decision cut-off is chosen from data
 * rather than picked because 0.3 looked like a round number.
 */
export function sweepThresholds(scored, horizon = 15, candidates = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
  return candidates.map((t) => {
    const r = summarise(scored, t).horizons[horizon];
    const signals = r.long.n + r.short.n;
    return {
      threshold: t,
      signals,
      signalPct: (signals / (scored.length || 1)) * 100,
      longEdge: r.long.edge,
      shortEdge: r.short.edge,
      // One number to rank by: average edge weighted by how many calls it makes.
      blendedEdge:
        signals > 0 ? (r.long.edge * r.long.n + r.short.edge * r.short.n) / signals : NaN,
    };
  });
}
