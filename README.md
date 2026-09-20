Binary Signal Bot (Discord)
Analysis-only Discord bot for binary/time-based options trading. No auto-trading, no hardcoded signals, no forced direction. Every !binary call fetches live market data from Twelve Data and runs a multi-factor, regime-aware, calibrated prediction engine before replying with UP / DOWN / NO TRADE, a model probability, a separately-tracked historical accuracy, and an expected price - never a fixed number, and never a direction it can't back up.
What it does
Two commands only: !binary SYMBOL DURATION and !binaryaccuracy, plus an offline walk-forward backtester (npm run backtest, see below)
Duration from 5 seconds to 48 hours - plain number (minutes) or with a unit suffix (30s, 2h, 48h)
Pulls live 1-minute candle history + a live quote on every call - nothing is cached or reused between calls
Three-state output: UP / DOWN / NO TRADE. A weak edge, an unstable market, too few usable indicators, or a duration far beyond what recent data can speak to all resolve to NO TRADE instead of a forced direction (src/services/binaryEngine.js, decideFinalSignal)
Raw probability vs calibrated probability, always shown separately. The raw number is what the drift/volatility random-walk math computes. The calibrated number is what THIS exact (expiry length x probability range) combination has actually resolved to in real closed trades - pulled from src/services/calibration.js, never presented as if it's the same thing as the raw number
Expiry-independent modeling. A 1-minute call and a 60-minute call on the same pair are not the same drift mechanically extended further:
calibration is tracked per expiry bucket (src/services/expiryBuckets.js)
a 70% raw reading on a 5-minute trade and a 70% raw reading on a 60-minute trade are calibrated against their own separate track records
expiries of 10+ minutes blend in a higher-timeframe (5m/15m resampled) confluence read, weighted more heavily the longer the expiry - short expiries stay native-timeframe only
drift-decay (see below) keeps confidence from mechanically climbing just because duration grew
Market regime detection (src/services/regime.js): TRENDING / RANGING / BREAKOUT / REVERSAL / UNSTABLE, crossed with a LOW/NORMAL/HIGH volatility axis measured against the pair's own recent history. UNSTABLE (data gaps, extreme volatility spikes) is a hard gate toward NO TRADE, independent of what the probability math says
Grouped confluence, not vote-counting. EMA9/21/50 + MACD are both trend-following and highly correlated, so they're averaged into one TREND group instead of counted as separate "votes". RSI(7) + Stochastic are one MOMENTUM group. Market structure + Support/Resistance + Breakout/Retest are one PRICE_ACTION group. Bollinger %B stands alone as MEAN_REVERSION. The four groups are combined with fixed weights - five correlated trend indicators agreeing no longer outweighs one genuine price-structure read just because there are more of them
Statistical-significance shrinkage: a drift estimate that isn't distinguishable from noise (small relative to its own standard error) is pulled back toward zero
Drift-decay: the drift/tilt measured over the recent lookback window is naturally discounted the further the requested duration goes beyond that window, so confidence tapers back toward 50% for horizons the recent data genuinely can't speak to
Timeframe suggestion: compares the requested duration's own signal clarity against 5-minute and 15-minute resampled versions of the same candles and flags it if another range looks meaningfully cleaner
Every reply shows the full confluence breakdown (grouped scores AND individual factors) so a call can be sanity-checked, not just trusted blindly
Saves every actual trade (not NO_TRADE calls - there's nothing to track a win/loss for on a trade that wasn't taken) to Upstash Redis and tracks it via a 1-minute cron job
!binaryaccuracy shows the actual historical win rate (wins/completed x 100) broken down by expiry length and by market regime separately - shows 0/n honestly until signals have actually closed, never inflated
Walk-forward backtester (src/backtest/run.js) - real out-of-sample validation with zero lookahead, and an optional --seed flag to write results into the live calibration store so the bot isn't starting cold. See "Backtesting" below
What it deliberately does NOT do
No liquidity/order-book analysis. Twelve Data (the data source used for these forex/binary-style pairs) does not expose order-book depth the way an exchange API does - there's no real liquidity data to analyze here, so this doesn't fake one.
No promise of matching a broker's OTC price. If you're checking this against Quotex or a similar broker's OTC pairs, understand that OTC prices are broker-generated and not publicly available from any external API - see the honesty note at the top of binaryEngine.js. This bot analyzes the real market feed; non-OTC pairs during real market hours will track much closer to it than synthetic OTC symbols.
Architecture
src/
  index.js                entrypoint: Discord connection, command routing,
                           the binary-tracker cron, and a plain HTTP health
                           endpoint for the hosting platform
  config.js                env var loading (incl. NO_TRADE gate thresholds)
  services/
    twelvedata.js            Twelve Data REST client (candles + live quote).
                              Now also parses real `volume` when the
                              provider returns it (crypto/equities) - never
                              invented for pairs (mostly forex) that don't
                              have one; see volume.js
    indicators.js             EMA / RSI / MACD / ATR / Stochastic /
                               Bollinger Bands / ADX (all from the
                               `technicalindicators` package) - unchanged,
                               already exposed the *Series variants
                               (rsiSeries, macdSeries) that divergence.js
                               reuses rather than recomputing
    structure.js               swing highs/lows, HH/HL vs LH/LL structure,
                                support/resistance clustering, breakout+retest
                                (all original functions untouched) PLUS
                                additive: scoreLevelStrength/
                                enrichLevelsWithStrength (touch count,
                                spacing, recency, optional volume
                                confirmation) and analyzeBreakoutQuality
                                (volume confirmation, follow-through,
                                false-breakout detection, quality score)
    volume.js                   NEW - RVOL, volume trend, price-volume
                                 relationship, spike detection. Honestly
                                 reports `available:false` (never fakes a
                                 number) when the instrument/window has no
                                 real volume data
    candleQuality.js             NEW - body/wick ratios, engulfing, doji,
                                  inside bar, consecutive-direction,
                                  compression/expansion. Deliberately
                                  modest confluence weight - not a
                                  standalone signal
    divergence.js                 NEW - RSI/MACD/volume divergence:
                                   regular vs hidden, bullish/bearish,
                                   strength, confirmed vs unconfirmed
    sessions.js                    NEW - Asian/London/New York/overlap
                                    session + hour/weekday classification,
                                    derived from the candle's own
                                    timestamp (works identically live and
                                    in the backtester)
    dataQuality.js                  NEW - missing/duplicate/invalid-OHLC/
                                     invalid-volume detection + cleaning
                                     (structural, works in backtest too),
                                     plus a separate wall-clock staleness
                                     check (live-only)
    regime.js                   market regime classifier: TRENDING / RANGING
                                 / BREAKOUT / REVERSAL / UNSTABLE x
                                 LOW/NORMAL/HIGH volatility. Now takes an
                                 optional volumeState 4th argument
                                 (backward compatible) to note when a
                                 trend/breakout lacks volume confirmation
    expiryBuckets.js             shared expiry-length bucketing, used by the
                                  engine, calibration, and reporting so they
                                  all agree on what counts as "the same"
                                  expiry
    calibration.js                probability calibration (per expiry bucket
                                   x probability bin) + actual win-rate
                                   tracking by expiry and by regime - built
                                   entirely from real closed-trade outcomes.
                                   Now also tracks: a recent-window (last 40)
                                   win rate per bucket alongside the all-time
                                   one, session performance, and generic
                                   feature-importance performance (present
                                   vs. absent, per flag - see
                                   recordFeatureOutcome/getAllFeaturePerf)
    binaryEngine.js                the core engine: computeSignalCore() is
                                    the pure, network-free math (data-
                                    quality cleaning, grouped confluence now
                                    including VOLUME/DIVERGENCE/
                                    CANDLE_QUALITY groups, multi-timeframe
                                    blend, drift/vol random walk) shared by
                                    both the live path and the backtester;
                                    decideFinalSignal() is the exported,
                                    reusable NO_TRADE gate logic (data
                                    quality, false breakout, contradictory
                                    momentum, weak structure, regime, edge
                                    threshold); generateBinarySignal() wraps
                                    it all with the live data fetch,
                                    calibration lookup, staleness check, and
                                    the UP/DOWN/NO_TRADE decision
    binaryStore.js                Redis persistence for signals + accuracy
    binaryTracker.js               background job: resolves open signals at
                                    each checkpoint (WIN/LOSS), and feeds
                                    closed outcomes back into calibration.js
                                    - now including session and per-feature
                                    outcome recording
    redisStore.js                   thin Upstash Redis REST wrapper
  commands/
    binary.js, binaryAccuracy.js  thin command handlers - binaryAccuracy.js
                                   now also reports session and
                                   feature-importance breakdowns
  backtest/
    run.js                    walk-forward, out-of-sample backtester CLI -
                               see "Backtesting" below. Now reuses
                               engine.decideFinalSignal() directly (instead
                               of a separately-written approximation) and
                               reports regime/session/quality-bucket/
                               volume-availability/feature-wise breakdowns,
                               no-trade rate, and average realized outcome
  utils/
    formatting.js, logger.js
