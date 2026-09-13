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
    allowedGrades: (process.env.ALLOWED_GRADES || 'A+,A').split(',').map((g) => g.trim()),
    paperMode: (process.env.PAPER_MODE || 'false') === 'true',
  },
  news: {
    enabled: (process.env.NEWS_FILTER_ENABLED || 'true') === 'true',
    cryptoPanicToken: process.env.CRYPTOPANIC_API_KEY || '',
    highImpactWindowMinutes: num(process.env.NEWS_HIGH_IMPACT_WINDOW_MIN, 30),
    extremeAtrPercentile: num(process.env.EXTREME_ATR_PERCENTILE, 0.95),
  },
  timeframes: ['1m', '5m', '15m', '1h', '4h'],

  invalidation: {
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

  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY || '',
    baseUrl: 'https://api.twelvedata.com',
  },

  binary: {
    checkpointFractions: [0.25, 0.5, 0.75, 1.0],
    minDurationMinutes: num(process.env.BINARY_MIN_DURATION_MIN, 1),
    maxDurationMinutes: num(process.env.BINARY_MAX_DURATION_MIN, 60),
    highTrustThreshold: num(process.env.BINARY_HIGH_TRUST_THRESHOLD, 90),
    lookbackMinutesForStats: num(process.env.BINARY_LOOKBACK_MIN, 120),
    tiltMaxPct: num(process.env.BINARY_TILT_MAX_PCT, 8),
    maxProbabilityPct: num(process.env.BINARY_MAX_PROBABILITY_PCT, 95),
  },

  risk: {
    maxDailyLossR: num(process.env.MAX_DAILY_LOSS_R, 3),
    maxWeeklyLossR: num(process.env.MAX_WEEKLY_LOSS_R, 6),
    maxDrawdownR: num(process.env.MAX_DRAWDOWN_R, 8),
    maxConsecutiveLosses: num(process.env.MAX_CONSECUTIVE_LOSSES, 4),
  },
};
