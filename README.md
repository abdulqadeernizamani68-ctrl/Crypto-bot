# Binary Signal Bot (Discord)

Analysis-only Discord bot for binary/time-based options trading. **No auto-trading,
no hardcoded signals.** Every `!binary` call fetches live market data from Twelve
Data and runs a multi-factor confluence engine before replying with a direction,
confidence, and expected price - not a fixed number.

## What it does

- Two commands only: `!binary SYMBOL DURATION` and `!binaryaccuracy`
- Duration from **5 seconds to 48 hours** - plain number (minutes) or with a
  unit suffix (`30s`, `2h`, `48h`)
- Pulls live 1-minute candle history + a live quote on every call - direction
  and confidence are computed fresh every time, never cached or reused
- Statistical core: models price as a random walk with a measured drift and
  volatility (from real recent log-returns), so uncertainty naturally grows
  the further out the checkpoint is
- Drift is refined (not replaced) by a multi-factor confluence read:
  - **Trend**: EMA9/21/50 stack + MACD histogram
  - **Momentum**: RSI(7) + Stochastic(14,3)
  - **Mean-reversion**: Bollinger %B (relevant especially for short durations)
  - **Market structure**: swing-point HH/HL vs LH/LL classification
  - **Support/Resistance**: clustered swing levels, weighted by how many
    times each has been touched
  - **Breakout/Retest**: detects a recent level break and whether it's been
    retested
  - Trend-following factors (EMA, MACD) are automatically down-weighted via
    an **ADX trend-strength gate** when the market is choppy/ranging, since
    trend signals are least reliable exactly when there's no real trend
- Statistical-significance shrinkage: a drift estimate that isn't
  distinguishable from noise (small relative to its own standard error) is
  pulled back toward zero, so confidence stays honest instead of asserting a
  coin-flip direction with false certainty
- Drift-decay: the drift/tilt measured over the recent lookback window is
  naturally discounted the further the requested duration goes beyond that
  window, so confidence tapers back toward 50% for horizons the recent data
  genuinely can't speak to (instead of climbing toward 100% just because the
  duration got longer)
- Volatility regime (LOW/NORMAL/HIGH) judged against the pair's **own**
  recent ATR history - not a fixed threshold
- Timeframe suggestion: compares the requested duration's own signal clarity
  against 5-minute and 15-minute resampled versions of the *same* candles
  (zero extra API calls) and flags it if another range looks meaningfully
  cleaner
- Every checkpoint (25%/50%/75%/expiry) reports direction, confidence, **and**
  an expected price + range - not just up/down
- Every reply shows the full confluence breakdown (which factors leaned
  which way and by how much) so a call can be sanity-checked, not just
  trusted blindly
- Saves every signal to Upstash Redis and tracks it via a 1-minute cron job
  to close it out WIN/LOSS at each checkpoint
- `!binaryaccuracy` shows win rate and per-checkpoint accuracy from real
  closed signals - shows 0/0 honestly until signals have actually closed

## What it deliberately does NOT do

- **No liquidity/order-book analysis.** Twelve Data (the data source used
  for these forex/binary-style pairs) does not expose order-book depth the
  way an exchange API does - there's no real liquidity data to analyze here,
  so this doesn't fake one.
- **No promise of matching a broker's OTC price.** If you're checking this
  against Quotex or a similar broker's OTC pairs, understand that OTC prices
  are broker-generated and not publicly available from any external API -
  see the honesty note at the top of `binaryEngine.js`. This bot analyzes
  the real market feed; non-OTC pairs during real market hours will track
  much closer to it than synthetic OTC symbols.

## Architecture

```
src/
  index.js                entrypoint: Discord connection, command routing,
                           the binary-tracker cron, and a plain HTTP health
                           endpoint for the hosting platform
  config.js                env var loading
  services/
    twelvedata.js            Twelve Data REST client (candles + live quote)
    indicators.js             EMA / RSI / MACD / ATR / Stochastic /
                               Bollinger Bands / ADX (all from the
                               `technicalindicators` package)
    structure.js               swing highs/lows, HH/HL vs LH/LL structure,
                                support/resistance clustering, breakout+retest
    binaryEngine.js              the core engine - combines the statistical
                                  model with the full confluence read above
                                  into a direction + confidence + price
                                  target at each checkpoint
    binaryStore.js                Redis persistence for signals + accuracy
    binaryTracker.js               background job: resolves open signals at
                                    each checkpoint (WIN/LOSS)
    redisStore.js                   thin Upstash Redis REST wrapper
  commands/
    binary.js, binaryAccuracy.js  thin command handlers
  utils/
    formatting.js, logger.js
```

## 1. Twelve Data API key

Sign up free at https://twelvedata.com - the dashboard shows your API key
immediately. Free plan: 8 requests/minute, 800/day. This bot uses 2 requests
per `!binary` call (candle history + live quote), computing every indicator
and the market-structure read locally from that same data - no extra API
calls no matter how many factors are added.

## 2. Upstash Redis

Create a free Redis database at https://upstash.com, then copy the **REST
URL** and **REST TOKEN** from the database's REST API tab (not the
`redis://` connection string - this project uses the REST client).

## 3. Discord bot token

Create an application + bot at https://discord.com/developers/applications,
enable the **Message Content** privileged intent under the Bot tab, and copy
the token from there.

## 4. Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | from the Discord Developer Portal |
| `TWELVEDATA_API_KEY` | yes | from your Twelve Data dashboard |
| `UPSTASH_REDIS_REST_URL` | yes | from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | yes | from Upstash |
| `PORT` | no | defaults to 3000; the hosting platform usually sets this itself |
| `BINARY_MIN_DURATION_MIN` | no | defaults to 5 seconds (`5/60`) |
| `BINARY_MAX_DURATION_MIN` | no | defaults to 2880 (48 hours) |
| `BINARY_HIGH_TRUST_THRESHOLD` | no | defaults to 90 (just a display label threshold) |
| `BINARY_LOOKBACK_MIN` | no | defaults to 120 (minutes of history used for the statistical core) |

## 5. Deploy

Push to GitHub, then connect the repo in your hosting platform (Railway,
Render, etc.) with build command `npm install` and start command
`npm start`. Add the environment variables above in the platform's dashboard.
(`render.yaml` in this repo is stale/unused if you're not deploying on
Render - safe to ignore or delete.)

## 6. Use it

From a channel the bot can see:

```
!binary EURJPY 15
!binary BTCUSD 30s
!binary USDJPY 2h
!binaryaccuracy
```

## Notes

- This is a **read-only analysis tool**. It never places, modifies, or
  cancels any trade. Nothing here is financial advice.
- Confidence and direction are computed fresh on every call from live data -
  nothing is hardcoded per pair, per duration, or otherwise. Two calls made
  seconds apart can legitimately return different numbers because the
  underlying live data genuinely changed.
- If a short duration and a much longer duration on the same pair return the
  same direction, that's not a bug - it means the measured drift held up
  across both horizons. The drift-decay mechanism above is exactly what
  keeps this from being true automatically just because durations differ.
