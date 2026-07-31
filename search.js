// Search every strategy and parameter combination, pick a winner on one slice
// of history, and report how it did on a slice the search never saw.
//
//   node search.js              all liquid markets, every horizon
//   node search.js --days 60    how much history to pull
//   node search.js --write      save the winner for the live dashboard to use
//
// Writing the winner to strategy.json is what makes the dashboard follow it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { liquidTickers, loadBars, loadFunding } from './lib/history.js';
import { allCandidates, STRATEGIES } from './lib/strategies.js';
import { evaluateCandidate, familyBreakdown, perMarket, rankCandidates, selectRobust, verdict } from './lib/evaluate.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const HORIZONS = [15, 30, 60, 120, 240];
const THRESHOLDS = [0.2, 0.4, 0.6];

const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);
const pct = (v, d = 4) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : 'n/a');

function describe(params) {
  const entries = Object.entries(params);
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(' ') : '—';
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.log(
    `  ${padr('strategy', 34)} ${padr('params', 22)} ${pad('hz', 4)} ${pad('thr', 4)} ` +
      `${pad('trades', 7)} ${pad('train t', 8)} ${pad('test t', 7)} ${pad('test avg', 10)} ${pad('test win', 9)}`,
  );
  console.log('  ' + '-'.repeat(112));
  for (const r of rows) {
    console.log(
      `  ${padr(r.label.slice(0, 33), 34)} ${padr(describe(r.params).slice(0, 21), 22)} ` +
        `${pad(r.horizon, 4)} ${pad(r.threshold, 4)} ${pad(r.test.n, 7)} ` +
        `${pad(r.train.tStat.toFixed(2), 8)} ${pad(r.test.tStat.toFixed(2), 7)} ` +
        `${pad(pct(r.test.mean), 10)} ${pad(r.test.winRate.toFixed(1) + '%', 9)}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const days = Number(args[args.indexOf('--days') + 1]) || 60;
  const shouldWrite = args.includes('--write');

  const tickers = await liquidTickers();
  console.error(`Loading ${days}d of history for ${tickers.length} markets…`);

  const datasets = [];
  for (const ticker of tickers) {
    const [bars, funding] = await Promise.all([
      loadBars(ticker, { maxDays: days, onProgress: (m) => process.stderr.write(`\r${m}          `) }),
      loadFunding(ticker),
    ]);
    process.stderr.write('\n');
    if (bars.length >= 600) datasets.push({ ticker, bars, funding });
  }

  const totalBars = datasets.reduce((a, d) => a + d.bars.length, 0);
  const span = datasets.length
    ? (Math.max(...datasets.map((d) => d.bars.at(-1).t)) -
        Math.min(...datasets.map((d) => d.bars[0].t))) /
      86400000
    : 0;
  console.error(
    `${datasets.length} markets, ${totalBars.toLocaleString()} bars, ~${span.toFixed(0)} days.\n`,
  );

  const candidates = allCandidates();
  const combos = candidates.length * HORIZONS.length * THRESHOLDS.length;
  console.error(`Testing ${candidates.length} strategy variants x ${HORIZONS.length} horizons x ${THRESHOLDS.length} thresholds = ${combos.toLocaleString()} combinations…`);

  const results = [];
  let done = 0;
  for (const candidate of candidates) {
    results.push(...evaluateCandidate(candidate, datasets, { horizons: HORIZONS, thresholds: THRESHOLDS }));
    process.stderr.write(`\r  ${++done}/${candidates.length} strategy variants`);
  }
  process.stderr.write(`\r  ${done}/${candidates.length} strategy variants done\n`);

  const ranked = rankCandidates(results);
  if (!ranked.length) {
    console.log('\nNothing traded often enough to judge. Try more days or a lower threshold.');
    return;
  }

  printTable('Top 15 by training result (test columns are the held-back data)', ranked.slice(0, 15));

  // The top row of a search is usually the luckiest row. Pick the robust one.
  const best = selectRobust(results);
  const survivors = ranked.filter((r) => verdict(r).pass);

  console.log(`\n${'='.repeat(72)}`);
  console.log('VERDICT');
  console.log('='.repeat(72));

  const peak = ranked[0];
  console.log(`\nBest single row on training (probably the luckiest): ${peak.label} (${describe(peak.params)}) hold ${peak.horizon}m`);
  console.log(`  training t=${peak.train.tStat.toFixed(2)} -> held back t=${peak.test.tStat.toFixed(2)}, avg ${pct(peak.test.mean)}`);

  if (!best) {
    console.log(
      '\nNo strategy was consistent enough to promote: nothing worked in every\n' +
        'stretch of the training period AND in most markets AND with neighbouring\n' +
        'settings agreeing. That is the bar, and nothing cleared it.',
    );
  }

  const v = best ? verdict(best) : { pass: false, reason: 'nothing was consistent enough to promote' };
  let byMarket = [];
  let positive = 0;

  if (best) {
    console.log(`\nMost consistent choice (training data only; ${best.groupSize} nearby settings also passed):`);
    console.log(`  ${best.label} (${describe(best.params)}), hold ${best.horizon}m, act above ${best.threshold}`);
    console.log(`  training : t=${best.train.tStat.toFixed(2)}  avg ${pct(best.train.mean)} over ${best.train.n} trades`);
    console.log(`  held back: t=${best.test.tStat.toFixed(2)}  avg ${pct(best.test.mean)} over ${best.test.n} trades  (${best.test.winRate.toFixed(1)}% won)`);
    console.log(`  ${v.pass ? 'HOLDS UP' : 'DOES NOT HOLD UP'} — ${v.reason}`);

    byMarket = perMarket(STRATEGIES[best.name].build, best.params, datasets, {
      horizon: best.horizon,
      threshold: best.threshold,
    });
    positive = byMarket.filter((m) => m.mean > 0).length;
  }

  // Chance scatters winners evenly across families; a real effect concentrates.
  console.log('\nSurvival rate by family (held-back data, after costs)');
  console.log(`  ${padr('family', 38)} ${pad('tested', 7)} ${pad('survived', 9)} ${pad('rate', 7)}`);
  for (const f of familyBreakdown(results, verdict)) {
    console.log(`  ${padr(f.label.slice(0, 37), 38)} ${pad(f.tested, 7)} ${pad(f.survived, 9)} ${pad(f.rate.toFixed(0) + '%', 7)}`);
  }
  console.log(
    `\n  ${survivors.length} of ${ranked.length} judged combinations survived. Chance alone would give about ${Math.round(ranked.length * 0.023)}.`,
  );
  console.log(
    '  Concentration matters more than the count: noise spreads its winners evenly\n' +
      '  across families, a real effect piles them into one.',
  );

  if (best) {
    console.log(`\nThe chosen setting, market by market (held-back data only)`);
    console.log(`  ${padr('market', 14)} ${pad('trades', 7)} ${pad('avg', 10)} ${pad('won', 7)}`);
    for (const m of byMarket) {
      console.log(`  ${padr(m.ticker, 14)} ${pad(m.n, 7)} ${pad(pct(m.mean), 10)} ${pad(Number.isFinite(m.winRate) ? m.winRate.toFixed(0) + '%' : '—', 7)}`);
    }
    console.log(`\n  Positive in ${positive} of ${byMarket.length} markets.`);
  }

  if (survivors.length) printTable('Everything that survived the held-back data', survivors.slice(0, 10));

  if (shouldWrite) {
    const enoughMarkets = byMarket.length ? positive >= Math.ceil(byMarket.length * 0.6) : false;
    const chosen = best && v.pass && enoughMarkets ? best : null;
    const payload = {
      generatedAt: new Date().toISOString(),
      historyDays: Math.round(span),
      markets: datasets.map((d) => d.ticker),
      combinationsTested: combos,
      chosen: chosen && {
        name: chosen.name,
        label: chosen.label,
        params: chosen.params,
        horizon: chosen.horizon,
        threshold: chosen.threshold,
        train: chosen.train,
        test: chosen.test,
      },
      verdict:
        best && v.pass && !enoughMarkets
          ? { pass: false, reason: `only worked in ${positive} of ${byMarket.length} markets` }
          : v,
      perMarket: byMarket.map((m) => ({ ticker: m.ticker, n: m.n, mean: m.mean, winRate: m.winRate })),
      marketsPositive: positive,
    };
    await fs.writeFile(path.join(ROOT, 'strategy.json'), JSON.stringify(payload, null, 2) + '\n');
    console.log(
      `\nWrote strategy.json — ${chosen ? 'the dashboard will follow this strategy.' : 'no strategy passed, so the dashboard keeps showing conditions only.'}`,
    );
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
