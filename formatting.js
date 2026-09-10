function fmtNum(n, decimals = null) {
  if (n === null || n === undefined) return '-';
  if (decimals !== null) return Number(n).toFixed(decimals);
  // auto precision: more decimals for low-priced assets
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n).toFixed(d);
}

function paperPrefix(signal) {
  return signal.paper ? ['*[PAPER MODE - not a live call, for validation only]*', ''] : [];
}

function trapAndConditionLines(signal) {
  const lines = [];
  if (signal.marketConditions && signal.marketConditions.abnormal) {
    lines.push(`⚠ Abnormal market conditions: ${signal.marketConditions.severity}`);
  }
  if (signal.trapWarnings && signal.trapWarnings.length) {
    signal.trapWarnings.forEach((t) => lines.push(`⚠ ${t.type}: ${t.note}`));
  }
  return lines;
}

function formatSignalMessage(signal) {
  if (signal.direction === 'NO TRADE') {
    const reasons = signal.reason && signal.reason.length ? signal.reason.map((r) => `- ${r}`).join('\n') : '- Conditions not aligned';
    return [
      ...paperPrefix(signal),
      `*${signal.pair}*`,
      '*Signal: NO TRADE*',
      '',
      `Confidence: ${signal.confidence}%`,
      `Market Regime: ${signal.regime.trend} / ${signal.regime.volatility}`,
      ...trapAndConditionLines(signal),
      '',
      'Reason:',
      reasons,
    ].join('\n');
  }

  const lines = [
    ...paperPrefix(signal),
    `*${signal.pair}*`,
    `*Signal: ${signal.direction}*`,
    '',
    `Entry: ${fmtNum(signal.entry)}`,
    `Stop Loss: ${fmtNum(signal.stopLoss)}`,
    `Take Profit: ${fmtNum(signal.takeProfit)}`,
    `Risk:Reward: 1:${signal.riskReward}`,
    `Confidence: ${signal.confidence}%`,
    `Valid for: ${signal.validityMinutes} minutes`,
    '',
    `Market Regime: ${signal.regime.trend} / ${signal.regime.volatility}`,
    `Aligned categories: ${Object.values(signal.categoryScores).filter((c) => Math.sign(c.score) === (signal.direction === 'BUY' ? 1 : -1) && Math.abs(c.score) > 0.1).length}/${Object.keys(signal.categoryScores).length}`,
    ...trapAndConditionLines(signal),
    '',
    '_Analysis only - not financial advice. No auto-trading._',
  ];
  return lines.join('\n');
}

function formatStatsMessage(stats) {
  return [
    '*Overall Statistics*',
    `Total Signals: ${stats.totalSignals}`,
    `Wins: ${stats.wins}`,
    `Losses: ${stats.losses}`,
    `Win Rate: ${stats.winRate}%`,
    `Avg Risk:Reward: 1:${stats.avgRiskReward}`,
    `Profit Factor: ${stats.profitFactor}`,
    `Max Drawdown: ${stats.maxDrawdownR}R`,
    `Max Win Streak: ${stats.maxWinStreak}`,
    `Max Loss Streak: ${stats.maxLossStreak}`,
    `Current Streak: ${stats.currentStreak.type || '-'} x${stats.currentStreak.count}`,
  ].join('\n');
}

function formatSignalJourney(s) {
  const entry = s.entry;
  const lowest = s.lowestPriceAfter;
  const highest = s.highestPriceAfter;
  const lowDiff = lowest != null && entry != null ? lowest - entry : null;
  const highDiff = highest != null && entry != null ? highest - entry : null;
  const lowPct = lowDiff != null ? (lowDiff / entry) * 100 : null;
  const highPct = highDiff != null ? (highDiff / entry) * 100 : null;

  const lines = [
    `*${s.pair} ${s.direction}*`,
    '',
    `Entry: ${fmtNum(entry)}`,
    '',
    `Lowest Price Reached: ${fmtNum(lowest)}`,
    `Difference: ${lowDiff >= 0 ? '+' : ''}${fmtNum(lowDiff)} points (${lowPct >= 0 ? '+' : ''}${fmtNum(lowPct, 2)}%)`,
    '',
    `Highest Price Reached: ${fmtNum(highest)}`,
    `Difference: ${highDiff >= 0 ? '+' : ''}${fmtNum(highDiff)} points (${highPct >= 0 ? '+' : ''}${fmtNum(highPct, 2)}%)`,
    '',
    `Result: ${s.closeReason === 'TP_HIT' ? 'TP HIT' : s.closeReason === 'SL_HIT' ? 'SL HIT' : s.closeReason === 'EXPIRED' ? `EXPIRED (${s.result})` : (s.status || 'OPEN')}`,
  ];

  if (s.result) {
    lines.push('', 'Reason:', ...buildReasonBullets(s));
  }

  return lines.join('\n');
}

function buildReasonBullets(s) {
  const bullets = [];
  const scores = s.categoryScores || {};
  const tradeSign = s.direction === 'BUY' ? 1 : -1;
  const agreed = Object.entries(scores).filter(([, v]) => Math.sign(v.score) === tradeSign && Math.abs(v.score) > 0.1);
  const disagreed = Object.entries(scores).filter(([, v]) => Math.sign(v.score) === -tradeSign && Math.abs(v.score) > 0.1);

  const label = (cat) => ({
    trend: 'Trend alignment',
    momentum: 'Momentum',
    volatility: 'Volatility conditions',
    volume: 'Volume',
    structure: 'Market structure',
    supportResistance: 'Support/Resistance',
    breakoutRetest: 'Breakout/Retest',
    liquidity: 'Liquidity',
    orderbook: 'Order book pressure',
    openInterest: 'Open interest',
    funding: 'Funding rate',
  }[cat] || cat);

  if (s.result === 'WIN') {
    agreed.slice(0, 3).forEach(([cat]) => bullets.push(`${label(cat)} supported the move`));
    if (!bullets.length) bullets.push('Confluence of factors supported the move');
  } else {
    disagreed.slice(0, 3).forEach(([cat]) => bullets.push(`${label(cat)} moved against the signal`));
    if (!bullets.length) bullets.push('Move reversed despite initial confluence');
  }
  return bullets;
}

module.exports = { formatSignalMessage, formatStatsMessage, formatSignalJourney, fmtNum };