tests/
  run-all.js, testKit.js, helpers.js, *.test.js   see "Testing" below
A note on dead code from earlier versions
An earlier version of this repo shipped analyze.js, candle.js, historyAnalyze.js, performance.js, review.js, accuracy.js, signal.js, why.js, and health.js under src/commands/, plus scanner.js under src/services/. These were confirmed dead - they require()d services (signalEngine, candlePredictor, historicalAnalysis, riskEngine, portfolioRisk, an accuracy service, strategyHealth) that didn't exist anywhere in the repo, and index.js never wired any of them up. They have been removed (this version's audit re-confirmed zero references anywhere before deleting them) - the commands currently registered are exactly !binary, !binaryaccuracy, and !market (see below), nothing else.
AI analyst architecture (src/services/ai/)
src/services/ai/
  provider.js          the abstraction point - getProvider()/isConfigured()
                        read AI_PROVIDER from config and return the matching
                        implementation. Adding a second provider later means
                        writing one more module shaped like geminiProvider.js
                        and adding one line here - analyst.js, comparison.js,
                        and the Discord command layer never change.
  geminiProvider.js     real Gemini REST call (generateContent), via the
                        Node 20+ built-in fetch - no SDK dependency added.
                        Timeout (AbortController) + limited retry on
                        transport/5xx failures only (never retries a
                        rate-limit into a worse rate-limit).
  fakeProvider.js        same interface as geminiProvider.js, returns
                         canned/deterministic responses - used ONLY by
                         tests, never wired into live provider selection.
  prompt.js               builds the analysis prompt (provider-agnostic -
                           any provider gets the exact same prompt).
  marketContext.js          builds the AI-facing input from the SAME
                             signal object the bot analysis already
                             computed (zero extra market-data fetch) -
                             see its header for the EXACT list of fields
                             stripped out so the AI never sees the bot's
                             own conclusion before forming its own.
  schema.js                 hand-rolled validator for the AI's JSON
                             response (no ajv - not in package.json and
                             this environment had no network to add it,
                             but every field is still type/range/enum
                             checked). Rejects anything resembling a
                             function-call/code field outright (section S).
  analyst.js                 orchestrates provider call + validation,
                              NEVER throws - returns a status of
                              OK/UNAVAILABLE/TIMEOUT/RATE_LIMITED/ERROR so
                              the deterministic bot analysis always
                              continues even when this fails completely.
  comparison.js                the blind comparison engine - normalizes
                                bot + AI outputs into a common schema,
                                classifies AGREEMENT / PARTIAL_AGREEMENT /
                                DISAGREEMENT / INSUFFICIENT_DATA, and
                                surfaces common/conflicting/data-quality-
                                difference evidence explicitly (never
                                hides a disagreement).
