// Pure functions - no I/O here on purpose (testable, and commands/accuracy.js
// already fetches everything from Redis before calling in).
//
// NOTE (bug fix): this file used to be an accidental duplicate of
// commands/accuracy.js. That meant `accuracySvc.computeStats` and
// `accuracySvc.buildInsights` didn't exist, so every `!accuracy` call was
// throwing at runtime. This is the real implementation.

function computeRMultiple(s) {
  if (s.entry == null || s.stopLoss == null || s.closePrice == null) return 0;
  const risk = Math.abs(s.entry - s.stopLoss);
  if (risk === 0) return 0;
  const reward = s.direction === 'BUY' ? s.closePrice - s.entry : s.entry - s.closePrice;
  return reward / risk;
}

function computeStats(allSignals) {
  const closed = (allSignals || [])
    .filter((s) => s.status === 'CLOSED' && s.result)
    .sort((a, b) => a.signalTime - b.signalTime);

  const totalSignals = closed.length;
  const wins = closed.filter((s) => s.result === 'WIN').length;
  const losses = closed.filter((s) => s.result === 'LOSS').length;
  const winRate = totalSignals ? Number(((wins / totalSignals) * 100).toFixed(1)) : 0;

  const rMultiples = closed.map(computeRMultiple);
  const grossProfit = rMultiples.filter((r) => r > 0).reduce((a, r) => a + r, 0);
  const grossLoss = Math.abs(rMultiples.filter((r) => r < 0).reduce((a, r) => a + r, 0));
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? null : 0);

  const rrValues = closed.map((s) => s.riskReward).filter((v) => typeof v === 'number');
  const avgRiskReward = rrValues.length
    ? Number((rrValues.reduce((a, b) => a + b, 0) / rrValues.length).toFixed(2))
    : 0;

  // Equity curve in R-multiples -> max drawdown, measured in R (not $), since
  // this bot never knows the user's actual position size.
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  rMultiples.forEach((r) => {
    cum += r;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  });

  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let runWin = 0;
  let runLoss = 0;
  let curType = null;
  let curCount = 0;
  closed.forEach((s) => {
    if (s.result === 'WIN') {
      runWin += 1;
      runLoss = 0;
      maxWinStreak = Math.max(maxWinStreak, runWin);
    } else {
      runLoss += 1;
      runWin = 0;
      maxLossStreak = Math.max(maxLossStreak, runLoss);
    }
    if (s.result === curType) curCount += 1;
    else {
      curType = s.result;
      curCount = 1;
    }
  });

  return {
    totalSignals,
    wins,
    losses,
    winRate,
    avgRiskReward,
    profitFactor,
    maxDrawdownR: Number(maxDD.toFixed(2)),
    maxWinStreak,
    maxLossStreak,
    currentStreak: { type: curType, count: curCount },
    advanced: computeAdvancedMetrics(rMultiples, maxDD),
  };
}

// Genuine, data-derived observations - nothing here is pre-written; every
// sentence is generated from whatever the closed signals actually show, and
// categories/regimes with too few samples are simply left out rather than
// guessed at.
function buildInsights(allSignals) {
  const closed = (allSignals || []).filter((s) => s.status === 'CLOSED' && s.result && s.categoryScores);
  if (!closed.length) return ['Not enough closed signals yet to draw insights.'];

  const MIN_SAMPLES = 5;
  const catStats = {};
  closed.forEach((s) => {
    const sign = s.direction === 'BUY' ? 1 : -1;
    Object.entries(s.categoryScores).forEach(([cat, v]) => {
      if (!v || Math.sign(v.score) !== sign || Math.abs(v.score) <= 0.1) return;
      if (!catStats[cat]) catStats[cat] = { wins: 0, total: 0 };
      catStats[cat].total += 1;
      if (s.result === 'WIN') catStats[cat].wins += 1;
    });
  });

  const insights = [];
  const ranked = Object.entries(catStats)
    .filter(([, v]) => v.total >= MIN_SAMPLES)
    .map(([cat, v]) => ({ cat, winRate: v.wins / v.total, total: v.total }))
    .sort((a, b) => b.winRate - a.winRate);

  if (ranked.length) {
    const best = ranked[0];
    insights.push(
      `${best.cat} has agreed with the winning side ${(best.winRate * 100).toFixed(0)}% of the time ` +
      `across ${best.total} signals - currently your strongest confirming factor.`
    );
    const worst = ranked[ranked.length - 1];
    if (worst.cat !== best.cat) {
      insights.push(
        `${worst.cat} has only agreed with the winning side ${(worst.winRate * 100).toFixed(0)}% of the time ` +
        `across ${worst.total} signals - worth reviewing its weight.`
      );
    }
  } else {
    insights.push(`Not enough per-category samples yet (need ${MIN_SAMPLES}+ per category) to rank confirming factors.`);
  }

  const regimeStats = {};
  closed.forEach((s) => {
    const key = `${s.regime?.trend || 'UNKNOWN'}/${s.regime?.volatility || 'UNKNOWN'}`;
    if (!regimeStats[key]) regimeStats[key] = { wins: 0, total: 0 };
    regimeStats[key].total += 1;
    if (s.result === 'WIN') regimeStats[key].wins += 1;
  });
  const bestRegime = Object.entries(regimeStats)
    .filter(([, v]) => v.total >= MIN_SAMPLES)
    .sort((a, b) => b[1].wins / b[1].total - a[1].wins / a[1].total)[0];
  if (bestRegime) {
    const [key, v] = bestRegime;
    insights.push(`Signals fired during ${key} regime have won ${((v.wins / v.total) * 100).toFixed(0)}% of the time (${v.total} samples).`);
  }

  return insights;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stdev(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// ---- Advanced backtesting metrics, computed from the REAL R-multiple
// series of closed signals - not a synthetic multi-year backtest, but the
// actual live-signal track record. All are per-trade (not annualized),
// which is stated explicitly in the labels rather than implied. ----
function computeAdvancedMetrics(rMultiples, maxDrawdownR) {
  if (!rMultiples.length) {
    return { sharpePerTrade: null, sortinoPerTrade: null, calmarR: null, recoveryFactor: null, expectancyR: null };
  }
  const m = mean(rMultiples);
  const sd = stdev(rMultiples, m);
  const sharpePerTrade = sd > 0 ? Number((m / sd).toFixed(3)) : null;

  const downside = rMultiples.filter((r) => r < 0);
  const downsideDev = downside.length ? Math.sqrt(mean(downside.map((r) => r ** 2))) : 0;
  const sortinoPerTrade = downsideDev > 0 ? Number((m / downsideDev).toFixed(3)) : null;

  const totalR = rMultiples.reduce((a, b) => a + b, 0);
  const calmarR = maxDrawdownR > 0 ? Number((totalR / maxDrawdownR).toFixed(3)) : null;
  const recoveryFactor = maxDrawdownR > 0 ? Number((totalR / maxDrawdownR).toFixed(3)) : null;

  const wins = rMultiples.filter((r) => r > 0);
  const losses = rMultiples.filter((r) => r < 0);
  const winRate = rMultiples.length ? wins.length / rMultiples.length : 0;
  const avgWinR = wins.length ? mean(wins) : 0;
  const avgLossR = losses.length ? Math.abs(mean(losses)) : 0;
  const expectancyR = Number((winRate * avgWinR - (1 - winRate) * avgLossR).toFixed(3));

  return { sharpePerTrade, sortinoPerTrade, calmarR, recoveryFactor, expectancyR };
}

module.exports = { computeStats, buildInsights, computeRMultiple, computeAdvancedMetrics };
