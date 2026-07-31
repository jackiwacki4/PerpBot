// The candidate strategies the search picks from.
//
// Each family exposes `build(bars, params, ctx)` returning one signal per bar,
// in -1..1, where the signal at index i may only use bars 0..i. Signals are
// produced for the whole series in a single pass, which keeps a search over
// thousands of parameter combinations fast enough to run on a laptop.
//
// NaN means "no opinion here" and is excluded from evaluation rather than
// treated as flat.

const NA = NaN;

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Float64Array(values.length);
  let acc = values[0];
  out[0] = acc;
  for (let i = 1; i < values.length; i++) {
    acc = values[i] * k + acc * (1 - k);
    out[i] = acc;
  }
  return out;
}

/** Rolling standard deviation of one-bar returns, as a fraction. */
function rollingVol(closes, window) {
  const n = closes.length;
  const rets = new Float64Array(n);
  for (let i = 1; i < n; i++) rets[i] = closes[i - 1] ? closes[i] / closes[i - 1] - 1 : 0;

  const out = new Float64Array(n).fill(NA);
  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < n; i++) {
    sum += rets[i];
    sumSq += rets[i] * rets[i];
    if (i > window) {
      sum -= rets[i - window];
      sumSq -= rets[i - window] * rets[i - window];
    }
    const count = Math.min(i, window);
    if (count >= 20) {
      const mean = sum / count;
      out[i] = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    }
  }
  return out;
}

