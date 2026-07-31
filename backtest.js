// Replay history and report whether the score predicts anything.
//
//   node backtest.js                    BTC, 5 days
//   node backtest.js KXETHPERP 7        a different market and window
//   node backtest.js all 5              every liquid market, pooled
//
// See lib/backtest.js for what this can and cannot measure.

import * as kalshi from './lib/kalshi.js';
import { buildSnapshot } from './lib/snapshot.js';
import { buckets, HORIZONS, scoreHistory, summarise, sweepThresholds } from './lib/backtest.js';

const MAX_CANDLES_PER_REQUEST = 5000;

/** Kalshi caps a single request at 5000 candles, so walk backwards in chunks. */
async function fetchBars(ticker, days) {
  const now = Math.floor(Date.now() / 1000);
  const chunks = [];
  let end = now;
  let remaining = days * 24 * 60;

  while (remaining > 0) {
    const size = Math.min(remaining, MAX_CANDLES_PER_REQUEST - 100);
    const start = end - size * 60;
    const res = await kalshi.getCandlesRange(ticker, 1, start, end);
    const candles = res.candlesticks ?? [];
    if (!candles.length) break;
    chunks.unshift(candles);
    end = start;
    remaining -= size;
  }

  const market = (await kalshi.getMarket(ticker)).market;
  const snapshot = buildSnapshot({
    market,
    orderbook: {},
    trades: [],
    candles1m: chunks.flat(),
    candles1h: [],
    fundingEstimate: null,
    fundingHistory: [],
  });
  return snapshot.bars1m;
}

const pct = (v, d = 3) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : '   n/a');
const pad = (s, n) => String(s).padStart(n);

function printReport(label, scored) {
  const report = summarise(scored);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${label} — ${report.samples.toLocaleString()} scored minutes`);
  console.log('='.repeat(72));

  console.log('\nCalls vs. just holding, by how far ahead we look');
  console.log('  horizon    call     n     right   vs baseline    avg move');
  console.log('  ' + '-'.repeat(64));
  for (const h of HORIZONS) {
    const r = report.horizons[h];
    for (const side of ['long', 'short']) {
      const x = r[side];
      console.log(
        `  ${pad(h + 'm', 7)}  ${pad(side.toUpperCase(), 6)}  ${pad(x.n, 5)}  ${pad(x.hitRate.toFixed(1) + '%', 7)}  ` +
          `${pad((x.edge >= 0 ? '+' : '') + x.edge.toFixed(1) + ' pts', 12)}  ${pad(pct(x.avg), 10)}`,
      );
    }
    console.log(
      `  ${pad(h + 'm', 7)}  ${pad('(none)', 6)}  ${pad(r.baseline.n, 5)}  ${pad(r.baseline.up.toFixed(1) + '%', 7)}  ` +
        `${pad('baseline', 12)}  ${pad(pct(r.baseline.avg), 10)}`,
    );
    console.log('  ' + '-'.repeat(64));
  }

  console.log('\nAverage move 15 minutes later, by score bucket');
  console.log('  (if the score means anything, this column should slope upward)');
  console.log('  score range        n      went up     avg move');
  for (const b of buckets(scored, 15)) {
    console.log(
      `  ${pad(b.range, 13)}  ${pad(b.n, 6)}  ${pad(b.upPct.toFixed(1) + '%', 10)}  ${pad(pct(b.avg), 11)}`,
    );
  }

  console.log('\nWhere to draw the line between acting and waiting (15m)');
  console.log('  cutoff   calls made    long edge   short edge   blended');
  for (const s of sweepThresholds(scored, 15)) {
    console.log(
      `  ${pad(s.threshold.toFixed(2), 6)}   ${pad(s.signals + ` (${s.signalPct.toFixed(0)}%)`, 11)}  ` +
        `${pad(s.longEdge.toFixed(1), 10)}  ${pad(s.shortEdge.toFixed(1), 11)}  ${pad(s.blendedEdge.toFixed(1), 8)}`,
    );
  }
}

async function main() {
  const [tickerArg = 'KXBTCPERP', daysArg = '5'] = process.argv.slice(2);
  const days = Number(daysArg);

  let tickers = [tickerArg.toUpperCase()];
  if (tickerArg === 'all') {
    const { markets = [] } = await kalshi.getMarkets();
    tickers = markets
      .filter((m) => m.status === 'active' && Number(m.volume_24h_notional_value_dollars) > 1e6)
      .map((m) => m.ticker);
  }

  const pooled = [];
  for (const ticker of tickers) {
    process.stderr.write(`fetching ${ticker} (${days}d)... `);
    const bars = await fetchBars(ticker, days);
    process.stderr.write(`${bars.length} bars\n`);
    const scored = scoreHistory(bars);
    if (tickers.length === 1) printReport(ticker, scored);
    pooled.push(...scored);
  }

  if (tickers.length > 1) printReport(`${tickers.length} markets pooled`, pooled);

  console.log(
    '\nReminder: this replays the three price-based factors only. The order book,' +
      '\nthe trade tape, funding and the index gap are half the live score and cannot' +
      '\nbe reconstructed from history.\n',
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
