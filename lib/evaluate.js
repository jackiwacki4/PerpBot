// Scoring a strategy honestly.
//
// Three things here matter more than the strategy code itself, because they are
// what stops a search over thousands of combinations from handing back noise:
//
//  1. Costs are real. Entering and exiting crosses the spread, and the spread
//     that actually existed on each bar is charged. On these markets that is
//     roughly 0.02% a round trip, which is larger than most of the edges being
//     hunted, so a test without it is worthless.
//  2. Samples do not overlap. Measuring a 60-minute return starting from every
//     single minute gives 60x more samples that mostly contain the same price
//     moves, which inflates confidence enormously. Trades are taken one
//     horizon apart instead.
//  3. The winner is chosen on one slice of history and reported on another it
//     never saw. Search hard enough on any dataset and something fits it.

const MIN_TRADES = 60;
/** Training history is cut into this many stretches to check consistency. */
const TRAIN_FOLDS = 3;

function stats(returns) {
  const n = returns.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN, tStat: NaN, winRate: NaN, total: NaN };

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  return {
    n,
    mean,
    sd,
    // How many standard errors the average sits from zero. Below about 2 it is
    // indistinguishable from luck.
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    winRate: (returns.filter((r) => r > 0).length / n) * 100,
    total: mean * n,
  };
}

/**
 * Median spread as a fraction of price, used when a bar has no quote.
 * Sorting the whole series is expensive, so callers that evaluate a market
 * repeatedly should compute this once and pass it in.
 */
export function medianSpreadPct(bars) {
  const spreads = [];
  for (const b of bars) {
    if (b.ask > 0 && b.bid > 0 && b.ask >= b.bid) {
      const mid = (b.ask + b.bid) / 2;
      if (mid > 0) spreads.push((b.ask - b.bid) / mid);
    }
  }
  if (!spreads.length) return 0.0004;
  spreads.sort((a, b) => a - b);
  return spreads[Math.floor(spreads.length / 2)];
}

function spreadAt(bar, fallback) {
  if (bar.ask > 0 && bar.bid > 0 && bar.ask >= bar.bid) {
    const mid = (bar.ask + bar.bid) / 2;
    if (mid > 0) return (bar.ask - bar.bid) / mid;
  }
  return fallback;
}

/**
 * Turn a signal series into a list of non-overlapping trade returns, net of the
 * spread paid getting in and out.
 *
 * @param {object[]} bars
 * @param {Float64Array} signals
 * @param {{horizon:number, threshold:number, from?:number, to?:number}} opts
 * @returns {number[]} net returns in percent
 */
export function tradesFrom(bars, signals, { horizon, threshold, from = 0, to = bars.length, fallbackSpread }) {
  const spreadFallback = fallbackSpread ?? medianSpreadPct(bars);
  const returns = [];
  const end = Math.min(to, bars.length) - horizon;

  for (let i = from; i < end; i += horizon) {
    const signal = signals[i];
    if (!Number.isFinite(signal) || Math.abs(signal) < threshold) continue;

    const entry = bars[i].close;
    const exit = bars[i + horizon].close;
    if (!(entry > 0) || !(exit > 0)) continue;

    const direction = Math.sign(signal);
    const gross = ((exit - entry) / entry) * direction * 100;
    // Half the spread on the way in, half on the way out.
    const cost = ((spreadAt(bars[i], spreadFallback) + spreadAt(bars[i + horizon], spreadFallback)) / 2) * 100;
    returns.push(gross - cost);
  }
  return returns;
}

/** Index that splits history into a search half and a held-back half. */
export function splitIndex(length, trainFraction = 0.7) {
  return Math.floor(length * trainFraction);
}

/**
 * Evaluate one candidate across many markets and every horizon/threshold pair.
 *
 * The signal series depends only on the bars, not on how long a trade is held
 * or how strong a reading has to be before acting, so it is built once per
 * market and reused. Rebuilding it for each combination made the search
 * fifteen times slower for no benefit.
 *
 * @param {{build:Function, params:object}} candidate
 * @param {{ticker:string, bars:object[], funding:object[]}[]} datasets
 */