/** Wilder's RSI across the series. */
function rsiSeries(closes, period) {
  const n = closes.length;
  const out = new Float64Array(n).fill(NA);
  if (n <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

const clamp1 = (x) => Math.max(-1, Math.min(1, x));
const closesOf = (bars) => bars.map((b) => b.close);

/* ── families ───────────────────────────────────────────────────── */

export const STRATEGIES = {
  /** Baseline: always long. Anything that can't beat this is not a strategy. */
  buyAndHold: {
    label: 'Always long (baseline)',
    grid: [{}],
    build: (bars) => new Float64Array(bars.length).fill(1),
  },

  /** Fast average above slow average means buyers are in control. */
  emaCross: {
    label: 'Trend: fast average vs slow average',
    grid: crossGrid([3, 5, 9, 12, 20, 30], [21, 26, 40, 60, 100, 180]),
    build: (bars, { fast, slow }) => {
      const closes = closesOf(bars);
      const f = emaSeries(closes, fast);
      const s = emaSeries(closes, slow);
      const vol = rollingVol(closes, 240);
      const out = new Float64Array(bars.length).fill(NA);
      for (let i = slow; i < bars.length; i++) {
        if (!vol[i] || !closes[i]) continue;
        // Gap between the averages, in units of typical bar movement.
        out[i] = clamp1(((f[i] - s[i]) / closes[i] / vol[i]) * 0.25);
      }
      return out;
    },
  },

  /** Keep going the way it has been going, sized by how unusual the move is. */
  timeSeriesMomentum: {
    label: 'Momentum: recent move continues',
    grid: [5, 15, 30, 60, 120, 240, 480].map((lookback) => ({ lookback })),
    build: (bars, { lookback }) => {
      const closes = closesOf(bars);
      const vol = rollingVol(closes, 240);
      const out = new Float64Array(bars.length).fill(NA);
      for (let i = lookback; i < bars.length; i++) {
        if (!vol[i] || !closes[i - lookback]) continue;
        const move = closes[i] / closes[i - lookback] - 1;
        out[i] = clamp1(move / (vol[i] * Math.sqrt(lookback)));
      }
      return out;
    },
  },

  /** The opposite bet: a stretched move snaps back. */
  rsiReversion: {
    label: 'Fade it: buy oversold, sell overbought',
    grid: crossParams({ period: [7, 14, 21, 45], band: [10, 15, 20, 30] }),
    build: (bars, { period, band }) => {
      const r = rsiSeries(closesOf(bars), period);
      const out = new Float64Array(bars.length).fill(NA);
      for (let i = 0; i < bars.length; i++) {
        if (!Number.isFinite(r[i])) continue;
        const hi = 50 + band;
        const lo = 50 - band;
        out[i] = r[i] > hi ? -clamp1((r[i] - hi) / band) : r[i] < lo ? clamp1((lo - r[i]) / band) : 0;
      }
      return out;
    },
  },

  /** Same fade, measured as distance from a moving average instead of RSI. */
  zScoreReversion: {
    label: 'Fade it: distance from the average',
    grid: [30, 60, 120, 240, 480].map((window) => ({ window })),
    build: (bars, { window }) => {
      const closes = closesOf(bars);
      const out = new Float64Array(bars.length).fill(NA);
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        sumSq += closes[i] * closes[i];
        if (i >= window) {
          sum -= closes[i - window];
          sumSq -= closes[i - window] * closes[i - window];
        }
        const count = Math.min(i + 1, window);
        if (count < window) continue;
        const mean = sum / count;
        const sd = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        if (sd > 0) out[i] = clamp1(-((closes[i] - mean) / sd) / 2);
      }
      return out;
    },
  },

  /** Break out of the recent range and keep going. */
  donchian: {
    label: 'Breakout: new high or new low',
    grid: [20, 60, 120, 240, 480].map((window) => ({ window })),
    build: (bars, { window }) => {
      const n = bars.length;
      const out = new Float64Array(n).fill(NA);
      // Rolling max/min via monotonic deques, so a 480-bar window costs the
      // same as a 20-bar one. The naive nested loop made the search unusable.
      const maxQ = [];
      const minQ = [];
      for (let i = 0; i < n; i++) {
        if (i >= window) {
          const c = bars[i].close;
          out[i] = c > bars[maxQ[0]].high ? 1 : c < bars[minQ[0]].low ? -1 : 0;
        }
        while (maxQ.length && bars[maxQ.at(-1)].high <= bars[i].high) maxQ.pop();
        maxQ.push(i);
        while (minQ.length && bars[minQ.at(-1)].low >= bars[i].low) minQ.pop();
        minQ.push(i);
        // Drop indices that have fallen out of the trailing window.
        if (maxQ[0] <= i - window) maxQ.shift();
        if (minQ[0] <= i - window) minQ.shift();
      }
      return out;
    },
  },

  /**
   * Carry: when longs are paying to hold, lean short, and vice versa.
   * Unlike the others this has an economic reason to exist rather than
   * being a shape someone noticed on a chart.
   */
  fundingCarry: {
    label: 'Carry: lean against whoever is paying',
    grid: [0, 0.00005, 0.0001, 0.0002].map((minRate) => ({ minRate })),
    build: (bars, { minRate }, ctx) => {
      const rates = ctx?.funding ?? [];
      const out = new Float64Array(bars.length).fill(NA);
      if (!rates.length) return out;

      let k = 0;
      for (let i = 0; i < bars.length; i++) {
        // Advance to the most recent funding print at or before this bar.
        while (k + 1 < rates.length && rates[k + 1].at <= bars[i].t) k++;
        if (rates[k].at > bars[i].t) continue;
        const rate = rates[k].rate;
        out[i] = Math.abs(rate) < minRate ? 0 : clamp1(-rate / 0.0005);
      }
      return out;
    },
  },

  /** Trend, but only when the market is actually moving. */
  volFilteredTrend: {
    label: 'Trend, only when it is moving',
    grid: crossParams({ lookback: [15, 30, 60, 120], volMult: [1.0, 1.3, 1.8] }),
    build: (bars, { lookback, volMult }) => {
      const closes = closesOf(bars);
      const fast = rollingVol(closes, 60);
      const slow = rollingVol(closes, 480);
      const vol = rollingVol(closes, 240);
      const out = new Float64Array(bars.length).fill(NA);
      for (let i = lookback; i < bars.length; i++) {
        if (!vol[i] || !fast[i] || !slow[i] || !closes[i - lookback]) continue;
        // Sit out unless short-term volatility is elevated versus its own norm.
        if (fast[i] < slow[i] * volMult) {
          out[i] = 0;
          continue;
        }
        const move = closes[i] / closes[i - lookback] - 1;
        out[i] = clamp1(move / (vol[i] * Math.sqrt(lookback)));
      }
      return out;
    },
  },
};

/* ── grid helpers ───────────────────────────────────────────────── */

function crossGrid(fasts, slows) {
  const out = [];
  for (const fast of fasts) for (const slow of slows) if (slow > fast * 1.5) out.push({ fast, slow });
  return out;
}

function crossParams(spec) {
  const keys = Object.keys(spec);
  let combos = [{}];
  for (const key of keys) {
    combos = combos.flatMap((base) => spec[key].map((v) => ({ ...base, [key]: v })));
  }
  return combos;
}

/** Every (strategy, parameter set) pair the search will consider. */
export function allCandidates() {
  return Object.entries(STRATEGIES).flatMap(([name, def]) =>
    def.grid.map((params) => ({ name, label: def.label, params, build: def.build })),
  );
}
