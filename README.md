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

## Put it on the internet

Any of these work from this repo as-is. **Render is the easiest**, and it suits
this app best: it runs one long-lived process, so the cache in `lib/kalshi.js`
is shared by everyone looking at the site instead of being rebuilt per request.

### Render (recommended)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, pick the repo.
   It reads `render.yaml` and needs no further configuration.
3. You get a `https://perpbot-something.onrender.com` URL.

On Render's free plan the service sleeps after 15 minutes with no traffic and
takes roughly a minute to wake. In practice a dashboard tab polls every 2
seconds, so it stays awake while you're actually using it — you'll only notice
the delay on the first load of the day. The paid plan removes the sleeping.

### Vercel

```bash
npx vercel
```

`vercel.json` serves `public/` from the CDN and routes `/api/*` to
`api/index.js`. No sleeping and it's fast everywhere, but each serverless
instance has its own memory, so the upstream cache is less effective and Kalshi
sees more calls.

### Docker (Fly, Railway, Cloud Run, your own box)

```bash
docker build -t perpbot .
docker run -p 3000:3000 perpbot
```

## Settings for a public deploy

All optional, set as environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. Hosts set this for you. |
| `SITE_PASSWORD` | unset | If set, the site asks for a password (any username). Off by default. |
| `RATE_LIMIT_PER_MINUTE` | `120` | Requests allowed per visitor IP per minute. One open tab uses about 30. |
| `KALSHI_ENV` | `prod` | Set to `demo` for Kalshi's demo exchange. |

There's a `/healthz` endpoint for uptime checks; it stays reachable even when
`SITE_PASSWORD` is on.

Nothing here is secret — the app holds no keys and reads only public data — so a
public URL is not a security problem. The password is just there if you'd rather
not have strangers using your deployment.

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
browser (public/)  ──▶  lib/app.js  ──▶  Kalshi public perps API
   renders only         proxy + cache        external-api.kalshi.com
                             ▲
        server.js ───────────┤  long-running (local, Docker, Render, Fly)
        api/index.js ────────┘  serverless (Vercel)

        lib/kalshi.js      HTTP client, short-TTL cache
        lib/snapshot.js    raw payloads → one clean object
        lib/indicators.js  EMA, RSI, ATR, stdev
        lib/signals.js     factors → bias, plan, sizing
```

The browser doesn't call Kalshi directly — the server proxies it, which sidesteps
any browser cross-origin restrictions and, more usefully, lets one set of
upstream calls serve every open tab. The page polls every 2 seconds while the
cache holds each Kalshi response for about a second.

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
