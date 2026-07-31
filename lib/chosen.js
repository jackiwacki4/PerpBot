// Connects the search to the live dashboard.
//
// `search.js --write` saves the winning strategy to strategy.json. This module
// loads it and applies it to live bars, so the direction shown on screen is the
// one that survived testing rather than a hand-picked blend.
//
// If nothing survived, `chosen` is null and the dashboard says so instead of
// inventing a call.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRATEGIES } from './strategies.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'strategy.json');

let cached;

/** The saved search result, or null if the search has never been run. */
export function loadStrategyFile() {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/** Forget the cached file, so a re-run of the search is picked up. */
export function reloadStrategyFile() {
  cached = undefined;
  return loadStrategyFile();
}

/**
 * Apply the chosen strategy to the live candle history.
 *
 * @param {object[]} bars one-minute bars, oldest first
 * @param {object[]} funding historical funding rates
 * @returns {null | {bias:string, signal:number, ...}}
 */
export function applyChosenStrategy(bars, funding = []) {
  const file = loadStrategyFile();
  const chosen = file?.chosen;
  if (!chosen) return null;

  const def = STRATEGIES[chosen.name];
  if (!def || !bars?.length) return null;

  const signals = def.build(bars, chosen.params, { funding });
  const signal = signals[signals.length - 1];
  if (!Number.isFinite(signal)) return null;

  const bias = signal >= chosen.threshold ? 'LONG' : signal <= -chosen.threshold ? 'SHORT' : 'WAIT';

  return {
    bias,
    signal,
    label: chosen.label,
    params: chosen.params,
    horizon: chosen.horizon,
    threshold: chosen.threshold,
    // The measured result on history the search never saw. This is the only
    // number here that says anything about whether to believe the call.
    tested: {
      trades: chosen.test?.n ?? 0,
      avgPct: chosen.test?.mean ?? NaN,
      winRate: chosen.test?.winRate ?? NaN,
      tStat: chosen.test?.tStat ?? NaN,
    },
    generatedAt: file.generatedAt,
    historyDays: file.historyDays,
  };
}

/** Why there is no tested call, for the dashboard to explain itself. */
export function chosenStatus() {
  const file = loadStrategyFile();
  if (!file) return { state: 'never-run', message: 'No strategy search has been run yet.' };
  if (!file.chosen) {
    return {
      state: 'none-passed',
      message: file.verdict?.reason
        ? `No strategy survived testing (${file.verdict.reason}).`
        : 'No strategy survived testing.',
      generatedAt: file.generatedAt,
      combinationsTested: file.combinationsTested,
    };
  }
  return { state: 'active', generatedAt: file.generatedAt };
}
