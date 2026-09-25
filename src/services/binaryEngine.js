// ---- HONESTY NOTE (read before wiring this to real money) ----
// Quotex's own OTC price feed is not publicly available anywhere - OTC pairs
// (used on weekends and on many "() OTC" symbols) are a broker-generated
// price, not a real market feed, so no external API (including Twelve Data)
// can match it. This engine uses Twelve Data's REAL forex/crypto feed as the
// closest available proxy, which is only meaningfully close to what Quotex
// shows for *non-OTC* pairs during real market hours. Treat every output as
// an estimate on the real underlying asset, not a guarantee of what Quotex's
// OTC price will do. Fixed 1-5 minute expiries are close to a random walk -
// no legitimate method reaches genuine, reliable 90%+ edge on those.
//
// ---- WHAT CHANGED IN THIS REDESIGN (read this before touching the math) ----
// The old version computed one "confidence" number per signal and treated
// it as gospel. This version separates several things that used to be
// smushed together:
//
// 1. RAW PROBABILITY vs CALIBRATED PROBABILITY. The raw number
//    (rawProbability) is still the normal-CDF output of the drift/vol
//    random-walk model below - it is NOT a claim about historical accuracy,
//    it's just "what the math says". calibratedProbability
//    (src/services/calibration.js) is a separate number, pulled from what
//    THIS bucket of raw probability has actually resolved to in real closed
//    trades for THIS expiry length. The two are shown separately everywhere
//    - never presented as if they're the same thing.
//
// 2. EXPIRY-DEPENDENT MODELING. A 1-minute trade and a 60-minute trade are
//    no longer just the same drift extrapolated further:
//    - the confluence read blends in a higher-timeframe (5m/15m resampled)
//      confluence for expiries >=10 minutes, weighted more heavily the
//      longer the expiry (computeMultiTimeframeConfluence) - short expiries
//      stay native-timeframe only
//    - calibration is looked up per expiry bucket (expiryBuckets.js), so a
//      70% raw reading on a 1-minute trade and a 70% raw reading on a
//      60-minute trade are calibrated against their OWN separate track
//      records, never pooled
//    - drift decay (unchanged from before) already stops confidence from
//      mechanically climbing just because duration grew
//
// 3. MARKET REGIME (src/services/regime.js) - trending / ranging /
//    breakout / reversal / unstable, crossed with a volatility axis. Used
//    as a genuine gate: UNSTABLE readings push toward NO TRADE regardless
//    of what the probability math says, because the inputs feeding that
//    math (drift/vol/candles) are themselves untrustworthy in that state.
//
// 4. THREE-STATE OUTPUT: UP / DOWN / NO_TRADE. A weak edge, an unstable
//    regime, too few usable indicators, or a duration far beyond what the
//    recent data window can speak to all resolve to NO_TRADE rather than a
//    forced direction. See decideFinalSignal() below for the exact gates.
//
// 5. GROUPED CONFLUENCE, NOT VOTE-COUNTING. EMA stack + MACD are both
//    trend-following and highly correlated - they're now averaged into one
//    TREND group instead of counted as two independent "votes". Same for
//    RSI + Stochastic (MOMENTUM group). Market structure + S/R proximity +
//    breakout/retest are grouped as PRICE_ACTION. Bollinger %B stands alone
//    as MEAN_REVERSION. The four GROUPS are combined with fixed weights,
//    not the raw factor count - so five correlated trend indicators
//    agreeing no longer outweighs one genuine price-structure read just
//    because there are more of them.
//
// ---- HOW THE PROBABILITY IS ACTUALLY COMPUTED (no hardcoded odds) ----
// 1. Pull recent 1-minute closes and compute the log-return mean (drift) and
//    standard deviation (volatility) *per minute*, measured fresh every call
//    from real recent price action (config.binary.lookbackMinutesForStats).
// 2. Nudge that drift using the grouped confluence tilt above, bounded to a
//    fraction of the *measured* volatility so it can't manufacture a signal
//    out of nothing.
// 3. Model the log-price at any future time t as approximately Normal with
//    mean = drift*t and stdev = volatility*sqrt(t) (standard random-walk
//    diffusion assumption). The probability that price finishes above entry
//    is the Normal CDF of that distribution evaluated at 0.
// This is why longer horizons naturally get less extreme probabilities
// (uncertainty grows with sqrt(t)).

const config = require('../config');
const indicators = require('./indicators');
const twelvedata = require('./twelvedata');
const logger = require('../utils/logger');
const structureSvc = require('./structure');
const regimeSvc = require('./regime');
const calibrationSvc = require('./calibration');
const expiryBucketsSvc = require('./expiryBuckets');
const volumeSvc = require('./volume');
const candleQualitySvc = require('./candleQuality');
const divergenceSvc = require('./divergence');
const sessionsSvc = require('./sessions');
const dataQualitySvc = require('./dataQuality');

