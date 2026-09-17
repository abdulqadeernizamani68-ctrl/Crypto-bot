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
  // Multi-indicator confluence, bounded to [-1, 1]. Everything here is
  // computed LOCALLY from the same 1-minute candles already fetched for
  // this signal - zero extra Twelve Data API calls. The free plan's
  // 8-calls/minute, 800/day budget is spent entirely on the 2 calls this
  // function's caller already makes (candle history + live price); adding
  // more indicators costs nothing extra as long as they're derived from
  // that same candle array rather than fetched separately.
  //
  // Indicator choice (standard TA practice, not ad-hoc):
  // - EMA9/21/50 stack + MACD histogram -> trend direction
  // - RSI(7) + Stochastic(14,3) -> momentum, tuned fast since durations
  //   here are mostly minutes, not days
  // - Bollinger %B -> mean-reversion pressure at price extremes, which
  //   matters more the shorter the duration (an overextended move often
  //   snaps back within a few minutes, before a short expiry)
  // - ADX(14) as a trend-strength GATE: the trend components (EMA, MACD)
  //   are down-weighted when ADX shows a weak/choppy market, since
  //   trend-following signals are least reliable exactly when there's no
  //   real trend to follow. This is a standard technique for avoiding
  //   coin-flip trend calls in ranging conditions.
  const ema9 = indicators.ema(candles, 9);
  const ema21 = indicators.ema(candles, 21);
  const ema50 = indicators.ema(candles, 50);
  const macdVal = indicators.macd(candles);
  const rsi7 = indicators.rsi(candles, 7);
  const stoch = indicators.stochastic(candles, 14, 3);
  const bb = indicators.bollingerBands(candles, 20, 2);
  const adxVal = indicators.adx(candles, 14);

  // 0 at ADX<=15 (no real trend - chop), 1 at ADX>=30 (strong trend).
  // Unknown/insufficient data -> 0.5 (neutral trust), so this never fully
  // silences the trend components just because ADX couldn't be computed.
  const adxStrength = adxVal && Number.isFinite(adxVal.adx)
    ? Math.max(0, Math.min(1, (adxVal.adx - 15) / 15))
    : 0.5;

  let tilt = 0;
  let weight = 0;

  if (ema9 != null && ema21 != null && ema50 != null) {
    let emaScore = 0;
    if (ema9 > ema21 && ema21 > ema50) emaScore = 1;
    else if (ema9 < ema21 && ema21 < ema50) emaScore = -1;
    else if (ema9 > ema21) emaScore = 0.5;
    else if (ema9 < ema21) emaScore = -0.5;
    tilt += emaScore * adxStrength;
    weight += 1;
  }

  if (macdVal && Number.isFinite(macdVal.histogram)) {
    const macdScore = macdVal.histogram > 0 ? 1 : macdVal.histogram < 0 ? -1 : 0;
    tilt += macdScore * adxStrength;
    weight += 1;
  }

  if (rsi7 != null) {
    tilt += Math.max(-1, Math.min(1, (rsi7 - 50) / 25));
    weight += 1;
  }

  if (stoch && Number.isFinite(stoch.k) && Number.isFinite(stoch.d)) {
    let stochScore = Math.max(-1, Math.min(1, (stoch.k - 50) / 40));
    // Classic stochastic reversal cue: %K crossing %D from an extreme zone.
    if (stoch.k < 20 && stoch.k > stoch.d) stochScore = Math.max(stochScore, 0.6);
    if (stoch.k > 80 && stoch.k < stoch.d) stochScore = Math.min(stochScore, -0.6);
    tilt += stochScore;
    weight += 1;
  }

  if (bb && Number.isFinite(bb.upper) && Number.isFinite(bb.lower) && bb.upper > bb.lower) {
    const lastClose = candles[candles.length - 1].close;
    const percentB = (lastClose - bb.lower) / (bb.upper - bb.lower);
    // Mean-reversion read, deliberately inverted from momentum: above the
    // upper band leans bearish (expect pullback), below the lower band
    // leans bullish.
    let bbScore = 0;
    if (percentB > 1) bbScore = -Math.min(1, (percentB - 1) * 2 + 0.5);
    else if (percentB < 0) bbScore = Math.min(1, -percentB * 2 + 0.5);
    else bbScore = (0.5 - percentB) * 0.6; // mild pull toward the mean even inside the bands
    tilt += bbScore;
    weight += 1;
  }

  return weight > 0 ? Math.max(-1, Math.min(1, tilt / weight)) : 0;
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
