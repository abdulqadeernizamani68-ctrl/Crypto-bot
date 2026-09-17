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
  },
};
