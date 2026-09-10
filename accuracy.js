function closedOnly(signals) {
  return signals.filter((s) => s.status === 'CLOSED' && s.result);
}

function computeStats(signals) {
  const closed = closedOnly(signals);
  const total = closed.length;
  const wins = closed.filter((s) => s.result === 'WIN').length;
  const losses = closed.filter((s) => s.result === 'LOSS').length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  // R-multiples: risk per trade normalized to 1R using planned SL distance.
  let grossWinR = 0;
  let grossLossR = 0;
  const rSeries = [];
  for (const s of closed) {
    if (s.entry == null || s.stopLoss == null) continue;
    const riskDist = Math.abs(s.entry - s.stopLoss);
    if (riskDist <= 0) continue;
    const closePrice = s.closePrice ?? s.entry;
    const pnlDist = s.direction === 'BUY' ? closePrice - s.entry : s.entry - closePrice;
    const rMultiple = pnlDist / riskDist;
    rSeries.push(rMultiple);
    if (rMultiple >= 0) grossWinR += rMultiple; else grossLossR += Math.abs(rMultiple);
  }

  const profitFactor = grossLossR > 0 ? Number((grossWinR / grossLossR).toFixed(2)) : (grossWinR > 0 ? Infinity : 0);
  const avgRR = closed.length
    ? Number((closed.reduce((a, s) => a + (s.riskReward || 0), 0) / closed.length).toFixed(2))
    : 0;

  // Max drawdown in cumulative R terms across the closed-signal sequence
  // (ordered by signal time).
  const ordered = [...closed].sort((a, b) => a.signalTime - b.signalTime);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let curStreak = 0;
  let curStreakType = null;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  for (const s of ordered) {
    const riskDist = s.entry != null && s.stopLoss != null ? Math.abs(s.entry - s.stopLoss) : 0;
    const closePrice = s.closePrice ?? s.entry;
    const pnlDist = riskDist > 0 && s.entry != null
      ? (s.direction === 'BUY' ? closePrice - s.entry : s.entry - closePrice)
      : 0;
    const r = riskDist > 0 ? pnlDist / riskDist : 0;
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);

    if (s.result === curStreakType) {
      curStreak += 1;
    } else {
      curStreakType = s.result;
      curStreak = 1;
    }
    if (curStreakType === 'WIN') maxWinStreak = Math.max(maxWinStreak, curStreak);
    if (curStreakType === 'LOSS') maxLossStreak = Math.max(maxLossStreak, curStreak);
  }

  // current live streak = trailing streak at the end of the ordered list
  let liveStreak = 0;
  let liveType = null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (liveType === null) { liveType = ordered[i].result; liveStreak = 1; }
    else if (ordered[i].result === liveType) liveStreak += 1;
    else break;
  }

  return {
    totalSignals: total,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    avgRiskReward: avgRR,
    profitFactor,
    maxDrawdownR: Number(maxDrawdown.toFixed(2)),
    maxWinStreak,
    maxLossStreak,
    currentStreak: { type: liveType, count: liveStreak },
  };
}

function groupWinRate(signals, keyFn) {
  const groups = {};
  for (const s of closedOnly(signals)) {
    const key = keyFn(s);
    if (key === null || key === undefined) continue;
    if (!groups[key]) groups[key] = { total: 0, wins: 0 };
    groups[key].total += 1;
    if (s.result === 'WIN') groups[key].wins += 1;
  }
  const out = {};
  for (const [k, v] of Object.entries(groups)) {
    out[k] = { total: v.total, wins: v.wins, winRate: Number(((v.wins / v.total) * 100).toFixed(1)) };
  }
  return out;
}

// Builds short, data-derived observations - only emitted once there is
// enough sample size to say something meaningful, so the bot never invents
// marketing-style claims from thin data.
function buildInsights(signals, minSamplesPerGroup = 5) {
  const closed = closedOnly(signals);
  const insights = [];
  if (closed.length < minSamplesPerGroup) {
    return ['Not enough closed signals yet to generate reliable insights.'];
  }

  const byRegimeTrend = groupWinRate(closed, (s) => s.regime && s.regime.trend);
  for (const [regime, stats] of Object.entries(byRegimeTrend)) {
    if (stats.total >= minSamplesPerGroup) {
      insights.push(`${regime} market conditions: ${stats.winRate}% win rate over ${stats.total} signals.`);
    }
  }

  const byVolRegime = groupWinRate(closed, (s) => s.regime && s.regime.volatility);
  for (const [vol, stats] of Object.entries(byVolRegime)) {
    if (stats.total >= minSamplesPerGroup) {
      insights.push(`${vol.replace('_', ' ').toLowerCase()} conditions: ${stats.winRate}% win rate over ${stats.total} signals.`);
    }
  }

  const byDirection = groupWinRate(closed, (s) => s.direction);
  for (const [dir, stats] of Object.entries(byDirection)) {
    if (stats.total >= minSamplesPerGroup) {
      insights.push(`${dir} signals: ${stats.winRate}% win rate over ${stats.total} signals.`);
    }
  }

  const byPairDirection = groupWinRate(closed, (s) => `${s.pair} ${s.direction}`);
  for (const [key, stats] of Object.entries(byPairDirection)) {
    if (stats.total >= minSamplesPerGroup) {
      insights.push(`${key} signals: ${stats.winRate}% win rate over ${stats.total} signals.`);
    }
  }

  const highConf = closed.filter((s) => s.confidence >= 85);
  const lowConf = closed.filter((s) => s.confidence < 85);
  if (highConf.length >= minSamplesPerGroup) {
    const wr = (highConf.filter((s) => s.result === 'WIN').length / highConf.length) * 100;
    insights.push(`Signals with confidence 85%+ historically: ${wr.toFixed(1)}% win rate (${highConf.length} signals).`);
  }
  if (lowConf.length >= minSamplesPerGroup) {
    const wr = (lowConf.filter((s) => s.result === 'WIN').length / lowConf.length) * 100;
    insights.push(`Signals with confidence below 85%: ${wr.toFixed(1)}% win rate (${lowConf.length} signals).`);
  }

  if (!insights.length) {
    insights.push('Collecting more closed signals before reliable patterns can be reported.');
  }
  return insights;
}

module.exports = { computeStats, buildInsights, closedOnly };