export function evaluateCandidate(candidate, datasets, { horizons, thresholds, trainFraction = 0.7 }) {
  const buckets = new Map();
  const key = (h, t) => `${h}:${t}`;
  for (const h of horizons) {
    for (const t of thresholds) {
      buckets.set(key(h, t), {
        train: [], test: [], signalBars: 0, totalBars: 0,
        folds: Array.from({ length: TRAIN_FOLDS }, () => []),
        markets: [],
      });
    }
  }

  for (const dataset of datasets) {
    const { bars, funding } = dataset;
    if (bars.length < 600) continue;
    const signals = candidate.build(bars, candidate.params, { funding });
    const split = splitIndex(bars.length, trainFraction);
    const foldSize = Math.floor(split / TRAIN_FOLDS);
    // Cached on the dataset: sorting every spread in the series is far too
    // expensive to repeat for each horizon and threshold.
    dataset.medianSpread ??= medianSpreadPct(bars);
    const fallbackSpread = dataset.medianSpread;

    for (const h of horizons) {
      for (const t of thresholds) {
        const bucket = buckets.get(key(h, t));
        const trainTrades = tradesFrom(bars, signals, { horizon: h, threshold: t, from: 0, to: split, fallbackSpread });
        bucket.train.push(...trainTrades);
        bucket.test.push(...tradesFrom(bars, signals, { horizon: h, threshold: t, from: split, to: bars.length, fallbackSpread }));

        // Consistency, measured two ways, both inside the training period:
        // across time (does it work in every stretch, or only one regime?) and
        // across markets (is it broad, or is one market carrying it?).
        for (let f = 0; f < TRAIN_FOLDS; f++) {
          bucket.folds[f].push(
            ...tradesFrom(bars, signals, {
              horizon: h,
              threshold: t,
              from: f * foldSize,
              to: f === TRAIN_FOLDS - 1 ? split : (f + 1) * foldSize,
              fallbackSpread,
            }),
          );
        }
        bucket.markets.push({ ticker: dataset.ticker, ...stats(trainTrades) });
      }
    }

    // Exposure depends on the threshold only, never on the holding time, so
    // count it once per threshold instead of once per combination.
    for (let ti = 0; ti < thresholds.length; ti++) {
      const t = thresholds[ti];
      let signalBars = 0;
      let totalBars = 0;
      for (let i = 0; i < signals.length; i++) {
        if (!Number.isFinite(signals[i])) continue;
        totalBars++;
        if (Math.abs(signals[i]) >= t) signalBars++;
      }
      for (const h of horizons) {
        const bucket = buckets.get(key(h, t));
        bucket.signalBars += signalBars;
        bucket.totalBars += totalBars;
      }
    }
  }

  const out = [];
  for (const h of horizons) {
    for (const t of thresholds) {
      const bucket = buckets.get(key(h, t));
      out.push({
        name: candidate.name,
        label: candidate.label,
        params: candidate.params,
        horizon: h,
        threshold: t,
        exposure: bucket.totalBars ? (bucket.signalBars / bucket.totalBars) * 100 : 0,
        train: stats(bucket.train),
        test: stats(bucket.test),
        folds: bucket.folds.map(stats),
        trainMarkets: bucket.markets,
      });
    }
  }
  return out;
}

/**
 * Rank candidates by their training result, then report how the best ones did
 * on history the ranking never looked at.
 *
 * Candidates that trade too rarely to say anything are dropped rather than
 * allowed to win on a handful of lucky trades.
 */
export function rankCandidates(results, { minTrades = MIN_TRADES } = {}) {
  return results
    .filter((r) => r.train.n >= minTrades && r.test.n >= minTrades / 2)
    .sort((a, b) => b.train.tStat - a.train.tStat);
}

/**
 * Pick a robust candidate rather than the single best-scoring one.
 *
 * The top row of a search is usually the luckiest row, not the best idea: it is
 * the point where noise happened to line up. A real effect shows up as a
 * plateau, where neighbouring settings all work too. So this scores each
 * (strategy, holding time) group by how its whole parameter range did, then
 * picks the middle-performing member of the best group rather than its peak.
 *
 * Selection uses training data only. The held-back numbers are reported, never
 * chosen on.
 */
