const config = require('../config');
const accuracySvc = require('./accuracy');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function sumR(signals) {
  return signals.reduce((a, s) => a + accuracySvc.computeRMultiple(s), 0);
}

// Reads-only: never mutates a signal's direction, only decides whether NEW
// signals are allowed to fire right now. All limits are config-driven and
// all numbers are computed fresh from the real signal history every call.
function assessRisk(allSignals) {
  const now = Date.now();
  const closed = (allSignals || []).filter((s) => s.status === 'CLOSED' && s.result);

  const todayClosed = closed.filter((s) => now - s.signalTime < DAY_MS);
  const weekClosed = closed.filter((s) => now - s.signalTime < WEEK_MS);

  const dailyR = Number(sumR(todayClosed).toFixed(2));
  const weeklyR = Number(sumR(weekClosed).toFixed(2));

  // Current drawdown = distance from the running equity peak, using the full
  // closed history in chronological order (same method as accuracy.js).
  const chronological = [...closed].sort((a, b) => a.signalTime - b.signalTime);
  let cum = 0;
  let peak = 0;
  chronological.forEach((s) => {
    cum += accuracySvc.computeRMultiple(s);
    peak = Math.max(peak, cum);
  });
  const currentDrawdownR = Number((peak - cum).toFixed(2));

  // Current consecutive-loss streak (most recent trades backwards).
  let consecutiveLosses = 0;
  for (let i = chronological.length - 1; i >= 0; i--) {
    if (chronological[i].result === 'LOSS') consecutiveLosses += 1;
    else break;
  }

  const reasons = [];
  if (dailyR <= -config.risk.maxDailyLossR) {
    reasons.push(`Daily loss limit hit (${dailyR}R <= -${config.risk.maxDailyLossR}R) - no new trades today`);
  }
  if (weeklyR <= -config.risk.maxWeeklyLossR) {
    reasons.push(`Weekly loss limit hit (${weeklyR}R <= -${config.risk.maxWeeklyLossR}R) - no new trades this week`);
  }
  if (currentDrawdownR >= config.risk.maxDrawdownR) {
    reasons.push(`Drawdown protection triggered (${currentDrawdownR}R >= ${config.risk.maxDrawdownR}R)`);
  }
  if (consecutiveLosses >= config.risk.maxConsecutiveLosses) {
    reasons.push(`Consecutive loss protection: ${consecutiveLosses} losses in a row - cooling down`);
  }

  // A simple 0-100 risk score for the dashboard (`!performance`) - how close
  // to the worst limit we currently are, not a pass/fail by itself.
  const riskScore = Math.round(
    Math.max(
      0,
      Math.min(100, (Math.abs(Math.min(0, dailyR)) / config.risk.maxDailyLossR) * 100),
      Math.min(100, (Math.abs(Math.min(0, weeklyR)) / config.risk.maxWeeklyLossR) * 100),
      Math.min(100, (currentDrawdownR / config.risk.maxDrawdownR) * 100),
      Math.min(100, (consecutiveLosses / config.risk.maxConsecutiveLosses) * 100)
    )
  );

  return {
    allowed: reasons.length === 0,
    reasons,
    dailyR,
    weeklyR,
    currentDrawdownR,
    consecutiveLosses,
    riskScore,
  };
}

module.exports = { assessRisk };