Supporting pieces outside services/ai/:
services/nlu.js - deterministic (regex/whitelist-based, NOT another AI call) natural-language command parser. See "Natural-language commands" below for what it can and can't parse.
services/analysisMemory.js - short-lived (default 15 min), Redis- backed, per-Discord-channel memory of the last full analysis, so "explain in Roman Urdu" doesn't need a fresh fetch or AI call. Read-only reuse - never feeds back into any calculation (section O).
services/analysisLog.js - the research database: every !market request writes one structured record (symbol, timestamps, data-quality status, bot output, AI output incl. token usage/latency, comparison result, language, mode) to Redis, separate from binaryStore.js (which tracks actual binary trade signals through to WIN/LOSS - a !market request is a research/explanation event, not a trade).
utils/marketFormatting.js - Discord message layout (full + compact modes) for the !market command's output.
commands/market.js - orchestrates all of the above; the only file that calls more than one of these modules.
Research-grade upgrades: what each one actually changes
Volume (services/volume.js): RVOL, volume trend, spike detection, and a price-volume relationship read (e.g. "price rose but on below-average volume - weaker than it looks"). Feeds into the confluence engine as its own small-weight VOLUME group, into breakout quality (was the break volume-confirmed?), into S/R level strength, and into regime notes - never as a standalone signal, and never fabricated for instruments (mostly forex pairs) that don't have real volume data.
Candle quality (services/candleQuality.js): body/wick ratios, engulfing, doji, rejection, inside bars, consecutive-direction runs, compression/expansion - always read together with structure/momentum/ volume via its own modest confluence weight, never alone.
Divergence engine (services/divergence.js): RSI, MACD, and (when real volume exists) volume divergence against the last two swing highs/lows, each classified regular/hidden, bullish/bearish, with a strength score and a confirmed/unconfirmed flag.
S/R quality (structure.js additions): each level now carries a strength score from touch count, how evenly-spaced the touches are, recency, and (when available) volume confirmation at those touches - not just a touch count.
Breakout quality (structure.js additions): breakout candle strength, volume confirmation, distance beyond the level, follow-through candle count, and explicit false-breakout detection. A breakout's contribution to the confluence tilt is scaled by this quality score (0-1) - an unconfirmed break nudges the read, it doesn't drive it, and a detected false breakout is a hard NO_TRADE gate.
Regime + volume (services/regime.js): TRENDING/RANGING/BREAKOUT/ REVERSAL/UNSTABLE now notes when a trend or breakout lacks volume confirmation, without letting volume (frequently unavailable) silently change the regime classification itself.
Multi-timeframe (already existed - binaryEngine.js): unchanged mechanism (native + higher-timeframe resampled confluence blend for 10min+ expiries), now genuinely exercises volume/candle-quality context where the higher timeframe has enough resampled bars for it.
Session/time-of-day (services/sessions.js): Asian/London/New York/overlap classification, tracked as its own performance breakdown (!binaryaccuracy and the backtester both report it) - not fed into the probability math itself, since forex session effects are subtle and a bot with limited trade volume shouldn't calibrate against them yet (same reasoning as NOT calibrating probability per-regime - see calibration.js's own comment on this trade-off).
Expiry/horizon separation: unchanged design (expiryBuckets.js), now also the basis for a qualityBucket breakdown and volume- availability breakdown in the backtester.
Advanced backtesting (backtest/run.js): now reports total samples, wins/losses, win rate, no-trade rate, average realized outcome, and breakdowns by regime/session/quality-bucket/volume-availability/ feature-flag - and reuses the LIVE decideFinalSignal() gate directly, so the backtest is validating the exact same NO_TRADE logic that runs live, not a hand-maintained approximation of it. The walk-forward design itself IS the train/test split: every point only ever sees candles strictly before it (see the "Backtesting" section and tests/backtest.test.js, which tests this property directly).
Calibration (calibration.js): now tracks a recent-window (last 40 outcomes) win rate per bucket alongside the all-time one, so a bucket whose long-term number looks fine but whose last 20 trades went badly shows up distinctly. Minimum-sample-size gating (30 trades before a bucket is called "confident") is unchanged, and low-sample buckets are never presented as more confident than they are.
Confluence engine (binaryEngine.js): now 7 groups (TREND, MOMENTUM, MEAN_REVERSION, PRICE_ACTION, VOLUME, DIVERGENCE, CANDLE_QUALITY) instead of 4, each contributing only when its own service found real data, weights auto-renormalized around whatever groups actually had something to say. Every factor and group score is in the reply's "Confluence" section - no black-box number.
NO_TRADE filter (decideFinalSignal() in binaryEngine.js): gates now include data-quality failure, false breakout, contradictory trend-vs-momentum, weak/directionless structure inside a ranging regime, unstable regime, too few usable indicators, insufficient calibration samples for a long horizon, higher-timeframe disagreement, and (live-only) stale data - on top of the existing weak-edge check.
Data quality & error handling (services/dataQuality.js): missing- candle gaps, duplicate timestamps, invalid/inconsistent OHLC, and invalid volume readings are detected and cleaned BEFORE any analysis runs, identically live and in the backtester. A validation failure is itself a NO_TRADE gate.
Logging / research record: rather than a separate log store, every signal persisted to Redis (binaryStore.js, unchanged mechanism) now carries the full research snapshot - volume state, candle quality, divergences, session, enriched S/R levels, breakout quality, feature flags, confluence breakdown - so binaryStore.getAll()/getRecent() already is the structured research log requirement, without a duplicate storage system.
Feature importance (calibration.recordFeatureOutcome/ getAllFeaturePerf, wired from binaryTracker.js and backtest/run.js): each feature flag (e.g. volume_confirmed_breakout, divergence_present, htf_ltf_agree) records both its true and false outcomes against real results, so "does this feature actually help" is answerable from data (!binaryaccuracy), not assumed from theory.
Order book / liquidity depth: intentionally NOT implemented, per the explicit instruction not to fake it without a real depth-data provider connected.
Testing
npm test
Runs every tests/*.test.js file (plain Node assert, no external test runner dependency - none was in package.json and this environment had no network access to add one). Covers: volume calculations/RVOL/spike detection, candle classification, divergence detection + scoring, S/R strength scoring, breakout confirmation/false-breakout detection, regime detection (including the UNSTABLE gate), session classification, the walk-forward no-lookahead property itself (candles appended AFTER a decision point must never change that point's result), and every decideFinalSignal NO_TRADE gate individually. calibration.test.js needs a real Redis connection (UPSTASH_REDIS_REST_URL/_TOKEN, same as the live bot) to actually exercise the calibration math - if unreachable, those specific tests log a skip note and pass trivially rather than failing the whole suite over an environment issue unrelated to the code.
1. Twelve Data API key
Sign up free at https://twelvedata.com - the dashboard shows your API key immediately. Free plan: 8 requests/minute, 800/day. This bot uses 2 requests per !binary call (candle history + live quote), computing every indicator and the market-structure read locally from that same data - no extra API calls no matter how many factors are added.
2. Upstash Redis
Create a free Redis database at https://upstash.com, then copy the REST URL and REST TOKEN from the database's REST API tab (not the redis:// connection string - this project uses the REST client).
3. Discord bot token
Create an application + bot at https://discord.com/developers/applications, enable the Message Content privileged intent under the Bot tab, and copy the token from there.
4. Gemini API key (optional - AI analyst)
The deterministic bot (!binary, !binaryaccuracy) works with ZERO AI configuration. !market also works with zero AI configuration - it just shows the bot analysis with the AI section marked unavailable and the comparison as INSUFFICIENT_DATA, rather than failing.
To enable the independent AI analyst: get a free-tier key at https://aistudio.google.com/apikey and set GEMINI_API_KEY. Nothing is hard-coded - provider and model are both environment-configured (see the table below), and the provider is abstracted (src/services/ai/provider.js) so a second AI provider could be added later without touching analyst.js, comparison.js, or the Discord command layer.
Cost control: exactly one Gemini call per fresh !market analysis (never per sub-feature) - natural-language parsing (services/nlu.js) is plain regex, not an AI call, and follow-ups that reuse services/analysisMemory.js make zero calls at all. A 15-second timeout and a small retry budget (transport/5xx only, never on rate-limits) are built in, and any Gemini failure degrades to !market showing the bot analysis alone - it never takes the bot down.
5. Environment variables
Variable
Required
Notes
DISCORD_BOT_TOKEN
yes
from the Discord Developer Portal
TWELVEDATA_API_KEY
yes
from your Twelve Data dashboard
UPSTASH_REDIS_REST_URL
yes
from Upstash
UPSTASH_REDIS_REST_TOKEN
yes
from Upstash
PORT
no
defaults to 3000; the hosting platform usually sets this itself
BINARY_MIN_DURATION_MIN
no
defaults to 5 seconds (5/60)
BINARY_MAX_DURATION_MIN
no
defaults to 2880 (48 hours)
BINARY_HIGH_TRUST_THRESHOLD
no
defaults to 90 (display label threshold, on the calibrated probability)
BINARY_LOOKBACK_MIN
no
defaults to 120 (minutes of history used for the drift/vol statistical core)
BINARY_NO_TRADE_EDGE_PCT
no
defaults to 5 - calibrated probability must be >=55% (50+this) or the reply is NO TRADE
BINARY_MIN_CONFLUENCE_FACTORS
no
defaults to 3 - fewer usable indicators than this forces NO TRADE
BINARY_MTF_DISAGREEMENT_PENALTY
no
defaults to 0.4 - how much edge is stripped when the higher-timeframe read disagrees (expiries >=10 min only)
AI_PROVIDER
no
defaults to gemini - selects the implementation in services/ai/provider.js
GEMINI_API_KEY
no
leave unset to run !market with the AI section disabled
GEMINI_MODEL
no
defaults to gemini-2.0-flash
GEMINI_BASE_URL
no
defaults to the standard Gemini REST base URL
GEMINI_TIMEOUT_MS
no
defaults to 15000
GEMINI_MAX_RETRIES
no
defaults to 1 (transport/5xx failures only)
AI_MEMORY_TTL_MIN
no
defaults to 15 - how long a channel's last !market analysis is remembered for follow-ups
6. Deploy
Push to GitHub, then connect the repo in your hosting platform (Railway, Render, etc.) with build command npm install and start command npm start. Add the environment variables above in the platform's dashboard. (render.yaml in this repo is stale/unused if you're not deploying on Render - safe to ignore or delete.)
7. Use it
From a channel the bot can see:
!binary EURJPY 15
!binary BTCUSD 30s
!binary USDJPY 2h
!binaryaccuracy
A reply looks like:
Direction: UP
Entry Price: 1.08421
Expiry: 15 min (bucket: 10-20 min)
Market Regime: TRENDING, HIGH volatility (91th percentile vs this pair's recent range)

Model (raw) Probability: 68.4% - this is what the drift/volatility math computed, NOT a claim about real-world accuracy
Calibrated Probability: 61.2% (from 47 closed trades in this exact expiry+probability bucket)
Historical Accuracy (10-20 min expiries, all setups): 58.3% (n=212)
Confidence/Quality: MEDIUM
...or, when the setup doesn't clear the bar:
Direction: NO_TRADE (no trade taken)
...
Why NO TRADE:
- calibrated edge (52.1%) is inside the no-trade zone (need >=55%)

(For reference, the raw math leaned UP - shown for transparency only, not a signal to act on.)
Natural-language commands: !market
!market is the entry point for the deterministic bot + independent AI analyst + blind comparison. Everything after !market is parsed by services/nlu.js - a deterministic (regex/whitelist) parser, not another AI call (cost control) - so it understands English, Roman Urdu, and mixed input for the patterns below, but it is NOT a general chat parser: it looks for a known symbol, a duration, a language cue, and one of a handful of intent keywords. Unusual phrasing may not parse - a known limitation, not hidden.
!market EURUSD analyse karo
!market BTCUSD 15m analysis
!market GBP/USD 1 hour
!market 4H horizon ka research analysis karo EURUSD
!market Roman Urdu mein explain karo          (follow-up - reuses last analysis in this channel)
!market Bot aur AI ka comparison dikhao       (follow-up)
!market Sirf differences batao                (follow-up, differences only)
!market Is analysis ki reasoning batao        (follow-up, reasoning only)
!market Data quality check karo GBPUSD        (fresh, data-quality-only view)
!market Last analysis explain karo            (follow-up)
A request with no recognizable symbol is treated as a follow-up on that Discord channel's last !market analysis (services/analysisMemory.js, default 15-minute TTL) - it reformats/re-derives from the already-computed result rather than fetching new data or calling the AI again. If there's no prior analysis in that channel, you get a plain guidance message, not an error.
A full !market reply follows the structure: MARKET ANALYSIS header (symbol, timestamp, data quality) -> BOT ANALYST (deterministic engine's status, key factors, MTF, regime, session) -> AI ANALYST (independent conclusion, evidence, contradictions, limitations - or "unavailable" with a reason if Gemini isn't configured or failed) -> COMPARISON (AGREEMENT / PARTIAL_AGREEMENT / DISAGREEMENT / INSUFFICIENT_DATA, with common evidence, differences, and data-quality differences spelled out explicitly, never hidden) -> RESEARCH SUMMARY (historical accuracy for this horizon bucket) -> AI EXPLANATION (the plain-language summary). Add "compact" to the request for a 3-4 line version instead.
8. Backtesting (out-of-sample, walk-forward, zero lookahead)
Before trusting the bot on a new symbol/expiry combo - or periodically, to refresh calibration - run:
npm run backtest -- EURUSD 5
npm run backtest -- BTCUSD 15 --candles=4000
npm run backtest -- EURUSD 30 --seed
This fetches historical 1-minute candles and, for every point in that history, calls the exact same computeSignalCore() the live bot uses - passing it only the candles up to that point. The real outcome (read from candles after that point, which the function under test never sees) is then compared against the prediction. This is what "walk-forward, no data leakage" means concretely here: the model is evaluated exactly as if it were making that call live, one point at a time, moving forward through history.
It reports:
the actual out-of-sample win rate for that symbol/expiry
a calibration curve: for each raw-probability bin (e.g. "70-75%"), what did readings in that bin actually resolve to?
win rate by market regime
how many points resolved NO_TRADE (excluded from win rate - you can't win or lose a trade that wasn't taken)
Pass --seed to write those results into the same Redis calibration store the live bot reads from, so a new expiry/symbol isn't starting with zero track record. Without seeding, calibration starts cold - raw probabilities are used closer to as-is (clearly flagged as provisional in every reply, via calibrationLowConfidence) until enough real trades close live to calibrate against. Twelve Data's free plan only retains a limited window of 1-minute history, so this is a recent-history backtest, not a multi-year one - re-run periodically, and let live trading accumulate the deeper track record over time.
Notes
This is a read-only analysis tool. It never places, modifies, or cancels any trade. Nothing here is financial advice.
The model's own probability and the bot's actual historical accuracy are two different numbers, shown separately in every reply, on purpose. A 70% reading is a description of what the math computed, not a promise that 70% of such trades will win - check the calibrated probability and the historical accuracy line for what has actually happened.
Direction is computed fresh on every call from live data - nothing is hardcoded per pair, per duration, or otherwise. Two calls made seconds apart can legitimately return different numbers, or different verdicts (UP vs NO_TRADE), because the underlying live data genuinely changed.
If a short duration and a much longer duration on the same pair return the same direction, that's not a bug - it means the measured drift held up across both horizons. The drift-decay mechanism above, and the fact that each expiry length is calibrated against its own separate track record, are exactly what keep this from being true automatically just because durations differ.
NO_TRADE is a feature, not a failure. If the bot is asked for a duration or a market condition it genuinely can't vouch for, it says so instead of forcing UP or DOWN. Expect to see it, especially early on before calibration has accumulated real trades for a given expiry bucket.
AI analyst limitations, stated plainly:
The AI's "independent" analysis is independent of the bot's conclusion, not of the bot's underlying feature computation - both analyses ultimately read the same fetched candles. True dual-source independence would mean two separate market-data providers, which this project does not have.
Gemini's free tier has its own rate limits and may change over time - GEMINI_MAX_RETRIES/GEMINI_TIMEOUT_MS are tuned for a single-user bot on the free tier, not high-volume production traffic.
The comparison engine's per-category (trend/momentum/structure/volume) agreement check converts the bot's confluence group scores into the same BULLISH/BEARISH/NEUTRAL/UNAVAILABLE labels the AI uses, via one fixed threshold (BIAS_SCORE_THRESHOLD in comparison.js) - it's a real, working heuristic, not a claim of perfect semantic alignment between "what the bot's TREND group scored" and "what the AI meant by its trend note".
services/nlu.js is regex/whitelist-based on purpose (cost control - no AI call spent parsing intent). It recognizes a specific, documented set of patterns (see the !market section above) - it is not a general-purpose chat understanding layer, and unusual phrasing may not parse correctly.
The "explain in a different language" follow-up shows the AI summary in whichever language it was originally generated in, with a note, rather than spending a second AI call to translate the cached text - ask fresh (symbol + language together) for a summary in a new language.
