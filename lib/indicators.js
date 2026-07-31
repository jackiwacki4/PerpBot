// Plain-maths helpers. No dependencies, no state — every function takes an
// array of numbers (oldest first) and returns a number or an array.

export function num(value, fallback = NaN) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Exponential moving average over the whole series; returns the latest value. */
export function ema(values, period) {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let acc = values[0];
  for (let i = 1; i < values.length; i++) acc = values[i] * k + acc * (1 - k);
  return acc;
}

/** Wilder's RSI, 0..100. Returns NaN when there is not enough history. */
export function rsi(values, period = 14) {
  if (values.length < period + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * Average true range over OHLC bars, in price units.
 * @param {{high:number, low:number, close:number}[]} bars oldest first
 */
export function atr(bars, period = 14) {
  if (bars.length < 2) return NaN;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    trs.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose),
      ),
    );
  }
  const window = trs.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/** Sample standard deviation. */
export function stdev(values) {
  if (values.length < 2) return NaN;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Percentage change between the first and last value of a series. */
export function pctChange(values) {
  if (values.length < 2) return NaN;
  const first = values[0];
  const last = values[values.length - 1];
  if (!first) return NaN;
  return ((last - first) / first) * 100;
}

/** Squash an unbounded ratio into -1..1 so scores stay comparable. */
export function squash(x, scale) {
  if (!Number.isFinite(x) || !scale) return 0;
  return Math.tanh(x / scale);
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