export function selectRobust(results, { minTrades = MIN_TRADES, minMarketShare = 0.6 } = {}) {
  const eligible = results.filter((r) => r.train.n >= minTrades && r.test.n >= minTrades / 2);
  if (!eligible.length) return null;

  // Everything below looks only at training data. The held-back slice is
  // reported afterwards and never used to choose.
  const consistent = eligible.filter((r) => {
    const folds = (r.folds ?? []).filter((f) => f.n >= 10);
    // Has to have worked in every stretch of the training period, not just the
    // one that happened to suit it.
    if (folds.length < 2 || !folds.every((f) => f.mean > 0)) return false;

    const markets = (r.trainMarkets ?? []).filter((m) => m.n >= 10);
    if (markets.length < 3) return false;
    // And in most markets, so one lucky market cannot carry it.
    const positive = markets.filter((m) => m.mean > 0).length;
    return positive / markets.length >= minMarketShare;
  });

  if (!consistent.length) return null;

  const score = (r) => {
    const folds = r.folds.filter((f) => f.n >= 10).map((f) => f.tStat);
    // Judged by its weakest stretch, so a setting that only works sometimes
    // cannot win on the strength of its best period.
    return Math.min(...folds);
  };

  // Group the survivors so a lone lucky setting still cannot win: a family and
  // holding time has to have several settings that all passed.
  const groups = new Map();
  for (const r of consistent) {
    const k = `${r.name}:${r.horizon}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  let best = null;
  for (const [, members] of groups) {
    if (members.length < 3) continue;
    const scores = members.map(score).sort((a, b) => a - b);
    const groupScore = scores[Math.floor(scores.length / 2)];
    if (!best || groupScore > best.groupScore) best = { members, groupScore };
  }
  if (!best) return null;

  const sorted = [...best.members].sort((a, b) => score(a) - score(b));
  const pick = sorted[Math.floor(sorted.length / 2)];
  return {
    ...pick,
    groupSize: best.members.length,
    groupRobustness: best.groupScore,
    consistentCount: consistent.length,
  };
}

/**
 * How each strategy family fared out of sample.
 *
 * Chance scatters its winners evenly. A real effect concentrates them in one
 * family, so the shape of this table says more than any single row.
 */
export function familyBreakdown(results, judge) {
  const byFamily = new Map();
  for (const r of results) {
    if (!byFamily.has(r.name)) byFamily.set(r.name, { name: r.name, label: r.label, tested: 0, survived: 0 });
    const f = byFamily.get(r.name);
    f.tested++;
    if (judge(r).pass) f.survived++;
  }
  return [...byFamily.values()]
    .map((f) => ({ ...f, rate: f.tested ? (f.survived / f.tested) * 100 : 0 }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * Re-run one chosen candidate market by market, on held-back data only.
 * An edge carried by a single market is not an edge.
 */
export function perMarket(candidateBuild, params, datasets, { horizon, threshold, trainFraction = 0.7 }) {
  return datasets
    .filter((d) => d.bars.length >= 600)
    .map((d) => {
      const signals = candidateBuild(d.bars, params, { funding: d.funding });
      const split = splitIndex(d.bars.length, trainFraction);
      d.medianSpread ??= medianSpreadPct(d.bars);
      const returns = tradesFrom(d.bars, signals, {
        horizon,
        threshold,
        from: split,
        to: d.bars.length,
        fallbackSpread: d.medianSpread,
      });
      return { ticker: d.ticker, ...stats(returns) };
    })
    .sort((a, b) => b.mean - a.mean);
}

/**
 * Does the winner survive the held-back data?
 *
 * The bar is deliberately blunt: it has to make money after costs, and it has
 * to do so by enough that luck is an unlikely explanation.
 */
export function verdict(result, { minTestT = 2, minMeanPct = 0 } = {}) {
  if (!result) return { pass: false, reason: 'nothing to judge' };
  if (!(result.test.mean > minMeanPct)) {
    return { pass: false, reason: 'lost money after costs on the held-back data' };
  }
  if (!(result.test.tStat >= minTestT)) {
    return {
      pass: false,
      reason: `held-back result is within noise (t=${result.test.tStat.toFixed(2)}, needs ${minTestT})`,
    };
  }
  return { pass: true, reason: `held-back t=${result.test.tStat.toFixed(2)} after costs` };
}
