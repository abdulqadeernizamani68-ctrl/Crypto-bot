# WhatsApp Crypto Signal Bot

Analysis-only WhatsApp bot. **No auto-trading, no hardcoded signals.** Every `!signal`
call fetches live Binance data and runs a multi-factor confluence engine before
replying `BUY`, `SELL`, or `NO TRADE`.

## What it does

- Two commands only: `!signal BTCUSDT` and `!accuracy`
- Pulls live data every time: multi-timeframe candles (1m/5m/15m/1h/4h), spot +
  futures volume, order book depth, open interest, funding rate
- Scores 12 independent categories (trend, momentum, volatility, volume,
  structure, support/resistance, breakout/retest, liquidity, order book, open
  interest, funding, trap/manipulation risk) and combines them with
  regime-aware + adaptive weights
- Detects market regime (trending/ranging, high/low volatility) and re-weights
  categories accordingly
- Requires multiple independent confirmations + a minimum confidence + a
  minimum risk:reward before ever issuing BUY/SELL — otherwise `NO TRADE`
- Saves every signal to Upstash Redis, tracks price path (MFE/MAE, TP/SL hit)
  every 2 minutes via a cron job, and closes it out as WIN/LOSS
- `!accuracy` shows win rate, profit factor, max drawdown, streaks, the last
  few signals' full price journey, and data-driven insights (only once enough
  samples exist — no invented claims)
- Filter weights adapt slowly based on each category's own historical hit
  rate (bounded 0.6x–1.4x, only after 20+ samples) — nothing is hardcoded to
  one coin or one time period

## Architecture

```
src/
  index.js              entrypoint: WhatsApp connection, command routing, cron
  config.js              env var loading
  services/
    binance.js             Binance REST client (public market data only)
    indicators.js           EMA / RSI / MACD / ATR
    structure.js             swing highs/lows, HH/HL/LH/LL, S/R, breakout+retest
    trapDetection.js          bull/bear trap, stop hunt, false retest detection
    newsFilter.js              price-shock + optional news-event abnormal detection
    regime.js                   market regime detection + regime-based weights
    analysis.js                   the 12 scoring categories
    scoring.js                      weighted confluence -> direction + confidence
    signalEngine.js                   orchestrates everything -> final signal
    redisStore.js                      Upstash Redis persistence layer
    tracker.js                      background job: tracks open signals to close
    waAuthState.js                   Redis-backed WhatsApp session (survives redeploys)
    accuracy.js                       stats, profit factor, drawdown, insights
  commands/
    signal.js, accuracy.js  thin command handlers
  utils/
    formatting.js, logger.js
```

## 1. Binance API keys

Create **read-only** API keys (Spot + Futures market data — do NOT enable
trading/withdrawal permissions; the bot never places orders, so it doesn't
need them). Keep them out of git — only put them in Render's environment
variables.

## 2. Upstash Redis

Create a free Redis database at https://upstash.com, then copy the **REST
URL** and **REST TOKEN** from the database's REST API tab (not the
`redis://` connection string — this project uses the REST client).

## 3. Push to GitHub

