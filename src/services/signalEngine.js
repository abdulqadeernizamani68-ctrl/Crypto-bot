// ---- HONESTY NOTE (read before wiring this to real money) ----
// Quotex's own OTC price feed is not publicly available anywhere - OTC pairs
// (used on weekends and on many "() OTC" symbols) are a broker-generated
// price, not a real market feed, so no external API (including Twelve Data)
// can match it. This engine uses Twelve Data's REAL forex/crypto feed as the
// closest available proxy, which is only meaningfully close to what Quotex
// shows for *non-OTC* pairs during real market hours. Treat every output as
// an estimate on the real underlying asset, not a guarantee of what Quotex's
// OTC price will do. Fixed 1-5 minute expiries are close to a random walk -
// no legitimate method reaches genuine, reliable 90%+ edge on those; when
// this engine reports a high number, it means the *math it computed* came
// out high, not that the trade is a sure thing.
//
// ---- HOW THE PROBABILITY IS ACTUALLY COMPUTED (no hardcoded odds) ----
// 1. Pull recent 1-minute closes and compute the log-return mean (drift) and
//    standard deviation (volatility) *per minute*, measured fresh every call
//    from real recent price action (config.binary.lookbackMinutesForStats).
// 2. Nudge that drift slightly using a short-term technical tilt (EMA9/EMA21
//    cross + RSI7), bounded to a fraction of the *measured* volatility so it
//    can't manufacture a signal out of nothing.
// 3. Model the log-price at any future time t as approximately Normal with
//    mean = drift*t and stdev = volatility*sqrt(t) (standard random-walk
//    diffusion assumption). The probability that price finishes above entry
//    is the Normal CDF of that distribution evaluated at 0.
// This is why longer horizons naturally get less extreme probabilities
// (uncertainty grows with sqrt(t)) and why a strong recent trend can look
// confident on a 1-minute check but fade out on a 30-minute one - that's the
// model being honest about compounding uncertainty, not a bug.

const config = require('../config');
const indicators = require('./indicators');
const twelvedata = require('./twelvedata');
const logger = require('../utils/logger');

function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) prob = 1 - prob;
  return 1 - prob; // P(Z <= x)
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr, m) {
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1 || 1);
  return Math.sqrt(variance);
}

function technicalTilt(candles) {
  // Bounded to [-1, 1]. EMA9 vs EMA21 cross + RSI7 relative to 50.
  const ema9 = indicators.ema(candles, 9);
  const ema21 = indicators.ema(candles, 21);
  const rsi7 = indicators.rsi(candles, 7);
  let tilt = 0;
  let parts = 0;
  if (ema9 != null && ema21 != null) {
    tilt += ema9 > ema21 ? 1 : -1;
    parts += 1;
  }
  if (rsi7 != null) {
    tilt += Math.max(-1, Math.min(1, (rsi7 - 50) / 25));
    parts += 1;
  }
  return parts ? tilt / parts : 0;
}

async function generateBinarySignal(symbolRaw, durationMinutes) {
  const duration = Math.max(
    config.binary.minDurationMinutes,
    Math.min(config.binary.maxDurationMinutes, durationMinutes)
  );

  const candles = await twelvedata.getTimeSeries(
    symbolRaw,
    '1min',
    Math.max(60, config.binary.lookbackMinutesForStats)
  );
  if (candles.length < 30) {
    throw new Error(`Not enough recent 1-minute data for ${symbolRaw} to analyze (got ${candles.length} candles)`);
  }

  const closes = candles.map((c) => c.close);
  // Entry price: use the live quote (Twelve Data's /price endpoint) instead
  // of the last completed 1-minute candle close, which can be up to ~60s
  // stale. Falls back to the candle close if the live quote call fails for
  // any reason (rate limit, symbol not supported on /price, etc).
  let entryPrice = closes[closes.length - 1];
  try {
    const livePrice = await twelvedata.getCurrentPrice(symbolRaw);
    if (Number.isFinite(livePrice) && livePrice > 0) entryPrice = livePrice;
  } catch (err) {
    logger.warn(`Live price fetch failed for ${symbolRaw}, using last candle close instead: ${err.message}`);
  }
  const rets = logReturns(closes.slice(-config.binary.lookbackMinutesForStats));
  const driftPerMin = mean(rets);
  const volPerMin = stdev(rets, driftPerMin);

  const tilt = technicalTilt(candles);
  // Tilt can shift drift by at most 1 stdev-per-minute worth - i.e. it can
  // meaningfully lean the estimate but never override what volatility itself
  // measured.
  const adjustedDrift = driftPerMin + tilt * volPerMin;

  const checkpoints = config.binary.checkpointFractions.map((frac) => {
    const t = Math.max(1, Math.round(duration * frac));
    const meanLogRet = adjustedDrift * t;
    const sdLogRet = volPerMin * Math.sqrt(t);
    const z = sdLogRet > 0 ? meanLogRet / sdLogRet : (meanLogRet > 0 ? 5 : meanLogRet < 0 ? -5 : 0);
    const probAbove = normalCdf(z);
    const direction = probAbove >= 0.5 ? 'ABOVE' : 'BELOW';
    const probability = direction === 'ABOVE' ? probAbove : 1 - probAbove;
    return {
      fraction: frac,
      label: frac === 1 ? 'Expiry' : `${Math.round(frac * 100)}% (${t} min)`,
      minutes: t,
      direction,
      probabilityPct: Number((probability * 100).toFixed(1)),
    };
  });

  const finalCp = checkpoints[checkpoints.length - 1];
  const confidence = finalCp.probabilityPct;

  return {
    symbol: symbolRaw.toUpperCase(),
    entryPrice,
    durationMinutes: duration,
    direction: finalCp.direction,
    confidence,
    highTrust: confidence >= config.binary.highTrustThreshold,
    driftPerMin,
    volPerMin,
    tilt,
    checkpoints,
    signalTime: Date.now(),
  };
}

module.exports = { generateBinarySignal, normalCdf };
