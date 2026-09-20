require('dotenv').config();

function num(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  redis: {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  },
  discord: {
    token: process.env.DISCORD_BOT_TOKEN || '',
  },
  // Kept even though the Discord !health command was removed - this is a
  // separate plain HTTP endpoint (src/index.js) that hosting platforms
  // like Railway use for their own uptime/health checks on the process.
  server: {
    port: num(process.env.PORT, 3000),
  },

  // ---- Twelve Data (used for binary/time-based signals; Quotex's own OTC
  // feed isn't publicly accessible at all - see binaryEngine.js header for
  // the full honesty note). ----
  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY || '',
    baseUrl: 'https://api.twelvedata.com',
  },

  binary: {
    // Fixed checkpoint fractions of the chosen duration - e.g. a 20-minute
    // trade gets checked at 5, 10, 15 and 20 minutes in.
    checkpointFractions: [0.25, 0.5, 0.75, 1.0],
    // 5 seconds to 48 hours. Below ~1 minute the model is extrapolating
    // below the resolution of the underlying 1-minute candle data (see the
    // honesty note in binaryEngine.js) - it still computes a number, but
    // treat sub-minute confidence as a rougher estimate than 1min+.
    minDurationMinutes: num(process.env.BINARY_MIN_DURATION_MIN, 5 / 60),
    maxDurationMinutes: num(process.env.BINARY_MAX_DURATION_MIN, 48 * 60),
    // Confidence at/above this is called out as a high-trust setup in the
    // reply - it's just a label threshold, the confidence number itself is
    // always computed fresh from live volatility + drift, never hardcoded.
    highTrustThreshold: num(process.env.BINARY_HIGH_TRUST_THRESHOLD, 90),
    lookbackMinutesForStats: num(process.env.BINARY_LOOKBACK_MIN, 120),

    // ---- NO_TRADE gates (see decideFinalSignal in binaryEngine.js) ----
    // Calibrated probability must be at least 50 + this many points before
    // a direction is actually issued instead of NO_TRADE. E.g. 5 means the
    // calibrated edge must be >=55%.
    noTradeEdgeThresholdPct: num(process.env.BINARY_NO_TRADE_EDGE_PCT, 5),
    // Minimum number of usable (non-null) confluence indicators before the
    // read is trusted at all.
    minConfluenceFactors: num(process.env.BINARY_MIN_CONFLUENCE_FACTORS, 3),
    // Fraction of the calibrated edge stripped away when the higher-
    // timeframe confluence disagrees with the native-timeframe one (only
    // applied for expiries >=10 minutes, where a higher timeframe is
    // actually computed). 0.4 = lose 40% of the distance from 50%.
    mtfDisagreementPenalty: num(process.env.BINARY_MTF_DISAGREEMENT_PENALTY, 0.4),
  },

  // Bumped whenever the deterministic engine's scoring/gating logic
  // changes in a way that would make old backtest/calibration results not
  // directly comparable to new ones - stored on every analysis record
  // (see analysisLog.js) and shown in backtest output, per the
  // "parameter/version tracking" requirement.
  analyticsVersion: 'binary-engine-v3',

  // ---- AI provider (independent analyst + final synthesis - see services/ai/) ----
  // Never hard-code a key or a model here; everything comes from the
  // environment. AI_PROVIDER selects the implementation (see
  // services/ai/provider.js); only 'gemini' exists today, but the
  // abstraction is provider-agnostic so a second one can be added without
  // touching the analyst/comparison code that calls it.
  ai: {
    provider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      // Deliberately NO default model: Gemini model ids get deprecated, and
      // a hard-coded default silently turns into a 404 the day that
      // happens. Set GEMINI_MODEL to a currently supported model id. With
      // it unset, the AI stages report "unavailable (GEMINI_MODEL is not
      // set)" instead of calling a stale model - the deterministic bot
      // analysis is unaffected.
      model: (process.env.GEMINI_MODEL || '').trim(),
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      // Per HTTP attempt. A !market run makes two sequential-in-effect
      // Gemini calls (independent analysis, then final synthesis) and users
      // are expected to wait 30s-2min, so this is far more generous than
      // the old 15s single-call default.
      timeoutMs: num(process.env.GEMINI_TIMEOUT_MS, 60000),
      maxRetries: num(process.env.GEMINI_MAX_RETRIES, 1),
      // Newer Gemini models count internal "thinking" tokens against this
      // cap, so a small value can leave no room for the JSON answer itself.
      maxOutputTokens: num(process.env.GEMINI_MAX_OUTPUT_TOKENS, 4096),
    },
    // Only read by services/analysisMemory.js (the older Redis-backed
    // follow-up memory). The unified !market workflow does NOT depend on it
    // - see commands/market.js.
    memoryTtlMinutes: num(process.env.AI_MEMORY_TTL_MIN, 15),
  },

  // ---- Unified !market research workflow (services/marketWorkflow.js) ----
  market: {
    // Hard ceiling for one whole !market run (data fetch + bot + independent
    // AI + final synthesis). When it is hit, in-flight Gemini calls are
    // aborted and whatever finished is reported honestly (or a concise
    // timeout state if nothing did).
    workflowTimeoutMs: num(process.env.MARKET_WORKFLOW_TIMEOUT_MS, 120000),
  },
};
