// Front-end: poll the server, paint the dashboard. No frameworks, no build step.

const POLL_MS = 2000;
const MARKETS_REFRESH_MS = 60_000;
const STORAGE_KEY = 'perpbot.prefs';

const state = {
  ticker: null,
  snapshot: null,
  signals: null,
  range: '30',
  failures: 0,
};

const el = (id) => document.getElementById(id);

/* ── formatting ─────────────────────────────────────────────────── */

// Perps range from $0.00001 (kSHIB) to $60,000 (BTC), so pick decimals from
// the magnitude instead of hard-coding two.
function decimalsFor(value) {
  const v = Math.abs(value);
  if (!Number.isFinite(v) || v === 0) return 2;
  if (v >= 1000) return 2;
  if (v >= 10) return 3;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  return 7;
}

function fmtPrice(v, decimals) {
  if (!Number.isFinite(v)) return '—';
  const d = decimals ?? decimalsFor(v);
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtUsd(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function fmtInt(v) {
  return Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
}

function signClass(v) {
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

function row(label, value, cls = '', extraClass = '') {
  return `<div class="row ${extraClass}"><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
}

/* ── preferences ────────────────────────────────────────────────── */

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
}

/* ── data ───────────────────────────────────────────────────────── */

function setStatus(kind, text) {
  el('status-dot').className = `dot ${kind}`;
  el('status-text').textContent = text;
}

async function loadMarkets() {
  const markets = await (await fetch('/api/markets')).json();
  const select = el('market-select');
  const previous = state.ticker ?? loadPrefs().ticker;

  select.innerHTML = markets
    .map(
      (m) =>
        `<option value="${m.ticker}">${m.asset} · ${m.title}${m.status !== 'active' ? ' (inactive)' : ''} — ${fmtUsd(m.volume24hUsd)} 24h</option>`,
    )
    .join('');

  state.ticker = markets.some((m) => m.ticker === previous) ? previous : markets[0]?.ticker;
  select.value = state.ticker;
}

async function poll() {
  if (!state.ticker) return;
  try {
    const res = await fetch(`/api/snapshot?ticker=${encodeURIComponent(state.ticker)}`);
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    const { snapshot, signals } = await res.json();
    state.snapshot = snapshot;
    state.signals = signals;
    state.failures = 0;
    setStatus('live', `live · ${new Date().toLocaleTimeString()}`);
    render();
  } catch (err) {
    state.failures += 1;
    setStatus('error', `retrying (${err.message.slice(0, 60)})`);
  }
}

/* ── rendering ──────────────────────────────────────────────────── */

function renderHeader() {
  const { price, asset, contract } = state.snapshot;
  const { metrics } = state.signals;
  const d = decimalsFor(price.mid);

  el('hdr-price').textContent = `$${fmtPrice(price.mid, d)}`;
  const change = metrics.change1h;
  const changeEl = el('hdr-change');
  changeEl.textContent = Number.isFinite(change) ? `${fmtPct(change, 2)} 1h` : '';
  changeEl.style.color = change >= 0 ? 'var(--long)' : 'var(--short)';

  el('hdr-sub').textContent =
    `${asset} · bid ${fmtPrice(price.bid, d)} / ask ${fmtPrice(price.ask, d)} · ` +
    `index ${fmtPrice(price.index, d)} · contract $${fmtPrice(contract.mid, 4)}`;

  document.title = `$${fmtPrice(price.mid, d)} ${asset} · PerpBot`;
}

function renderVerdict() {
  const { bias, confidence, score, factors } = state.signals;

  const biasEl = el('verdict-bias');
  biasEl.textContent = bias;
  biasEl.className = `verdict-bias ${bias}`;

  el('verdict-conf').textContent = `${confidence}%`;
  el('verdict-conf-bar').style.width = `${confidence}%`;

  const top = [...factors].sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))[0];
  el('verdict-line').textContent =
    bias === 'WAIT'
      ? 'Signals disagree or are too weak. Sitting out is a position.'
      : `Mostly driven by ${top?.short ?? 'mixed signals'}.`;

  // Map score (-1..1) onto the track.
  el('score-needle').style.left = `${((score + 1) / 2) * 100}%`;
  el('signal-updated').textContent = `score ${score >= 0 ? '+' : ''}${score.toFixed(2)}`;
}

function renderFactors() {
  el('factors').innerHTML = state.signals.factors
    .map((f) => {
      const width = Math.abs(f.score) * 50;
      const side = f.score >= 0 ? 'pos' : 'neg';
      const left = f.score >= 0 ? 50 : 50 - width;
      return `
        <div class="factor">
          <div class="factor-name">${f.label}${f.note ? `<em>${f.note}</em>` : ''}</div>
          <div class="factor-value">${f.value}</div>
          <div class="factor-bar"><i class="${side}" style="left:${left}%;width:${width}%"></i></div>
          <div class="factor-detail">${f.detail}</div>
        </div>`;
    })
    .join('');
}

function renderWarnings() {
  const list = state.signals.warnings;
  el('warnings-card').hidden = list.length === 0;
  el('warnings').innerHTML = list
    .map((w) => `<li class="${w.level === 'high' ? 'high' : ''}">${w.text}</li>`)
    .join('');
}

function renderPlan() {
  const { plan } = state.signals;
  const container = el('plan');
  if (!plan) {
    container.innerHTML =
      '<p class="plan-empty">No plan while the read is <strong>WAIT</strong>. Levels appear as soon as the signals line up.</p>';
    return;
  }
  const d = decimalsFor(plan.entry);
  container.innerHTML = `
    <div class="plan-item"><div class="k">Entry (${plan.side.toLowerCase()})</div><div class="v">${fmtPrice(plan.entry, d)}</div><div class="s">at the mid</div></div>
    <div class="plan-item stop"><div class="k">Stop</div><div class="v">${fmtPrice(plan.stop, d)}</div><div class="s">${plan.stopPct.toFixed(2)}% away</div></div>
    <div class="plan-item target"><div class="k">Target</div><div class="v">${fmtPrice(plan.target, d)}</div><div class="s">${plan.riskReward.toFixed(1)}:1 reward</div></div>`;
}

function renderSizer() {
  const { plan, metrics } = state.signals;
  const out = el('sizer');
  const accountUsd = parseFloat(el('account-size').value);
  const riskPct = parseFloat(el('risk-pct').value);

  if (!plan) {
    out.innerHTML = '<p class="plan-empty">Waiting for a directional read before sizing anything.</p>';
    return;
  }
  if (!(accountUsd > 0) || !(riskPct > 0)) {
    out.innerHTML = '<p class="plan-empty">Enter an account size and a risk percentage.</p>';
    return;
  }

  const s = state.snapshot;
  const riskUsd = accountUsd * (riskPct / 100);
  const lossPerContract = plan.stopDistance * s.contractSize;
  const contracts = Math.floor(riskUsd / lossPerContract);
  const notional = contracts * s.contractSize * plan.entry;
  const leverage = notional / accountUsd;
  const fundingPerPeriod = notional * s.funding.rate * (plan.side === 'LONG' ? -1 : 1);
  const profit = contracts * plan.targetDistance * s.contractSize;
  const maxLev = s.stats.leverageEstimate;

  out.innerHTML =
    row('Contracts to buy', fmtInt(contracts), '', 'headline') +
    row('Position size', fmtUsd(notional)) +
    row('Leverage', `${leverage.toFixed(2)}x`, leverage > (maxLev || 5) ? 'neg' : '') +
    row('You lose if stopped out', `-${fmtUsd(contracts * lossPerContract)}`, 'neg') +
    row('You make if target hits', `+${fmtUsd(profit)}`, 'pos') +
    row(
      `Funding per ${8}h`,
      `${fundingPerPeriod >= 0 ? '+' : ''}${fmtUsd(fundingPerPeriod)}`,
      signClass(fundingPerPeriod),
    ) +
    row('Cost of the spread', fmtUsd((s.price.spread / 2) * s.contractSize * contracts)) +
    `<p class="note">Max leverage Kalshi estimates for this market is ${Number.isFinite(maxLev) ? maxLev.toFixed(1) : '—'}x.
     Sizing assumes your stop actually fills at ${fmtPrice(plan.stop, decimalsFor(plan.stop))};
     in a ${metrics.atrPct?.toFixed(2) ?? '—'}%-per-minute tape it may fill worse.</p>`;
}

function renderFunding() {
  const f = state.snapshot.funding;
  const { metrics } = state.signals;
  const mins = metrics.minutesToFunding;

  el('funding-countdown').textContent = Number.isFinite(mins)
    ? `next in ${Math.floor(mins / 60)}h ${String(Math.max(0, Math.round(mins % 60))).padStart(2, '0')}m`
    : '';

  const payer = f.rate > 0 ? 'longs pay shorts' : f.rate < 0 ? 'shorts pay longs' : 'nobody pays';

  el('funding').innerHTML =
    row('Right now', `${(f.rate * 100).toFixed(4)}% / 8h`, signClass(-f.rate), 'headline') +
    row('Adds up to (per year)', fmtPct(metrics.fundingAnnualPct, 1), signClass(-metrics.fundingAnnualPct)) +
    row('Who pays', payer) +
    row('Gap to real price', fmtPct(state.snapshot.price.basisPct, 3), signClass(state.snapshot.price.basisPct));

  drawFundingChart(f.history);
}

function renderBook() {
  const { book, price, contractSize } = state.snapshot;
  const d = decimalsFor(price.mid);
  const asks = book.asks.slice(0, 8).reverse();
  const bids = book.bids.slice(0, 8);
  const maxQty = Math.max(...[...asks, ...bids].map((l) => l.contracts), 1);

  const line = (l, side) => `
    <div class="book-row ${side}">
      <span class="depth" style="width:${(l.contracts / maxQty) * 100}%"></span>
      <span class="p">${fmtPrice(l.price, d)}</span>
      <span class="q">${fmtInt(l.contracts)} · ${fmtUsd(l.contracts * contractSize * l.price)}</span>
    </div>`;

  el('book').innerHTML =
    asks.map((l) => line(l, 'ask')).join('') +
    `<div class="book-mid"><span>${fmtPrice(price.mid, d)}</span>
       <small>spread ${fmtPrice(price.spread, d)} (${fmtPct(price.spreadPct, 3).replace('+', '')})</small></div>` +
    bids.map((l) => line(l, 'bid')).join('');

  const { metrics } = state.signals;
  const imb = metrics.bidDepthUsd + metrics.askDepthUsd
    ? ((metrics.bidDepthUsd - metrics.askDepthUsd) / (metrics.bidDepthUsd + metrics.askDepthUsd)) * 100
    : 0;
  el('book-imbalance').textContent = `${imb >= 0 ? '+' : ''}${imb.toFixed(0)}% ${imb >= 0 ? 'bid' : 'ask'} heavy`;
}

function renderTape() {
  const { trades, price } = state.snapshot;
  const d = decimalsFor(price.mid);
  el('tape').innerHTML = trades
    .slice(0, 30)
    .map(
      (t) => `
      <div class="tape-row ${t.side}">
        <span class="tp">${fmtPrice(t.price, d)}</span>
        <span class="tq">${fmtInt(t.contracts)}</span>
        <span class="tt">${new Date(t.ts).toLocaleTimeString([], { hour12: false })}</span>
      </div>`,
    )
    .join('');
}

function renderStats() {
  const { stats, price } = state.snapshot;
  const { metrics } = state.signals;
  el('stats').innerHTML =
    row('Move: 5m / 15m / 1h', `${fmtPct(metrics.change5m)} · ${fmtPct(metrics.change15m)} · ${fmtPct(metrics.change1h)}`) +
    row('24h change', fmtPct(metrics.change24h), signClass(metrics.change24h)) +
    row('Normal move per minute', `${Number.isFinite(metrics.atrPct) ? metrics.atrPct.toFixed(3) : '—'}%`) +
    row('Overbought meter (0-100)', Number.isFinite(metrics.rsi14) ? metrics.rsi14.toFixed(1) : '—') +
    row('24h volume', fmtUsd(stats.volume24hUsd)) +
    row('Open interest', fmtUsd(stats.openInterestUsd)) +
    row('Orders near the price', fmtUsd(metrics.depthUsd)) +
    row('Kalshi mark price', fmtPrice(price.mark, decimalsFor(price.mid)));
}

/* ── canvas charts ──────────────────────────────────────────────── */

function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.height / (canvas._dpr ?? 1) || canvas.getAttribute('height');
  const cssHeight = parseInt(canvas.getAttribute('height'), 10);
  canvas.width = width * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = `${cssHeight}px`;
  canvas._dpr = dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, cssHeight);
  return { ctx, width, height: cssHeight };
}

function drawPriceChart() {
  const canvas = el('chart');
  const { ctx, width, height } = prepCanvas(canvas);
  const s = state.snapshot;

  const bars = state.range === '7d' ? s.bars1h : s.bars1m.slice(-Number(state.range));
  if (bars.length < 2) return;

  const pad = { top: 12, right: 72, bottom: 18, left: 8 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const values = bars.map((b) => b.close);
  const index = s.price.index;
  const showIndex = state.range !== '7d' && Number.isFinite(index);
  const lo = Math.min(...values, showIndex ? index : Infinity);
  const hi = Math.max(...values, showIndex ? index : -Infinity);
  const span = hi - lo || hi * 0.001 || 1;

  const x = (i) => pad.left + (i / (bars.length - 1)) * plotW;
  const y = (v) => pad.top + plotH - ((v - lo) / span) * plotH;

  // Horizontal guides + right-hand price scale.
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  const d = decimalsFor(hi);
  for (let i = 0; i <= 4; i++) {
    const v = lo + (span * i) / 4;
    const py = y(v);
    ctx.strokeStyle = 'rgba(35,45,58,0.8)';
    ctx.beginPath();
    ctx.moveTo(pad.left, py);
    ctx.lineTo(pad.left + plotW, py);
    ctx.stroke();
    ctx.fillStyle = '#5d6f84';
    ctx.fillText(fmtPrice(v, d), pad.left + plotW + 6, py);
  }

  const rising = values[values.length - 1] >= values[0];
  const stroke = rising ? '#23d18b' : '#ff5c6c';

  // Filled area under the line.
  const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
  gradient.addColorStop(0, rising ? 'rgba(35,209,139,0.22)' : 'rgba(255,92,108,0.22)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(values.length - 1), pad.top + plotH);
  ctx.lineTo(x(0), pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  if (showIndex) {
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y(index));
    ctx.lineTo(pad.left + plotW, y(index));
    ctx.strokeStyle = '#8598ad';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Stop / target guides, so the plan is visible against the price.
  const { plan } = state.signals;
  if (plan) {
    for (const [level, color] of [[plan.stop, '#ff5c6c'], [plan.target, '#23d18b']]) {
      if (level < lo || level > hi) continue;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y(level));
      ctx.lineTo(pad.left + plotW, y(level));
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const label = state.range === '7d' ? 'last 7 days (1h candles)' : `last ${state.range} minutes (1m candles)`;
  el('chart-range-label').textContent = `· ${label}`;
}

function drawFundingChart(history) {
  const canvas = el('funding-chart');
  const { ctx, width, height } = prepCanvas(canvas);
  const bars = [...(history ?? [])].sort((a, b) => a.at - b.at).slice(-24);
  if (!bars.length) return;

  const max = Math.max(...bars.map((b) => Math.abs(b.rate)), 1e-6);
  const zero = height / 2;
  const barW = Math.max(2, (width / bars.length) * 0.65);

  ctx.strokeStyle = 'rgba(35,45,58,1)';
  ctx.beginPath();
  ctx.moveTo(0, zero);
  ctx.lineTo(width, zero);
  ctx.stroke();

  bars.forEach((b, i) => {
    const cx = (i + 0.5) * (width / bars.length);
    const h = (Math.abs(b.rate) / max) * (height / 2 - 6);
    ctx.fillStyle = b.rate >= 0 ? 'rgba(35,209,139,0.75)' : 'rgba(255,92,108,0.75)';
    ctx.fillRect(cx - barW / 2, b.rate >= 0 ? zero - h : zero, barW, h);
  });
}

function render() {
  if (!state.snapshot || !state.signals) return;
  renderHeader();
  renderVerdict();
  renderFactors();
  renderWarnings();
  renderPlan();
  renderSizer();
  renderFunding();
  renderBook();
  renderTape();
  renderStats();
  drawPriceChart();
}

/* ── wiring ─────────────────────────────────────────────────────── */

function bindEvents() {
  el('market-select').addEventListener('change', (e) => {
    state.ticker = e.target.value;
    state.snapshot = null;
    savePrefs({ ticker: state.ticker });
    setStatus('', 'loading…');
    poll();
  });

  el('range-tabs').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    state.range = button.dataset.range;
    [...e.currentTarget.children].forEach((b) => b.classList.toggle('active', b === button));
    if (state.snapshot) drawPriceChart();
  });

  for (const id of ['account-size', 'risk-pct']) {
    el(id).addEventListener('input', () => {
      savePrefs({ [id]: el(id).value });
      if (state.snapshot) renderSizer();
    });
  }

  window.addEventListener('resize', () => {
    if (state.snapshot) {
      drawPriceChart();
      drawFundingChart(state.snapshot.funding.history);
    }
  });
}

async function main() {
  const prefs = loadPrefs();
  if (prefs['account-size']) el('account-size').value = prefs['account-size'];
  if (prefs['risk-pct']) el('risk-pct').value = prefs['risk-pct'];

  bindEvents();
  setStatus('', 'loading markets…');

  try {
    await loadMarkets();
  } catch (err) {
    setStatus('error', `could not load markets: ${err.message}`);
    return;
  }

  await poll();
  setInterval(poll, POLL_MS);
  setInterval(() => loadMarkets().catch(() => {}), MARKETS_REFRESH_MS);
}

main();
