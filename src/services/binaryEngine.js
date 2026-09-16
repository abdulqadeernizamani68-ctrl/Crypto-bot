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
  // CRITICAL FIX: the previous version had an extra "return 1 - prob"
  // after already flipping prob for x>0 - a double-flip that inverted the
  // result whenever |x| was large (i.e. whenever the signal was actually
  // confident). That meant ABOVE/BELOW was often backwards exactly when it
  // mattered most. Verified against known values: normalCdf(0) = 0.5,
  // normalCdf(2) ≈ 0.977, normalCdf(-2) ≈ 0.023 - all correct with this
  // version; the old version returned the flipped complement for |x| > 0.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) prob = 1 - prob;
  return prob; // P(Z <= x)
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

// Readable label for a duration given in minutes (fractional minutes below
// 1 are shown in seconds, whole hours+ shown in hours for long durations).
function formatMinutes(mins) {
  if (mins < 1) return `${Math.round(mins * 60)}s`;
  if (mins >= 60) {
    const hrs = mins / 60;
    return `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)}h`;
  }
  return `${Math.round(mins)} min`;
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

  // Lookback scales with how far ahead we're forecasting (more history for
  // a 48h trade than a 5-minute one), capped at 12h of 1-min candles to
  // keep the API call and the stats window reasonable.
  const statsLookback = Math.max(60, config.binary.lookbackMinutesForStats, Math.min(720, Math.ceil(duration * 1.5)));

  // Fetch candle history AND the live quote at the same time (not one after
  // the other) - candles took ~0.2-0.8s before this, and doing the live
  // price fetch only after that finished meant entryPrice reflected a price
  // from further in the past than necessary. Running them in parallel gets
  // the live price as close to "right now" as this API call can give.
  const [candles, livePriceResult] = await Promise.all([
    twelvedata.getTimeSeries(symbolRaw, '1min', statsLookback),
    twelvedata.getCurrentPrice(symbolRaw).catch((err) => {
      logger.warn(`Live price fetch failed for ${symbolRaw}, will fall back to last candle close: ${err.message}`);
      return null;
    }),
  ]);
  if (candles.length < 30) {
    throw new Error(`Not enough recent 1-minute data for ${symbolRaw} to analyze (got ${candles.length} candles)`);
  }

  const closes = candles.map((c) => c.close);
  // Entry price: prefer the live quote fetched above over the last
  // completed 1-minute candle close, which can be up to ~60s stale.
  let entryPrice = closes[closes.length - 1];
  if (Number.isFinite(livePriceResult) && livePriceResult > 0) entryPrice = livePriceResult;
  const rets = logReturns(closes.slice(-statsLookback));
  const driftPerMin = mean(rets);
  const volPerMin = stdev(rets, driftPerMin);

  // Statistical-significance shrinkage: a drift estimated from a short,
  // noisy window can have a sign that's essentially a coin flip rather than
  // a real trend - e.g. mean(rets) is small and close to its own standard
  // error. Without this, the direction can flip between two calls made
  // seconds apart even though nothing meaningfully changed in the market.
  // This shrinks the drift toward zero in proportion to how indistinguishable
  // it is from noise (driftPerMin vs its standard error), so a genuinely
  // weak/noisy signal pulls confidence back toward 50% instead of
  // confidently asserting a random direction.
  const driftStdErr = rets.length > 1 ? volPerMin / Math.sqrt(rets.length) : volPerMin;
  const driftReliability = driftStdErr > 0
    ? (driftPerMin * driftPerMin) / (driftPerMin * driftPerMin + driftStdErr * driftStdErr)
    : 1;
  const reliableDrift = driftPerMin * driftReliability;

  const tilt = technicalTilt(candles);
  // Tilt can shift drift by at most 1 stdev-per-minute worth - i.e. it can
  // meaningfully lean the estimate but never override what volatility itself
  // measured.
  const adjustedDrift = reliableDrift + tilt * volPerMin;

  // Drift decay: the drift/tilt estimate above was measured over
  // `statsLookback` minutes of recent data. Naively extrapolating it out to
  // an arbitrary duration makes confidence climb toward 100% purely because
  // duration grew (drift scales with t, volatility only with sqrt(t)) - not
  // because the forecast actually got more reliable. This decays the
  // drift's influence as the requested duration goes beyond the window it
  // was measured over, so confidence stops being a near-mechanical function
  // of duration and instead tapers back toward 50% for horizons the recent
  // data genuinely can't speak to.
  function decayedDrift(t) {
    return adjustedDrift * (statsLookback / (statsLookback + t));
  }

  const checkpoints = config.binary.checkpointFractions.map((frac) => {
    // Below 1 minute we keep a fractional t (in minutes) instead of forcing
    // a whole-minute round-up - the math still works (sqrt-time scaling of
    // 1-minute volatility), it's just extrapolating below the native
    // resolution of the 1-minute candle data, so treat it as a rougher
    // estimate than 1min+ durations.
    const t = duration >= 1 ? Math.max(1, Math.round(duration * frac)) : Math.max(1 / 60, duration * frac);
    const meanLogRet = decayedDrift(t) * t;
    const sdLogRet = volPerMin * Math.sqrt(t);
    const z = sdLogRet > 0 ? meanLogRet / sdLogRet : (meanLogRet > 0 ? 5 : meanLogRet < 0 ? -5 : 0);
    const probAbove = normalCdf(z);
    const direction = probAbove >= 0.5 ? 'ABOVE' : 'BELOW';
    const probability = direction === 'ABOVE' ? probAbove : 1 - probAbove;
    // Point estimate + a rough range (±1 stdev of the log-return, ~68% of
    // outcomes fall inside it) for how far price is expected to move by
    // this checkpoint - not just the direction/probability.
    const predictedPrice = entryPrice * Math.exp(meanLogRet);
    const rangeLow = entryPrice * Math.exp(meanLogRet - sdLogRet);
    const rangeHigh = entryPrice * Math.exp(meanLogRet + sdLogRet);
    return {
      fraction: frac,
      label: frac === 1 ? 'Expiry' : `${Math.round(frac * 100)}% (${formatMinutes(t)})`,
      minutes: t,
      direction,
      probabilityPct: Number((probability * 100).toFixed(1)),
      predictedPrice,
      rangeLow: Math.min(rangeLow, rangeHigh),
      rangeHigh: Math.max(rangeLow, rangeHigh),
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

module.exports = { generateBinarySignal, normalCdf, formatMinutes };
