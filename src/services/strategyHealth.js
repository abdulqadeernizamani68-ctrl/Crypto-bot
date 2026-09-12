const accuracySvc = require('./accuracy');

const RECENT_WINDOW = 20;
const DEGRADE_WINRATE_DROP_PP = 15; // percentage points
const DEGRADE_DRAWDOWN_INCREASE_R = 3;

function splitRecentVsPrior(closedChronological) {
  if (closedChronological.length < RECENT_WINDOW * 2) return null;
  const recent = closedChronological.slice(-RECENT_WINDOW);
  const prior = closedChronological.slice(-RECENT_WINDOW * 2, -RECENT_WINDOW);
  return { recent, prior };
}

function winRateOf(signals) {
  if (!signals.length) return 0;
  return (signals.filter((s) => s.result === 'WIN').length / signals.length) * 100;
}

function maxDrawdownOf(signals) {
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  signals.forEach((s) => {
    cum += accuracySvc.computeRMultiple(s);
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  });
  return maxDD;
}

// Reads only, purely observational - never changes live signal decisions.
// (If you want degrading performance to actually restrict trading, that's
// what the institutional risk engine's daily/weekly/drawdown limits already
// do - this command is for visibility, not enforcement, to keep the two
// concerns separate and easy to reason about independently.)
function assessStrategyHealth(allSignals) {
  const closed = (allSignals || [])
    .filter((s) => s.status === 'CLOSED' && s.result)
    .sort((a, b) => a.signalTime - b.signalTime);

  if (closed.length < RECENT_WINDOW * 2) {
    return {
      enoughData: false,
      samplesSoFar: closed.length,
      neededForTrend: RECENT_WINDOW * 2,
    };
  }

  const { recent, prior } = splitRecentVsPrior(closed);
  const recentWinRate = winRateOf(recent);
  const priorWinRate = winRateOf(prior);
  const recentDD = maxDrawdownOf(recent);
  const priorDD = maxDrawdownOf(prior);

  const winRateDrop = priorWinRate - recentWinRate;
  const drawdownIncrease = recentDD - priorDD;

  const alerts = [];
  if (winRateDrop >= DEGRADE_WINRATE_DROP_PP) {
    alerts.push(`Win rate dropped ${winRateDrop.toFixed(1)} percentage points (last ${RECENT_WINDOW}: ${recentWinRate.toFixed(1)}% vs prior ${RECENT_WINDOW}: ${priorWinRate.toFixed(1)}%)`);
  }
  if (drawdownIncrease >= DEGRADE_DRAWDOWN_INCREASE_R) {
    alerts.push(`Drawdown trend worsening: ${recentDD.toFixed(2)}R in the last ${RECENT_WINDOW} vs ${priorDD.toFixed(2)}R in the prior ${RECENT_WINDOW}`);
  }

  // Regime-by-regime breakdown, reusing the same grouping approach as
  // accuracy.js's buildInsights but reported here as a trend table.
  const regimeStats = {};
  closed.forEach((s) => {
    const key = `${s.regime?.trend || 'UNKNOWN'}/${s.regime?.volatility || 'UNKNOWN'}`;
    if (!regimeStats[key]) regimeStats[key] = { wins: 0, total: 0 };
    regimeStats[key].total += 1;
    if (s.result === 'WIN') regimeStats[key].wins += 1;
  });
  const regimePerformance = Object.entries(regimeStats)
    .filter(([, v]) => v.total >= 5)
    .map(([key, v]) => ({ regime: key, winRatePct: Number(((v.wins / v.total) * 100).toFixed(1)), samples: v.total }))
    .sort((a, b) => b.winRatePct - a.winRatePct);

  return {
    enoughData: true,
    recentWinRate: Number(recentWinRate.toFixed(1)),
    priorWinRate: Number(priorWinRate.toFixed(1)),
    recentDrawdownR: Number(recentDD.toFixed(2)),
    priorDrawdownR: Number(priorDD.toFixed(2)),
    degrading: alerts.length > 0,
    alerts,
    regimePerformance,
  };
}

module.exports = { assessStrategyHealth };
