# PerpBot

A live dashboard for Kalshi's perpetual futures. Put it on one screen, put Kalshi
on the other, and it tells you what the market is doing while you click.

It does **not** place orders and does **not** need your Kalshi login or API key —
it only reads Kalshi's public market data.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else — no `npm install`,
there are zero dependencies.

```bash
node server.js
```

Then open <http://localhost:3000>.

To use a different port: `PORT=8080 node server.js`.
To point at Kalshi's demo exchange instead of production: `KALSHI_ENV=demo node server.js`.

## What you're looking at

**Right now** — the headline call: `LONG`, `SHORT`, or `WAIT`, with a confidence
number. `WAIT` means the signals disagree or are too weak to be worth acting on.

**Why** — the seven things that produced that call. Each row votes long (green,
bar right of centre) or short (red, bar left of centre):

| Factor | What it reads |
| --- | --- |
| Trend | Whether the 9-minute average is above or below the 21-minute one |
| Momentum | The last 15 minutes, measured against how much this market normally moves |
| Stretch (RSI) | Whether price is overbought or oversold — this one leans *against* the move |
| Order book | Whether resting buy orders outweigh sell orders near the price |
| Aggressive flow | Whether recent fills were buyers lifting offers or sellers hitting bids |
| Funding pressure | Which side is paying to hold, and how crowded that side is |
| Premium to index | How far the perp has drifted from the underlying spot index |

**Trade plan** — entry, stop and target. The stop is 2.5x the market's recent
average minute range, and the target is 1.8x the stop. These come from how much
this market actually moves, not from a forecast.

**Position sizer** — type in your account size and how much of it you're willing
to lose on one trade. It tells you how many contracts to click so that your stop
being hit costs exactly that much, plus the resulting leverage, the funding cost
of holding, and what the spread will cost you.

**Funding** — Kalshi charges funding every 8 hours (04:00, 12:00 and 20:00 UTC).
Positive means longs pay shorts. The countdown shows when the next one settles.

**Order book / Tape / Market stats** — resting orders around the price, the most
recent fills, and the summary numbers.

## Two price scales

Kalshi quotes perps *per contract*. One BTC contract is 0.0001 BTC, so a contract
price of $6.30 means BTC is at $63,000. PerpBot shows the asset price everywhere
(that's the number you think in) and the contract price in small text in the
header — that's the one on Kalshi's order ticket.

## How it fits together

```
browser (public/)  ──▶  server.js  ──▶  Kalshi public perps API
   renders only          proxy + cache      external-api.kalshi.com
                              │
                              ├─ lib/kalshi.js    HTTP client, short-TTL cache
                              ├─ lib/snapshot.js  raw payloads → one clean object
                              ├─ lib/indicators.js  EMA, RSI, ATR, stdev
                              └─ lib/signals.js   factors → bias, plan, sizing
```

The browser can't call Kalshi directly (CORS blocks it), so the server sits in
front. It polls every 2 seconds and caches for ~1 second so Kalshi isn't hammered.

## Tests

```bash
npm test
```

Covers the indicator maths, the price/orderbook/trade normalisation, and the
signal and sizing logic against synthetic markets.

## Adding order execution later

Everything here is read-only by design. Placing orders needs an authenticated
`POST /trade-api/v2/margin/orders`, which requires a Kalshi API key and an
RSA-signed request header. If you add that, keep the key on the server side —
never ship it to the browser.

## Not financial advice

The signals are mechanical readings of live public data. They are not
predictions, they have not been backtested, and perpetual futures are leveraged
products where you can lose more than you expect very quickly. Every trade is
your decision.