```bash
cd whatsapp-crypto-signal-bot
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

`.env` is git-ignored — never commit real keys.

## 4. Deploy on Render

1. New → Web Service → connect your GitHub repo (Render auto-detects
   `render.yaml`, or set Build Command `npm install` / Start Command
   `npm start` manually).
2. In the service's **Environment** tab, add all variables from
   `.env.example` with your real values:
   - `BINANCE_API_KEY`, `BINANCE_API_SECRET`
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - `WA_PHONE_NUMBER` — the WhatsApp number the bot itself will log in as
     (country code + number, digits only, e.g. `923001234567`)
   - `WA_ALLOWED_NUMBERS` — comma-separated numbers allowed to use the bot
   - Tuning vars (`MIN_CONFIDENCE`, etc.) — defaults are fine to start
3. Deploy. Render will run `npm install && npm start`.

## 5. Link WhatsApp (no QR needed)

On first boot, with no existing session, the bot requests a **pairing code**
and prints it in the Render logs:

```
WhatsApp pairing code: ABCD-1234
```

On your phone: WhatsApp → Settings → Linked Devices → Link a Device → Link
with phone number instead → enter that code. The session is then saved to
Redis, so it survives future redeploys/restarts — you only do this once
(until you explicitly log out).

## 6. Use it

From an allowed WhatsApp number, message the bot's linked number:

```
!signal BTCUSDT
!accuracy
```

## Notes

- This is a **read-only market analysis tool**. It never places, modifies, or
  cancels any order. Nothing here is financial advice.
- If `!signal` frequently returns `NO TRADE`, that's by design — the engine
  is tuned to skip low-quality setups rather than force a call.
- The adaptive weighting only starts influencing scores once a category has
  20+ closed-signal samples (`ADAPTIVE_MIN_SAMPLES`), so early results behave
  as a plain rule-based engine and won't overfit to a handful of trades.

### Live data vs. historical data - how they're separated

`BUY` / `SELL` / `NO TRADE` is decided **only** from the current live pass
(candles, order book, OI, funding fetched fresh on every `!signal` call,
combined with regime weights that are themselves computed live). Historical
signal outcomes stored in Redis are never used to pick or flip direction.

Historical data is used for exactly three things:

1. **Confidence calibration** — a bounded multiplier (0.6x–1.4x, only once a
   category has 20+ closed samples) scales the *live* confidence number up
   or down. It can pull a borderline setup below the confidence threshold
   (a legitimate `NO TRADE`), but it can never turn a live BUY into a SELL
   or vice versa.
2. **Weight optimization** — the same bounded multiplier nudges how much
   each category contributes over time, without ever zeroing one out or
   letting one dominate.
3. **Strategy validation** — `!accuracy`'s win rate, profit factor,
   drawdown, streaks, and insights, so you can see what's actually working.

If live analysis and historical performance disagree, live analysis always
wins for direction — history can only mute the confidence, not overrule the
call.

## Additional requirements — how each is met

**1. News & Event Filter** — `services/newsFilter.js`. Two independent
checks run on every `!signal` call: (a) a live price-action shock check
(current candle's range vs. its own ATR, plus % move vs. recent closes,
plus the regime's own ATR percentile) that needs no external API and always
runs; (b) an optional check against CryptoPanic "hot" news for
hack/exploit, ETF-decision, and macro-event keywords, only if
`CRYPTOPANIC_API_KEY` is set. Severe conditions (flash-crash-scale shock, or
a hack headline tied to the asset/an exchange) force `NO TRADE - abnormal
market conditions detected`; merely "high" abnormal conditions apply a 20%
confidence penalty instead of blocking outright. Normal conditions are
untouched.

**2. Duplicate Signal Protection** — `redisStore.getActiveSignal(pair,
direction)`, checked in `signalEngine.decideDirection` before a signal is
finalized. If an OPEN signal already exists for the same pair + direction,
the new one becomes `NO TRADE` with the reason spelled out, instead of
stacking a duplicate call.

**3. Confidence Validation** — `services/scoring.js`. Confidence is built
from live category agreement/magnitude, then calibrated (not replaced) by
each category's own historical hit rate, bounded to a 0.6x–1.4x multiplier
and only trusted once a category has 20+ closed samples. No fixed or
marketing-style numbers anywhere in the pipeline.

**4. Data Failure Protection** — `signalEngine.validateCoreData` /
`dataUnavailableSignal`. If 15m or 1h candles are missing/short, the order
book is empty, or the latest candle is stale (>5 min old), the bot returns
`NO TRADE - DATA UNAVAILABLE` with the specific problem(s) listed, instead
of guessing from partial data or throwing an unhandled error.

**5. Market Trap Detection** — `services/trapDetection.js`, feeding a new
`trapRisk` scoring category. Detects bull/bear traps (breakout that
reverses back within a candle or two, especially with a long opposing wick
or fading volume), stop hunts/liquidity grabs (wick sweep through a level on
a volume spike that closes back on the original side), false retests (a
retest of a broken level that fails to hold), and a thin/one-sided
order-book caution — all computed live from the candles/order book fetched
for that call, nothing hardcoded per pair.

**6. Security** — Binance keys are read only from `process.env` via
`config.js`, never logged (the logger only ever receives error messages,
not the config object), and `.gitignore` excludes `.env`. The bot only
calls Binance's public market-data endpoints (klines, depth, open interest,
funding, 24h ticker) — it never touches an order/account/withdrawal
endpoint, so create the API key as **read-only** with withdrawals disabled
and, where your exchange account supports it, an IP restriction to your
Render service's outbound IP.

**7. Anti-Hardcoding** — `analysis.js`, `structure.js`, `regime.js`, and
`trapDetection.js` all operate purely on the candle/order-book arrays
passed in for the specific pair and timeframe requested — there is no
`if (pair === 'BTCUSDT')`-style branching and no fixed date ranges anywhere.
Historical data is only ever read for performance tracking/calibration
(see the "Live data vs. historical data" section above), never for
direction.

**8. Signal Quality Priority** — `NO TRADE` is a first-class, expected
outcome throughout `decideDirection`, not a fallback to avoid. There is no
code path that forces a BUY/SELL when conditions are weak.

**9. Explainable Signals** — every signal now carries `topReasons`,
`topConfirmations`, and `topInvalidationFactors` (built in
`signalEngine.buildExplanation`), saved alongside the full `categoryScores`
breakdown, trap findings, and market-condition flags in Redis — enough to
reconstruct *why* a call was made without re-running the analysis.

**10. Paper Validation For Updates** — set `PAPER_MODE=true` while testing
any new logic, weight, or threshold change. Signals are still generated,
saved, and tracked exactly as normal (so you get real accuracy stats), but
every WhatsApp message is clearly prefixed `[PAPER MODE - not a live call]`.
Recommended flow: change the logic → run with `PAPER_MODE=true` for a
stretch → check `!accuracy` on the paper period → only then set
`PAPER_MODE=false` (or remove it) to go live with that change.
