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
};