function normalCdf(x) {
  // Verified against known values: normalCdf(0) = 0.5, normalCdf(2) ≈ 0.977,
  // normalCdf(-2) ≈ 0.023.
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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// How far price can be from a support/resistance level to still count as
// "near" it, as a % of price.
const SR_PROXIMITY_PCT = 0.15;

function srProximityScore(entryPrice, nearest) {
  let score = 0;
  if (nearest.resistance) {
    const distPct = ((nearest.resistance.price - entryPrice) / entryPrice) * 100;
    if (distPct >= 0 && distPct < SR_PROXIMITY_PCT) {
      const strength = Math.min(1, nearest.resistance.touches / 3);
      score -= 0.5 + 0.5 * strength * (1 - distPct / SR_PROXIMITY_PCT);
    }
  }
  if (nearest.support) {
    const distPct = ((entryPrice - nearest.support.price) / entryPrice) * 100;
    if (distPct >= 0 && distPct < SR_PROXIMITY_PCT) {
      const strength = Math.min(1, nearest.support.touches / 3);
      score += 0.5 + 0.5 * strength * (1 - distPct / SR_PROXIMITY_PCT);
    }
  }
  return Math.max(-1, Math.min(1, score));
}

// ---- Grouped confluence ----
// Each factor still gets its own [-1,1] score (for the transparency
// breakdown shown to the user), but factors are combined WITHIN their
// group first (correlated factors averaged, not stacked), and only then
// are the (uncorrelated-ish) GROUP scores combined with fixed weights.
// This is what stops "5 trend indicators all agree" from silently
// outweighing "1 genuine price-structure read".
//
// VOLUME / DIVERGENCE / CANDLE_QUALITY are intentionally the three
// smallest weights - per the requirement, none of them is allowed to
// become a standalone signal. They're real inputs (their group score is
// computed for real, from real data, and IS part of the tilt), just
// deliberately modest ones. All group weights are auto-renormalized by
// how much weight was actually usable (see `weightUsed` below), so a
// forex pair with no volume data simply redistributes VOLUME's weight
// across the groups that DID have data - it never silently zeroes out
// part of the read.
const GROUP_WEIGHTS = {
  TREND: 0.30,
  MOMENTUM: 0.17,
  MEAN_REVERSION: 0.12,
  PRICE_ACTION: 0.24,
  VOLUME: 0.08,
  DIVERGENCE: 0.06,
  CANDLE_QUALITY: 0.03,
};

// `extras` (all optional): { volumeState, divergences, candleQuality } -
// each already-computed by their own dedicated service (volume.js,
// divergence.js, candleQuality.js) so this function stays a pure combiner,
// not a place where new detection logic gets invented.
function buildConfluence(candles, structureInfo, srScore, breakoutScore, extras = {}) {
  const ema9 = indicators.ema(candles, 9);
  const ema21 = indicators.ema(candles, 21);
  const ema50 = indicators.ema(candles, 50);
  const macdVal = indicators.macd(candles);
  const rsi7 = indicators.rsi(candles, 7);
  const stoch = indicators.stochastic(candles, 14, 3);
  const bb = indicators.bollingerBands(candles, 20, 2);
  const adxVal = indicators.adx(candles, 14);

  // 0 at ADX<=15 (no real trend - chop), 1 at ADX>=30 (strong trend).
  const adxStrength = adxVal && Number.isFinite(adxVal.adx)
    ? Math.max(0, Math.min(1, (adxVal.adx - 15) / 15))
    : 0.5;

  const factors = []; // flat list, for the transparency breakdown only
  const groups = { TREND: [], MOMENTUM: [], MEAN_REVERSION: [], PRICE_ACTION: [], VOLUME: [], DIVERGENCE: [], CANDLE_QUALITY: [] };

  function record(group, factor, score) {
    if (score == null || !Number.isFinite(score)) return;
    factors.push({ factor, group, score: Number(score.toFixed(2)) });
    groups[group].push(score);
  }

  if (ema9 != null && ema21 != null && ema50 != null) {
    let emaScore = 0;
    if (ema9 > ema21 && ema21 > ema50) emaScore = 1;
    else if (ema9 < ema21 && ema21 < ema50) emaScore = -1;
    else if (ema9 > ema21) emaScore = 0.5;
    else if (ema9 < ema21) emaScore = -0.5;
    record('TREND', 'EMA trend stack', emaScore * adxStrength);
  }
  if (macdVal && Number.isFinite(macdVal.histogram)) {
    const macdScore = macdVal.histogram > 0 ? 1 : macdVal.histogram < 0 ? -1 : 0;
    record('TREND', 'MACD', macdScore * adxStrength);
  }

  if (rsi7 != null) {
    record('MOMENTUM', 'RSI(7)', Math.max(-1, Math.min(1, (rsi7 - 50) / 25)));
  }
  if (stoch && Number.isFinite(stoch.k) && Number.isFinite(stoch.d)) {
    let stochScore = Math.max(-1, Math.min(1, (stoch.k - 50) / 40));
    if (stoch.k < 20 && stoch.k > stoch.d) stochScore = Math.max(stochScore, 0.6);
    if (stoch.k > 80 && stoch.k < stoch.d) stochScore = Math.min(stochScore, -0.6);
    record('MOMENTUM', 'Stochastic', stochScore);
  }

  if (bb && Number.isFinite(bb.upper) && Number.isFinite(bb.lower) && bb.upper > bb.lower) {
    const lastClose = candles[candles.length - 1].close;
    const percentB = (lastClose - bb.lower) / (bb.upper - bb.lower);
    let bbScore = 0;
    if (percentB > 1) bbScore = -Math.min(1, (percentB - 1) * 2 + 0.5);
    else if (percentB < 0) bbScore = Math.min(1, -percentB * 2 + 0.5);
    else bbScore = (0.5 - percentB) * 0.6;
    record('MEAN_REVERSION', 'Bollinger %B', bbScore);
  }

  record('PRICE_ACTION', 'Market structure', structureInfo.score);
  record('PRICE_ACTION', 'Support/Resistance', srScore);
  record('PRICE_ACTION', 'Breakout/Retest', breakoutScore);

  // Volume, divergence, candle-quality: each ONLY contributes when its own
  // service determined it had real data to work with (`available`/a
  // non-empty divergence list) - never faked, never defaulted to neutral
  // just to fill the group (an empty group is simply left out of `groups`,
  // which the weightUsed normalization below already handles correctly).
  if (extras.volumeState && extras.volumeState.available) {
    record('VOLUME', 'Price-Volume relationship', extras.volumeState.confluenceScore);
  }
  if (extras.divergences && extras.divergences.length) {
    record('DIVERGENCE', `Divergence (${extras.divergences.length} found)`, divergenceSvc.divergenceConfluenceScore(extras.divergences));
  }
  if (extras.candleQuality && extras.candleQuality.available) {
    record('CANDLE_QUALITY', `Candle pattern (${extras.candleQuality.tags.join(', ') || 'neutral'})`, extras.candleQuality.confluenceScore);
  }

  let tilt = 0;
  let weightUsed = 0;
  const groupScores = {};
  for (const [group, scores] of Object.entries(groups)) {
    if (!scores.length) continue;
    const groupScore = clamp(mean(scores), -1, 1);
    groupScores[group] = Number(groupScore.toFixed(2));
    tilt += groupScore * GROUP_WEIGHTS[group];
    weightUsed += GROUP_WEIGHTS[group];
  }

  return {
    tilt: weightUsed > 0 ? clamp(tilt / weightUsed, -1, 1) : 0,
    factorCount: factors.length,
    groupScores,
    breakdown: factors.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
  };
}

// Compares the requested timeframe's own signal quality against 5-min and
// 15-min resampled versions of the SAME candles (no extra API calls).
function resampleCandles(candles, factor) {
  const out = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return out;
}

function confluenceQuality(candles) {
  if (candles.length < 30) return 0;
  const adxVal = indicators.adx(candles, 14);
  const adxStrength = adxVal && Number.isFinite(adxVal.adx) ? Math.max(0, Math.min(1, (adxVal.adx - 15) / 15)) : 0;
  const structureInfo = structureSvc.classifyStructure(candles);
  return (adxStrength + Math.abs(structureInfo.score)) / 2;
}

function suggestBetterTimeframe(candles) {
  const nativeQuality = confluenceQuality(candles);
  const candidates = [
    { label: '5-15 minute', factor: 5, minCandles: 60 },
    { label: '15-60 minute', factor: 15, minCandles: 60 },
  ];
  let best = null;
  for (const c of candidates) {
    const resampled = resampleCandles(candles, c.factor);
    if (resampled.length < c.minCandles) continue;
    const quality = confluenceQuality(resampled);
    if (quality > nativeQuality + 0.15 && (!best || quality > best.quality)) {
      best = { label: c.label, quality: Number(quality.toFixed(2)), nativeQuality: Number(nativeQuality.toFixed(2)) };
    }
  }
  return best;
}

// How many raw 1-minute candles are needed so the higher-timeframe resample
// below actually has enough bars to compute a meaningful confluence read
// (EMA50/MACD(26,9) need dozens of resampled bars, not just the technical
// minimum of 1). Exported so the live fetch size and the backtester agree
// on exactly the same requirement - otherwise the backtest could validate
// a code path the live bot never actually reaches for lack of data.
function mtfFactorFor(duration) {
  if (duration >= 30) return 15;
  if (duration >= 10) return 5;
  return null;
}

function mtfCandlesNeeded(duration) {
  const factor = mtfFactorFor(duration);
  if (!factor) return 0;
  // Aim for ~55-60 resampled bars - enough for EMA50 to actually produce a
  // value most of the time, not just MACD/RSI.
  const targetResampledBars = duration >= 30 ? 55 : 60;
  return factor * targetResampledBars;
}

// ---- Multi-timeframe blend (expiry-dependent) ----
// Short expiries (<10 min) trade purely on the native 1-minute confluence -
// there usually isn't a higher-timeframe candle formed yet that's relevant
// to a 3-minute decision. Longer expiries increasingly need a higher
// timeframe to agree, because "what the last few 1-minute candles did" is
// weak evidence about where price will be in 30-60 minutes.
//
// `fullCandles` here is deliberately allowed to be LONGER than the native
// statsLookback window (see requiredFetchSize/computeSignalCore) - the
// resample needs more raw history than the drift/vol stats do, and
// stretching statsLookback itself to cover that would quietly change what
// window drift/volatility get measured over. Keeping them separate means
// "how far back drift is measured" and "how much history the higher
// timeframe needs" are two different knobs, not one conflated one.
function computeMultiTimeframeConfluence(fullCandles, duration, nativeConfluence, srScore, breakoutScore) {
  const factor = mtfFactorFor(duration);
  if (!factor) {
    return { tilt: nativeConfluence.tilt, agreement: null, higherTF: null };
  }
  const resampled = resampleCandles(fullCandles, factor);
  const MIN_RESAMPLED = 30;
  if (resampled.length < MIN_RESAMPLED) {
    return { tilt: nativeConfluence.tilt, agreement: null, higherTF: null };
  }
  const higherStructure = structureSvc.classifyStructure(resampled);
  const higherConfluence = buildConfluence(resampled, higherStructure, srScore, breakoutScore);
  const blendWeight = duration >= 30 ? 0.5 : 0.3;
  const combinedTilt = clamp(
    nativeConfluence.tilt * (1 - blendWeight) + higherConfluence.tilt * blendWeight,
    -1,
    1
  );
  const NEAR_ZERO = 0.08;
  const agreement =
    Math.abs(nativeConfluence.tilt) < NEAR_ZERO || Math.abs(higherConfluence.tilt) < NEAR_ZERO
      ? null // one side has no real opinion - not a disagreement, just uninformative
      : Math.sign(nativeConfluence.tilt) === Math.sign(higherConfluence.tilt);
  return {
    tilt: combinedTilt,
    agreement,
    higherTF: { label: `${factor}min resampled`, tilt: Number(higherConfluence.tilt.toFixed(2)) },
  };
}

// ---- Final UP / DOWN / NO_TRADE decision ----
// Every gate here is a plain, named reason - if none fire, the raw
// direction from the probability math stands; if any fire, the signal
// becomes NO_TRADE. This is deliberately conservative: it is fine to miss
// a marginal setup, it is not fine to hand out a forced direction on a
// setup the model itself can't vouch for.
function decideFinalSignal({
  rawDirection,
  calibratedPct,
  regimeInfo,
  factorCount,
  mtfAgreement,
  duration,
  statsLookback,
  calibrationSampleSize,
  dataQuality,
  structureInfo,
  breakoutInfo,
  groupScores,
}) {
  const reasons = [];

  // ---- Data quality gate (checked first - if the inputs are corrupt,
  // nothing downstream can be trusted regardless of what it computed) ----
  if (dataQuality && !dataQuality.ok) {
    reasons.push(`data quality check failed (${dataQuality.issues.join('; ') || 'insufficient clean candles'})`);
  }
  if (structureInfo && structureInfo.pattern === 'INSUFFICIENT_DATA') {
    reasons.push('not enough swing-point history to read market structure - missing critical data for this read');
  }

  if (!regimeInfo.reliable) {
    reasons.push(`market regime flagged UNSTABLE (${regimeInfo.reasons.join('; ')})`);
  }
  if (factorCount < config.binary.minConfluenceFactors) {
    reasons.push(`only ${factorCount} usable indicator(s) - not enough for a reliable read (need ${config.binary.minConfluenceFactors}+)`);
  }
  if (
    duration > statsLookback * 3 &&
    calibrationSampleSize < calibrationSvc.MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION
  ) {
    reasons.push(
      `${formatMinutes(duration)} horizon is well beyond the ${formatMinutes(statsLookback)} data window this call measured, ` +
      'and this expiry length does not yet have enough closed trades to have earned trust at that horizon'
    );
  }
  if (mtfAgreement === false && duration >= 10) {
    reasons.push('higher-timeframe context disagrees with the native-timeframe read');
  }

  // ---- Breakout quality: a FALSE breakout (broke the level, then closed
  // back on the wrong side and never re-broke) is active evidence against
  // the move, not just "unconfirmed" - hard-gated. An unconfirmed-but-not-
  // false breakout is NOT hard-gated here (per the requirement that a
  // breakout without confirmation shouldn't automatically be treated as
  // high-confidence, but also shouldn't be treated as automatically
  // disqualifying) - instead its contribution to the confluence tilt is
  // already scaled down by its own `quality` score before it ever reaches
  // this function (see computeSignalCore/breakoutContribScore below).
  if (breakoutInfo && breakoutInfo.falseBreakout) {
    reasons.push('most recent breakout has failed (price closed back on the wrong side without re-breaking) - false breakout');
  }

  // ---- Contradictory momentum: TREND and MOMENTUM groups pointing
  // meaningfully opposite ways is a sign the setup lacks real agreement,
  // even if the blended tilt happens to clear the edge threshold.
  if (groupScores && Number.isFinite(groupScores.TREND) && Number.isFinite(groupScores.MOMENTUM)) {
    const bothMeaningful = Math.abs(groupScores.TREND) > 0.35 && Math.abs(groupScores.MOMENTUM) > 0.35;
    const opposite = Math.sign(groupScores.TREND) !== Math.sign(groupScores.MOMENTUM);
    if (bothMeaningful && opposite) {
      reasons.push(`trend (${groupScores.TREND}) and momentum (${groupScores.MOMENTUM}) indicators contradict each other`);
    }
  }

  // ---- Weak/directionless structure in a genuinely ranging market - the
  // one case where "no real price-action read" is itself informative
  // rather than just a low factor count.
  if (regimeInfo.primary === 'RANGING' && groupScores && Math.abs(groupScores.PRICE_ACTION || 0) < 0.15) {
    reasons.push('market structure is weak/directionless inside a ranging regime - no reliable price-action read');
  }

  // Edge check last, using the (possibly mtf-penalized) calibrated
  // probability - weak edge is the most common, least dramatic reason to
  // sit out, so it's listed after the more specific structural reasons.
  if (calibratedPct < 50 + config.binary.noTradeEdgeThresholdPct) {
    reasons.push(
      `calibrated edge (${calibratedPct.toFixed(1)}%) is inside the no-trade zone ` +
      `(need >=${50 + config.binary.noTradeEdgeThresholdPct}%)`
    );
  }

  return { direction: reasons.length ? 'NO_TRADE' : rawDirection, reasons };
}

// How many 1-minute candles to actually fetch/pass in: at least enough for
// the drift/vol stats window (statsLookback), AND at least enough for the
// higher-timeframe resample this duration calls for (mtfCandlesNeeded).
// The two are different concerns (see computeMultiTimeframeConfluence) so
// this is a max(), not a replacement of either.
function requiredFetchSize(duration, statsLookback) {
  return Math.max(statsLookback, mtfCandlesNeeded(duration));
}

// ---- Pure core: everything that can be computed from a candle array +
// entry price + duration alone, with NO network calls and NO Redis/
// calibration lookups. This is the exact same math the live path uses
// (generateBinarySignal below just adds the data fetch and calibration on
// top), and it's what the walk-forward backtester (src/backtest/run.js)
// calls directly against historical candles - so a backtest result is
// provably testing the same logic that runs live, not a re-implementation
// that could quietly drift out of sync with it.
//
// `allCandles` may be LONGER than statsLookback (see requiredFetchSize) -
// only the last `statsLookback` candles are used for drift/vol/native
// structure/native confluence/regime, exactly like before this multi-
// timeframe feature existed. The extra history at the front, if any, is
// used ONLY by the higher-timeframe resample inside
// computeMultiTimeframeConfluence, via the full `allCandles` array.
function computeSignalCore(allCandlesRaw, entryPrice, duration, statsLookback) {
  // ---- Data quality first: clean (dedupe/sort/drop-corrupt-bars) the
  // FULL input before anything else touches it, so every downstream piece
  // (native window, MTF resample) works off validated data. This runs
  // identically live and in the backtester (pure function of the candle
  // array), which is the point - a data-quality bug would otherwise show
  // up differently in each.
  const dq = dataQualitySvc.validateCandleSeries(allCandlesRaw);
  const allCandles = dq.cleaned;

  const candles = allCandles.length > statsLookback ? allCandles.slice(-statsLookback) : allCandles;
  const closes = candles.map((c) => c.close);
  const rets = logReturns(closes.slice(-statsLookback));
  const driftPerMin = mean(rets);
  const volPerMin = stdev(rets, driftPerMin);

  const driftStdErr = rets.length > 1 ? volPerMin / Math.sqrt(rets.length) : volPerMin;
  const driftReliability = driftStdErr > 0
    ? (driftPerMin * driftPerMin) / (driftPerMin * driftPerMin + driftStdErr * driftStdErr)
    : 1;
  const reliableDrift = driftPerMin * driftReliability;

  // ---- New research-grade inputs (each independently gated on having
  // real data - see each service's own honesty note) ----
  const volumeState = volumeSvc.computeVolumeState(candles);
  const candleQuality = candleQualitySvc.analyzeLastCandle(candles);
  const divergences = divergenceSvc.detectDivergences(candles, volumeState);
  // Session is classified from the LAST CANDLE's own timestamp, not
  // wall-clock "now" - this is what makes it work correctly inside the
  // walk-forward backtester too (a backtest point pretending to be
  // "January 3rd, 09:00 UTC" gets that session, not today's).
  const session = sessionsSvc.classifySession(candles[candles.length - 1].time);

  const structureInfo = structureSvc.classifyStructure(candles);
  const srLevelsRaw = structureSvc.findKeyLevels(candles);
  const srLevels = structureSvc.enrichLevelsWithStrength(srLevelsRaw, candles, {
    volumeState,
    rangeVolumeConfirmed: volumeSvc.rangeVolumeConfirmed,
  });
  const nearestSR = structureSvc.nearestLevels(entryPrice, srLevels);
  const srScore = srProximityScore(entryPrice, nearestSR);
  const breakoutInfo = structureSvc.analyzeBreakoutQuality(candles, srLevels, {
    volumeState,
    rangeVolumeConfirmed: volumeSvc.rangeVolumeConfirmed,
    candleQualityFn: candleQualitySvc.analyzeLastCandle,
    lookback: 15,
  });
  const regimeInfo = regimeSvc.classifyRegime(candles, structureInfo, breakoutInfo, volumeState);
  const timeframeSuggestion = suggestBetterTimeframe(candles);

  // A breakout's contribution to the confluence tilt is scaled by its own
  // `quality` (0-1, from analyzeBreakoutQuality) - an unconfirmed/no-
  // follow-through breakout still nudges the read, just much less than a
  // fully-confirmed one. This is the concrete mechanism behind "a breakout
  // without confirmation is not automatically a high-confidence setup".
  const breakoutContribScore = breakoutInfo.type !== 'NONE'
    ? breakoutInfo.score * (breakoutInfo.quality != null ? breakoutInfo.quality : 1)
    : 0;

  const nativeConfluence = buildConfluence(candles, structureInfo, srScore, breakoutContribScore, {
    volumeState,
    divergences,
    candleQuality,
  });
  const mtf = computeMultiTimeframeConfluence(allCandles, duration, nativeConfluence, srScore, breakoutContribScore);
  const tilt = mtf.tilt;
  const adjustedDrift = reliableDrift + tilt * volPerMin;

  function decayedDrift(t) {
    return adjustedDrift * (statsLookback / (statsLookback + t));
  }

  const checkpoints = config.binary.checkpointFractions.map((frac) => {
    const t = duration >= 1 ? Math.max(1, Math.round(duration * frac)) : Math.max(1 / 60, duration * frac);
    const meanLogRet = decayedDrift(t) * t;
    const sdLogRet = volPerMin * Math.sqrt(t);
    const z = sdLogRet > 0 ? meanLogRet / sdLogRet : (meanLogRet > 0 ? 5 : meanLogRet < 0 ? -5 : 0);
    const probAbove = normalCdf(z);
    const direction = probAbove >= 0.5 ? 'UP' : 'DOWN';
    const probability = direction === 'UP' ? probAbove : 1 - probAbove;
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

  // Feature flags: a compact set of booleans, recorded against actual
  // trade outcomes by binaryTracker.js via calibration.recordFeatureOutcome
  // - this is what lets #16 "which features actually help" be answered
  // from real data later (see getAllFeaturePerf), instead of assumed.
  // Only set when genuinely knowable (null when not applicable/available).
  const featureFlags = {
    volume_available: volumeState.available,
    volume_confirmed_breakout: breakoutInfo.type !== 'NONE' ? breakoutInfo.volumeConfirmed : null,
    divergence_present: divergences.length > 0,
    htf_ltf_agree: mtf.agreement,
    breakout_high_quality: breakoutInfo.type !== 'NONE' && breakoutInfo.quality != null ? breakoutInfo.quality >= 0.6 : null,
    candle_momentum_aligned: candleQuality.available
      ? Math.sign(candleQuality.confluenceScore) === Math.sign(tilt) && Math.abs(candleQuality.confluenceScore) > 0.1
      : null,
  };

  return {
    driftPerMin,
    volPerMin,
    dataQuality: dq,
    volumeState,
    candleQuality,
    divergences,
    session,
    structureInfo,
    srLevels,
    nearestSR,
    breakoutInfo,
    regimeInfo,
    timeframeSuggestion,
    nativeConfluence,
    mtf,
    tilt,
    checkpoints,
    finalCp,
    featureFlags,
    rawDirection: finalCp.direction,
    rawProbability: finalCp.probabilityPct,
  };
}

// ---- Market-data fetch, split out of generateBinarySignal ----
// This is the ONLY network step of the analysis, and it produces nothing
// but RAW inputs (candles + live quote + a couple of bookkeeping numbers) -
// no indicator, no score, no conclusion. Splitting it out lets the unified
// !market workflow (services/marketWorkflow.js) fetch once and hand the same
// raw snapshot to BOTH the deterministic bot (generateBinarySignal below)
// and the independent AI analyst, in parallel, without a second fetch and
// without either of them waiting on the other. `!binary` still just calls
// generateBinarySignal(symbol, duration) exactly as before - it fetches
// internally through this same function.
async function fetchSignalInputs(symbolRaw, durationMinutes) {
  const duration = Math.max(
    config.binary.minDurationMinutes,
    Math.min(config.binary.maxDurationMinutes, durationMinutes)
  );

  const statsLookback = Math.max(60, config.binary.lookbackMinutesForStats, Math.min(720, Math.ceil(duration * 1.5)));
  const fetchSize = requiredFetchSize(duration, statsLookback);

  const [candles, livePriceResult] = await Promise.all([
    twelvedata.getTimeSeries(symbolRaw, '1min', fetchSize),
    twelvedata.getCurrentPrice(symbolRaw).catch((err) => {
      logger.warn(`Live price fetch failed for ${symbolRaw}, will fall back to last candle close: ${err.message}`);
      return null;
    }),
  ]);
  if (candles.length < 30) {
    const err = new Error(`Not enough recent 1-minute data for ${symbolRaw} to analyze (got ${candles.length} candles)`);
    err.code = 'INSUFFICIENT_DATA';
    throw err;
  }

  const closes = candles.map((c) => c.close);
  let entryPrice = closes[closes.length - 1];
  let priceSource = 'last-candle-close';
  if (Number.isFinite(livePriceResult) && livePriceResult > 0) {
    entryPrice = livePriceResult;
    priceSource = 'live-quote';
  }

  // Wall-clock staleness check - only meaningful live (see dataQuality.js
  // header for why this is separate from the structural validation that
  // also runs, identically, inside the backtester).
  const fetchedAt = Date.now();
  const staleness = dataQualitySvc.checkStaleness(candles, fetchedAt, 60000, 5);

  return {
    symbol: symbolRaw.toUpperCase(),
    duration,
    statsLookback,
    fetchSize,
    candles,
    entryPrice,
    priceSource,
    staleness,
    fetchedAt,
  };
}

// `prefetchedInputs` (optional) is the object returned by fetchSignalInputs
// - pass it to reuse an already-fetched snapshot instead of fetching again.
async function generateBinarySignal(symbolRaw, durationMinutes, prefetchedInputs = null) {
  const inputs = prefetchedInputs || await fetchSignalInputs(symbolRaw, durationMinutes);
  const {
    duration, statsLookback, candles, entryPrice, staleness,
  } = inputs;

  const core = computeSignalCore(candles, entryPrice, duration, statsLookback);
  const {
    driftPerMin, volPerMin, dataQuality, volumeState, candleQuality, divergences, session,
    structureInfo, srLevels, nearestSR, breakoutInfo, regimeInfo,
    timeframeSuggestion, nativeConfluence, mtf, tilt, checkpoints, finalCp, featureFlags, rawDirection, rawProbability,
  } = core;

  const expiryBucket = expiryBucketsSvc.getExpiryBucket(duration);
  const calib = await calibrationSvc.calibrateProbability(rawProbability, expiryBucket.key);
  let calibratedPct = calib.calibratedPct;

  // Higher-timeframe disagreement (for expiries where that context was
  // actually computed) shaves the edge back toward 50 rather than hard
  // vetoing by itself - decideFinalSignal below is what turns a
  // sufficiently-shaved edge into NO_TRADE via the standard edge check, so
  // there's one consistent place the actual cutoff lives.
  if (mtf.agreement === false && duration >= 10) {
    calibratedPct = 50 + (calibratedPct - 50) * (1 - config.binary.mtfDisagreementPenalty);
  }

  const decision = decideFinalSignal({
    rawDirection,
    calibratedPct,
    regimeInfo,
    factorCount: nativeConfluence.factorCount,
    mtfAgreement: mtf.agreement,
    duration,
    statsLookback,
    calibrationSampleSize: calib.sampleSize,
    dataQuality,
    structureInfo,
    breakoutInfo,
    groupScores: nativeConfluence.groupScores,
  });

  // Staleness is a live-only safety net, applied AFTER the normal decision
  // so its reason is additive rather than replacing whatever the model
  // itself found - it can only push toward NO_TRADE, never away from it.
  let finalDirection = decision.direction;
  const noTradeReasons = [...decision.reasons];
  if (staleness.stale && finalDirection !== 'NO_TRADE') {
    finalDirection = 'NO_TRADE';
    noTradeReasons.push(`live data looks stale (most recent candle is ~${staleness.ageBars} bars old) - not trading on it`);
  }

  // Quality label: a simple, transparent count of "things that are going
  // right" - not itself a probability, just a quick trust signal for the UI.
  let qualityScore = 0;
  if (regimeInfo.reliable) qualityScore += 1;
  if (!calib.lowConfidence) qualityScore += 1;
  if (mtf.agreement !== false) qualityScore += 1;
  if (nativeConfluence.factorCount >= 5) qualityScore += 1;
  const qualityLabel = finalDirection === 'NO_TRADE'
    ? 'NO_TRADE'
    : qualityScore >= 3 ? 'HIGH' : qualityScore >= 2 ? 'MEDIUM' : 'LOW';

  // ---- ENTRY PRICE -> EXACT EXPIRY TIMESTAMP -> EXPECTED EXPIRY PRICE ----
  // The whole point of a binary/time-based signal: what does the model
  // expect price to BE at the exact moment this trade expires, not what it
  // does in between. finalCp (fraction 1.0 of `checkpoints`, computed in
  // computeSignalCore above) already IS the expiry-moment projection - these
  // are just its values surfaced as explicit, clearly-named top-level
  // fields rather than requiring every caller to dig into checkpoints[].
  const signalTime = Date.now();
  const expiresAtMs = signalTime + Math.round(duration * 60000);
  const expectedExpiryPrice = finalCp.predictedPrice;
  const expectedMoveAmount = Number.isFinite(expectedExpiryPrice) ? Number((expectedExpiryPrice - entryPrice).toPrecision(8)) : null;
  const expectedMovePct = Number.isFinite(expectedExpiryPrice) && entryPrice > 0
    ? Number((((expectedExpiryPrice - entryPrice) / entryPrice) * 100).toFixed(4))
    : null;

  return {
    symbol: symbolRaw.toUpperCase(),
    entryPrice,
    durationMinutes: duration,
    expiryBucket,
    direction: finalDirection, // 'UP' | 'DOWN' | 'NO_TRADE'
    rawDirection, // what the math said before any gate, always UP/DOWN
    noTradeReasons,
    rawProbability,
    calibratedProbability: Number(calibratedPct.toFixed(1)),
    calibrationSampleSize: calib.sampleSize,
    calibrationLowConfidence: calib.lowConfidence,
    calibrationRecentWinRatePct: calib.recentWinRatePct,
    calibrationRecentSampleSize: calib.recentSampleSize,
    qualityLabel,
    highTrust: finalDirection !== 'NO_TRADE' && calibratedPct >= config.binary.highTrustThreshold && qualityLabel === 'HIGH',
    driftPerMin,
    volPerMin,
    tilt,
    confluenceBreakdown: nativeConfluence.breakdown,
    confluenceGroupScores: nativeConfluence.groupScores,
    confluenceGroupWeights: GROUP_WEIGHTS,
    multiTimeframe: mtf.higherTF ? { ...mtf.higherTF, agreement: mtf.agreement } : null,
    structure: { pattern: structureInfo.pattern },
    supportResistance: {
      support: nearestSR.support ? { price: nearestSR.support.price, touches: nearestSR.support.touches, strength: nearestSR.support.strength ?? null } : null,
      resistance: nearestSR.resistance ? { price: nearestSR.resistance.price, touches: nearestSR.resistance.touches, strength: nearestSR.resistance.strength ?? null } : null,
    },
    breakout: breakoutInfo.type !== 'NONE' ? {
      type: breakoutInfo.type,
      retested: breakoutInfo.retested,
      quality: breakoutInfo.quality,
      volumeConfirmed: breakoutInfo.volumeConfirmed,
      falseBreakout: breakoutInfo.falseBreakout,
      followThroughCandles: breakoutInfo.followThroughCandles,
      distanceBeyondPct: breakoutInfo.distanceBeyondPct,
    } : null,
    volume: volumeState,
    candleQuality,
    divergences,
    session,
    regime: regimeInfo,
    // Kept for backward-compatible display (formatting.js reads
    // signal.volatilityRegime.regime / .percentile) - sourced from the
    // same regime classification above rather than computed twice.
    volatilityRegime: { regime: regimeInfo.volatility, percentile: regimeInfo.volatilityPercentile },
    dataQualityIssues: dataQuality.issues,
    featureFlags,
    timeframeSuggestion,
    checkpoints,
    finalCheckpoint: finalCp,
    signalTime,
    expiresAtMs,
    expiresAtIso: new Date(expiresAtMs).toISOString(),
    expectedExpiryPrice,
    expectedMoveAmount,
    expectedMovePct,
    expectedRangeLow: finalCp.rangeLow,
    expectedRangeHigh: finalCp.rangeHigh,
  };
}

module.exports = {
  generateBinarySignal,
  fetchSignalInputs,
  computeSignalCore,
  requiredFetchSize,
  buildConfluence,
  decideFinalSignal,
  normalCdf,
  formatMinutes,
  logReturns,
  mean,
  stdev,
  GROUP_WEIGHTS,
};
