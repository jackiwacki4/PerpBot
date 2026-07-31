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
the reading agrees with it, and a line stating whether a tested strategy is
behind the call or whether it is only a summary of conditions. When a strategy
does survive the search, it makes the call and its real record is shown next
to it.

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

## Finding a strategy that works

`search.js` pulls every minute of history Kalshi still has (about 58 days,
880,000 bars across 12 markets), tries every strategy family at every setting,
and reports what survives.

```bash
node search.js                # search and report
node search.js --write        # also save the winner for the dashboard to use
node search.js --days 30      # shorter history
```

Families tried: trend following (moving-average crossovers), momentum,
breakouts, two kinds of mean reversion, funding carry, volatility-filtered
trend, and always-long as a baseline — 1,215 combinations in all.

### How it avoids fooling itself

Search hard enough and something always fits. Four things stop that here:

- **Real costs.** Every trade pays the spread that actually existed on those
  bars, in and out. That is about 0.02% a round trip and it is bigger than most
  of the edges on offer, so a test without it is meaningless.
- **No overlapping samples.** Measuring a 4-hour return from every single
  minute gives you 240 copies of the same price move dressed up as 240
  independent results. Trades are taken one holding period apart.
- **A held-back slice.** The last 30% of history is never used to choose
  anything, only to report on the choice.
- **Consistency, not peak score.** The best row in a search is usually the
  luckiest row. A setting is only eligible if it made money in *every* stretch
  of the training period, in *most* markets, and with neighbouring settings
  agreeing. Then the middle performer is picked, not the best.

There are tests covering all of this, including one that proves no strategy can
see future bars and one that proves the choice does not change when the
held-back results change.

### What it found

**No single strategy earned the right to drive the call.** Everything that
looked good in training either lost money on the held-back data or only worked
in a handful of markets. So `strategy.json` holds `chosen: null` and the
dashboard says plainly that nothing tested is behind its call.

**But the search was not a blank.** Look at where the survivors landed:

| Family | Combinations tested | Survived out of sample |
| --- | --- | --- |
| Fade it: distance from the average | 75 | **10** |
| Fade it: buy oversold, sell overbought | 240 | **3** |
| Trend: fast average vs slow average | 465 | 0 |
| Trend, only when it is moving | 180 | 0 |
| Momentum: recent move continues | 105 | 0 |
| Breakout: new high or new low | 75 | 0 |
| Carry: lean against whoever is paying | 60 | 0 |
| Always long (baseline) | 15 | 0 |

Every survivor is a mean-reversion strategy. All 885 trend, momentum, breakout
and carry combinations produced nothing. If this were luck the winners would be
scattered across families in proportion to how many were tried — trend would
have had about ten of them. It had none.

The honest reading: on these markets, over these two months, **fading a
stretched move did something and chasing a move did not**. That is a direction
worth knowing. It is not the same as a profitable system, because the specific
settings that survived were identified by looking at the held-back data, which
is the one thing you are not allowed to do when choosing.

Re-run the search every few weeks. If the same family keeps surviving on fresh
data, the finding is getting stronger.

## Tests## Tests

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
predictions, no strategy has yet survived testing well enough to drive them,
and perpetual futures are leveraged
products where you can lose more than you expect very quickly. Every trade is
your decision.
