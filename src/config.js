require('dotenv').config();

function num(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    useFutures: (process.env.BINANCE_USE_FUTURES || 'true') === 'true',
  },
  redis: {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  },
discord: {
    token: process.env.DISCORD_BOT_TOKEN || '',
  },
  server: {
    port: num(process.env.PORT, 3000),
  },
  engine: {
    minConfidence: num(process.env.MIN_CONFIDENCE, 65),
    minAlignedCategories: num(process.env.MIN_ALIGNED_CATEGORIES, 4),
    minRiskReward: num(process.env.MIN_RISK_REWARD, 1.5),
    adaptiveMinSamples: num(process.env.ADAPTIVE_MIN_SAMPLES, 20),
    // Only these grades are allowed to actually fire as BUY/SELL by default -
    // everything else becomes NO TRADE with the grade shown as the reason.
    allowedGrades: (process.env.ALLOWED_GRADES || 'A+,A').split(',').map((g) => g.trim()),
    // When true, signals are still computed and logged/tracked but are
    // clearly labelled as PAPER and should not be treated as live calls.
    // Use this to validate any new logic/weight change before flipping it
    // on for real, per the "no direct-to-production" requirement.
    paperMode: (process.env.PAPER_MODE || 'false') === 'true',
  },
  news: {
    enabled: (process.env.NEWS_FILTER_ENABLED || 'true') === 'true',
    // Optional - if unset, the bot still runs abnormal-condition detection
    // from live price action alone (see services/newsFilter.js).
    cryptoPanicToken: process.env.CRYPTOPANIC_API_KEY || '',
    highImpactWindowMinutes: num(process.env.NEWS_HIGH_IMPACT_WINDOW_MIN, 30),
    // ATR percentile (0-1, relative to the pair's own recent history) above
    // which volatility is considered abnormal/extreme rather than merely high.
    extremeAtrPercentile: num(process.env.EXTREME_ATR_PERCENTILE, 0.95),
  },
  timeframes: ['1m', '5m', '15m', '1h', '4h'],

  // ---- Extended (structural) invalidation tracking ----
  invalidation: {
    // Time horizons checked after a structural SL is hit, to see whether
    // price recovers back to the pre-SL reference price. Purely measurement
    // points - the percentages themselves are always computed live from
    // Redis history, never hardcoded.
    checkpoints: [
      { label: '6 ghante', minutes: 6 * 60 },
      { label: '1 din', minutes: 24 * 60 },
      { label: '3 din', minutes: 3 * 24 * 60 },
      { label: '1 hafta', minutes: 7 * 24 * 60 },
      { label: '2 hafte', minutes: 14 * 24 * 60 },
      { label: '1 mahina', minutes: 30 * 24 * 60 },
      { label: '3 mahine', minutes: 90 * 24 * 60 },
    ],
    minSamples: num(process.env.INVALIDATION_MIN_SAMPLES, 12),
  },

  // ---- Twelve Data (used for binary-option style signals; Binance has no
  // forex/OTC data, and Quotex's own OTC feed isn't publicly accessible at
  // all - see binaryEngine.js header for the full honesty note). ----
  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY || '',
    baseUrl: 'https://api.twelvedata.com',
  },

  binary: {
    // Fixed checkpoint fractions of the chosen duration - e.g. a 20-minute
    // trade gets checked at 5, 10, 15 and 20 minutes in.
    checkpointFractions: [0.25, 0.5, 0.75, 1.0],
    minDurationMinutes: num(process.env.BINARY_MIN_DURATION_MIN, 1),
    maxDurationMinutes: num(process.env.BINARY_MAX_DURATION_MIN, 60),
    // Confidence at/above this is called out as a high-trust setup in the
    // reply - it's just a label threshold, the confidence number itself is
    // always computed fresh from live volatility + drift, never hardcoded.
    highTrustThreshold: num(process.env.BINARY_HIGH_TRUST_THRESHOLD, 90),
    lookbackMinutesForStats: num(process.env.BINARY_LOOKBACK_MIN, 120),
    // Max percentage-point nudge the short-term technical tilt (EMA/RSI) can
    // apply to a checkpoint's probability - kept small and additive so it
    // can never dominate or compound with time the way injecting it into
    // the drift term did (that was the root cause of the 95%+-on-everything
    // bug - see binaryEngine.js).
    tiltMaxPct: num(process.env.BINARY_TILT_MAX_PCT, 8),
    // Hard ceiling/floor on any reported probability. No legitimate 1-60
    // minute prediction should ever claim near-certainty - this caps it
    // regardless of what the underlying model computes, as a safety net.
    maxProbabilityPct: num(process.env.BINARY_MAX_PROBABILITY_PCT, 95),
  },

  // ---- Institutional risk engine ----
  // All limits are configurable ceilings; the actual daily/weekly R,
  // drawdown, and streak numbers are always computed fresh from real closed
  // signal history (riskEngine.js) - nothing here is a signal-level number.
  risk: {
    maxDailyLossR: num(process.env.MAX_DAILY_LOSS_R, 3),
    maxWeeklyLossR: num(process.env.MAX_WEEKLY_LOSS_R, 6),
    maxDrawdownR: num(process.env.MAX_DRAWDOWN_R, 8),
    maxConsecutiveLosses: num(process.env.MAX_CONSECUTIVE_LOSSES, 4),
  },

  // ---- Auto-scanner ----
  // Instead of the user manually guessing which single pair to poll,
  // this watches a whole list on a schedule and posts to Discord only when
  // a pair actually clears every gate (same decideDirection path as a
  // manual !signal - nothing special or looser about scanner-found
  // signals). Solves "I keep checking BTCUSDT and it's always quiet" by
  // having the bot check many pairs so the user doesn't have to.
  scanner: {
    enabled: (process.env.SCANNER_ENABLED || 'false') === 'true',
    pairs: (process.env.SCANNER_PAIRS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT,DOTUSDT')
      .split(',').map((p) => p.trim().toUpperCase()).filter(Boolean),
    intervalMinutes: num(process.env.SCANNER_INTERVAL_MIN, 15),
    channelId: process.env.SCANNER_CHANNEL_ID || '',
    // Delay between each pair's data fetch within one scan cycle, so a
    // 10-20 pair watchlist doesn't burst Binance's rate limit the way
    // spamming !signal manually did.
    perPairDelayMs: num(process.env.SCANNER_PER_PAIR_DELAY_MS, 3000),
  },
};
