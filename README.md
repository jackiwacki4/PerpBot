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

Free, and about three minutes. Render is the pick — it runs one always-on
process, so it fetches from Kalshi once and reuses that for every tab you have
open.

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. **New → Blueprint**, choose this repo.
3. Deploy. Nothing to fill in — it reads `render.yaml`.

You get a link like `https://perpbot-xxxx.onrender.com` that works on any device.

On the free plan it goes to sleep after 15 minutes of nobody using it and takes
about a minute to wake up. The dashboard refreshes every 2 seconds, so it stays
awake while you're actually watching it — you'd only notice on the first load of
the day.

<details>
<summary>Other ways to host it</summary>

- **Vercel** — `npx vercel`. Uses `vercel.json`. Never sleeps, but it re-fetches
  from Kalshi more often than Render does.
- **Docker** — `docker build -t perpbot . && docker run -p 3000:3000 perpbot`.
  Works on Fly, Railway, Cloud Run, or your own machine.

</details>

## Optional settings

Set these as environment variables if you want them. You don't need any of them.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. Hosts set this for you. |
| `SITE_PASSWORD` | off | Asks for a password before showing the site. Any username works. |
| `RATE_LIMIT_PER_MINUTE` | `120` | Requests allowed per visitor per minute. One open tab uses about 30. |
| `KALSHI_ENV` | `prod` | Set to `demo` for Kalshi's practice exchange. |

There's a `/healthz` URL for uptime checks. It keeps working even with the
password on.

The app holds no keys and reads only public data, so a public link isn't a
security risk. The password is just there if you'd rather keep it to yourself.

## What you're looking at

**Right now** — the headline call: `LONG`, `SHORT`, or `WAIT`, plus how much of
the reading agrees with it. `WAIT` means the signals disagree or are too weak to
be worth acting on. Read the section on whether the signal works before you lean
on this.

**Why** — the seven things that produced that call. Each row votes long (green,
bar right of centre) or short (red, bar left of centre):

| Row | What it reads |
| --- | --- |
| Which way is it drifting? | Whether the 9-minute average is above or below the 21-minute one |
| How hard is it moving? | The last 15 minutes, against how much this market normally moves |
| Has it gone too far? | Overbought or oversold — this one leans *against* the move |
| Orders waiting to fill | Whether buy orders outweigh sell orders near the price |
| Who is actually buying? | Whether recent trades were buyers or sellers being aggressive |
| What it costs to hold | Which side is paying to hold, and how crowded that side is |
| Gap to the real price | How far the perp has drifted from the actual spot price |

Each row shows its technical name in small grey text underneath, so you can look
it up later if you ever want to.

**Trade plan** — entry, stop and target. The stop is 2.5x the market's recent
average minute range, and the target is 1.8x the stop. These come from how much
this market actually moves, not from a forecast.

**How much to buy** — type in your account size and how much of it you're willing
to lose on one trade. It tells you how many contracts to click so that your stop
being hit costs exactly that much, plus the resulting leverage, the funding cost
of holding, and what the spread will cost you.

**Funding** — Kalshi charges funding every 8 hours (04:00, 12:00 and 20:00 UTC).
Positive means longs pay shorts. The countdown shows when the next one settles.

**Orders waiting / Recent trades / The numbers** — resting orders around the price, the most
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

## Does the signal actually work?

Run the backtest and find out for yourself:

```bash
node backtest.js              # BTC, 5 days
node backtest.js all 5        # every liquid market, pooled
```

It replays history one minute at a time, scores each minute using only the data
available at that moment, then checks what price did next.

**What it says today, over ~82,000 minutes across 12 markets:** the score does
not predict short-term direction. Long calls were right 47.1% of the time at 15
minutes, against a 48.2% baseline of price simply rising. Every cut-off from
0.15 to 0.50 came out at or below break-even, and the score buckets are flat
where they should slope.

A single market over a few days sometimes looks much better than that — BTC
alone showed a decent edge — but that disappears the moment you pool markets,
which is what noise does.

So treat the LONG/SHORT/WAIT call as a summary of current conditions, not a
prediction. What this dashboard is genuinely good at is the stuff that isn't a
forecast at all: what a position costs to hold, how wide the spread is, how much
depth is behind the price, and how many contracts match your risk.

Two caveats on the backtest itself. It can only replay the three price-based
factors — the order book, the trade tape, funding and the index gap are half the
live score and aren't available historically. And a few days is a small sample,
so treat anything under a couple of points as noise.

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
predictions, they show no measured edge over the history that can be replayed
(see above), and perpetual futures are leveraged
products where you can lose more than you expect very quickly. Every trade is
your decision.
