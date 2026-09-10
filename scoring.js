// DIRECTION RULE: BUY/SELL/NO-TRADE must always come from *live* market data
// only. Historical performance is never allowed to decide or flip direction -
// it is only allowed to calibrate the confidence number afterward, per the
// bot's design goal (stable real-world performance, not backtest chasing).
//
// PASS 1 (live-only): every category score is combined using ONLY the
// regime weights, which are themselves derived from the current, live candle
// data (see regime.js) - not from history. This produces the raw direction
// and a raw "live confidence".
//
// PASS 2 (historical calibration): a bounded multiplier derived from each
// category's own historical hit-rate (stored in Redis, only trusted once it
// has >= minSamples closed trades) scales the live confidence up or down.
// It can suppress a weak signal down to below the confidence threshold
// (which is a legitimate "confidence calibration" outcome - a valid
// NO TRADE), but it can never change which side (BUY vs SELL) the live data
// pointed to.

function combineScores(categoryScores, regimeWeights, adaptiveWeights, minSamples) {
  let weightedSum = 0;
  let weightTotal = 0;
  let alignedBullish = 0;
  let alignedBearish = 0;
  const breakdown = {};

  for (const [category, data] of Object.entries(categoryScores)) {
    if (data.score === null || data.score === undefined) continue;

    const regimeW = regimeWeights[category] ?? 1.0;
    weightedSum += data.score * regimeW;
    weightTotal += regimeW;

    const adaptive = adaptiveWeights[category];
    const adaptiveTrusted = !!(adaptive && adaptive.samples >= minSamples);

    breakdown[category] = {
      score: Number(data.score.toFixed(3)),
      regimeWeight: Number(regimeW.toFixed(2)),
      historicalWinRate: adaptive ? Number((adaptive.winRate * 100).toFixed(1)) : null,
      historicalSamples: adaptive ? adaptive.samples : 0,
      adaptiveMultiplier: adaptiveTrusted ? Number(adaptive.multiplier.toFixed(2)) : null,
    };

    if (data.score > 0.15) alignedBullish += 1;
    else if (data.score < -0.15) alignedBearish += 1;
  }

  const normalizedScore = weightTotal > 0 ? weightedSum / weightTotal : 0; // -1..1, LIVE ONLY
  const alignedCategories = Math.max(alignedBullish, alignedBearish);
  const direction = normalizedScore > 0 ? 'BUY' : normalizedScore < 0 ? 'SELL' : 'NEUTRAL';
  const totalCategories = Object.keys(categoryScores).length;

  // Live confidence: magnitude of the live score + how many independent
  // live categories agree. Nothing historical in this number yet.
  const magnitudeComponent = Math.min(Math.abs(normalizedScore), 1) * 70;
  const agreementComponent = (alignedCategories / totalCategories) * 30;
  const liveConfidence = Math.round(magnitudeComponent + agreementComponent);

  // Historical calibration factor: average adaptive multiplier of only the
  // categories that agree with the *live* direction and have enough sample
  // history. Bounded to [0.6, 1.4] per-category, so the blended factor is
  // bounded too - it can meaningfully dampen or reinforce confidence but
  // can't manufacture a signal out of nothing or erase a strong live signal.
  const calibrationInputs = [];
  if (direction === 'BUY' || direction === 'SELL') {
    const sign = direction === 'BUY' ? 1 : -1;
    for (const [category, data] of Object.entries(categoryScores)) {
      if (Math.sign(data.score) !== sign) continue;
      const adaptive = adaptiveWeights[category];
      if (adaptive && adaptive.samples >= minSamples) calibrationInputs.push(adaptive.multiplier);
    }
  }
  const calibrationFactor = calibrationInputs.length
    ? calibrationInputs.reduce((a, b) => a + b, 0) / calibrationInputs.length
    : 1.0;

  const confidence = Math.round(Math.min(100, Math.max(0, liveConfidence * calibrationFactor)));

  return {
    normalizedScore: Number(normalizedScore.toFixed(3)),
    direction,
    liveConfidence,
    calibrationFactor: Number(calibrationFactor.toFixed(3)),
    confidence,
    alignedBullish,
    alignedBearish,
    alignedCategories,
    totalCategories,
    breakdown,
  };
}

module.exports = { combineScores };
