// Win probability is NOT a separate guess - it reuses the same `confidence`
// number the scoring engine already produced (live signal strength blended
// with this pair/category's own historical hit-rate). That confidence IS an
// estimated win probability by construction (see scoring.js). We only clamp
// it away from the extremes so a single-signal EV calc never divides by ~0.
function estimateWinProbability(confidencePct) {
  return Math.min(0.95, Math.max(0.05, confidencePct / 100));
}

// EV expressed in R (risk units): a win pays `riskReward` R, a loss costs 1R.
function computeExpectedValue(confidencePct, riskReward) {
  const winProbability = estimateWinProbability(confidencePct);
  const lossProbability = 1 - winProbability;
  const ev = winProbability * riskReward - lossProbability * 1;
  return {
    winProbability: Number((winProbability * 100).toFixed(1)),
    lossProbability: Number((lossProbability * 100).toFixed(1)),
    riskReward,
    expectedValueR: Number(ev.toFixed(3)),
    positive: ev > 0,
  };
}

module.exports = { estimateWinProbability, computeExpectedValue };
