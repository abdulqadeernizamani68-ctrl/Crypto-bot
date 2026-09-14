const binaryEngine = require('../services/binaryEngine');

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

// Extended (structural) invalidation level + real, historically-measured
// recovery odds at several time horizons. Any checkpoint without enough
// accumulated history says so explicitly instead of guessing.
function formatExtendedInvalidation(ext) {
  const lines = [`Extended Stop Loss (structural invalidation): ${fmtNum(ext.level)}`];
  lines.push(`Agar ye level hit ho, ${fmtNum(ext.referencePrice)} tak wapas aane ke chances (is pair ki apni history se):`);
  ext.checkpoints.forEach((cp) => {
    if (cp.samples < cp.minSamples) {
      lines.push(`- ${cp.label}: not enough historical data yet (n=${cp.samples}/${cp.minSamples})`);
    } else {
      lines.push(`- ${cp.label}: ${cp.probabilityPct}% (n=${cp.samples})`);
    }
  });
  return lines.join('\n');
}

function formatSignalMessage(signal, { detailed = false } = {}) {
  if (signal.direction === 'NO TRADE') {
    if (!detailed) {
      return [...paperPrefix(signal), '*NO TRADE*', '', 'Market conditions not favorable.'].join('\n');
    }
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
      ...(signal.topInvalidationFactors && signal.topInvalidationFactors.length
        ? ['', 'Kyun trade nahi (detected factors):', ...signal.topInvalidationFactors.map((r) => `- ${r}`)]
        : []),
    ].join('\n');
  }

  if (!detailed) {
    return [
      ...paperPrefix(signal),
      `*${signal.direction}*`,
      '',
      `Entry: ${fmtNum(signal.entry)}`,
      `TP: ${fmtNum(signal.takeProfit)}`,
      `SL: ${fmtNum(signal.stopLoss)}`,
      `Confidence: ${signal.confidence}%`,
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
    `Grade: ${signal.grade}`,
    `Valid for: ${signal.validityMinutes} minutes`,
    '',
    `Market Regime: ${signal.regime.trend} (${signal.regime.directionalTrend || '-'}) / ${signal.regime.volatility}`,
    `Aligned categories: ${Object.values(signal.categoryScores).filter((c) => Math.sign(c.score) === (signal.direction === 'BUY' ? 1 : -1) && Math.abs(c.score) > 0.1).length}/${Object.keys(signal.categoryScores).length}`,
    ...(signal.expectedValue
      ? [
          '',
          `Win Probability: ${signal.expectedValue.winProbability}%  |  Loss Probability: ${signal.expectedValue.lossProbability}%`,
          `Expected Value: ${signal.expectedValue.expectedValueR}R`,
        ]
      : []),
    ...(signal.featureImportance && signal.featureImportance.length
      ? ['', 'Feature Importance (what mattered most for this score):', ...signal.featureImportance.slice(0, 6).map((f) => `- ${f.category}: ${f.importancePct}% (score ${f.score})`)]
      : []),
    ...(signal.anomalies && signal.anomalies.length
      ? ['', 'Anomaly flags:', ...signal.anomalies.map((a) => `- ${a.type} (${a.severity}): ${a.note}`)]
      : []),
    ...(signal.topConfirmations && signal.topConfirmations.length
      ? ['', 'Kyun ye trade (confirming factors):', ...signal.topConfirmations.map((r) => `- ${r}`)]
      : []),
    ...(signal.topInvalidationFactors && signal.topInvalidationFactors.length
      ? ['', 'Risk / disagreeing factors:', ...signal.topInvalidationFactors.map((r) => `- ${r}`)]
      : []),
    ...trapAndConditionLines(signal),
    ...(signal.extendedInvalidation ? ['', formatExtendedInvalidation(signal.extendedInvalidation)] : []),
    ...(signal.riskAssessment
      ? ['', `Risk score: ${signal.riskAssessment.riskScore}/100 (daily ${signal.riskAssessment.dailyR}R, weekly ${signal.riskAssessment.weeklyR}R, drawdown ${signal.riskAssessment.currentDrawdownR}R)`]
      : []),
    '',
    '_Analysis only - not financial advice. No auto-trading._',
  ];
  return lines.join('\n');
}

function formatStatsMessage(stats) {
  const lines = [
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
  ];
  if (stats.advanced && stats.totalSignals >= 10) {
    const a = stats.advanced;
    lines.push(
      '',
      '*Advanced Metrics (per-trade, not annualized)*',
      `Sharpe (per-trade): ${a.sharpePerTrade ?? '-'}`,
      `Sortino (per-trade): ${a.sortinoPerTrade ?? '-'}`,
      `Calmar (total R / max DD): ${a.calmarR ?? '-'}`,
      `Recovery Factor: ${a.recoveryFactor ?? '-'}`,
      `Expectancy: ${a.expectancyR ?? '-'}R per trade`
    );
  } else if (stats.totalSignals > 0) {
    lines.push('', '(Advanced metrics show once you have 10+ closed signals - too few samples to be meaningful yet.)');
  }
  return lines.join('\n');
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
    smc: 'Smart Money Concepts',
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

function formatBinarySignalMessage(signal) {
  const durationLabel = binaryEngine.formatMinutes(signal.durationMinutes);
  const lines = [
    `*${signal.symbol} - Binary/Time-based Signal*`,
    '',
    `Entry Price: ${fmtNum(signal.entryPrice)}`,
    `Duration: ${durationLabel}`,
    `Predicted at expiry: price will be *${signal.direction}* entry`,
    `Confidence: ${signal.confidence}%${signal.highTrust ? ' 🔥 HIGH-TRUST SETUP' : ''}`,
    '',
    'Chances at each checkpoint (from measured recent volatility + drift):',
    ...signal.checkpoints.map((cp) => `- ${cp.label}: ${cp.direction} with ${cp.probabilityPct}% chance`),
    '',
  ];
  if (signal.durationMinutes < 1) {
    lines.push(
      '_Sub-minute duration: extrapolated below the native 1-minute candle',
      'resolution, so treat this as a rougher estimate than 1min+ signals._'
    );
  }
  lines.push(
    '_Estimate on the real market feed (Twelve Data), not Quotex\'s own OTC price -',
    'see README for why those can differ. Analysis only, not financial advice._'
  );
  return lines.join('\n');
}

function formatBinaryStatsMessage(stats) {
  const lines = [
    '*Binary Signal Accuracy (tracked separately from crypto signals)*',
    `Total Signals: ${stats.totalSignals}`,
    `Wins: ${stats.wins}`,
    `Losses: ${stats.losses}`,
    `Win Rate: ${stats.winRate}%`,
  ];
  if (stats.checkpointAccuracy?.length) {
    lines.push('', 'Accuracy by checkpoint (all durations combined):');
    stats.checkpointAccuracy.forEach((c) => {
      lines.push(`- ${c.label}: ${c.accuracyPct}% (n=${c.total})`);
    });
  }
  return lines.join('\n');
}

function formatBinarySignalJourney(s) {
  const lines = [
    `*${s.symbol} - predicted ${s.direction}*`,
    `Entry: ${fmtNum(s.entryPrice)}`,
    `Close (${s.durationMinutes}min later): ${fmtNum(s.closePrice)}`,
    `Result: ${s.result}`,
  ];
  if (s.nearMissNote) lines.push('', s.nearMissNote);
  return lines.join('\n');
}

function formatPerformanceMessage(risk, portfolio) {
  const lines = [
    '*Risk Dashboard (institutional risk engine)*',
    '',
    `Status: ${risk.allowed ? 'Trading allowed' : 'TRADING PAUSED'}`,
    `Risk Score: ${risk.riskScore}/100`,
    '',
    `Today's R: ${risk.dailyR}R`,
    `This week's R: ${risk.weeklyR}R`,
    `Current Drawdown: ${risk.currentDrawdownR}R`,
    `Consecutive Losses: ${risk.consecutiveLosses}`,
    ...(risk.reasons.length ? ['', 'Active protections:', ...risk.reasons.map((r) => `- ${r}`)] : []),
  ];

  if (portfolio) {
    lines.push('', '*Portfolio Risk*', `Open Positions: ${portfolio.openPositions} (${portfolio.uniquePairs.join(', ') || 'none'})`);
    if (portfolio.concentrationWarning) lines.push(`⚠️ ${portfolio.concentrationWarning}`);
    if (portfolio.correlationRisk?.flagged) {
      lines.push('⚠️ High correlation between open positions:');
      portfolio.correlationRisk.highCorrelationPairs.forEach((p) =>
        lines.push(`- ${p.pairA} <-> ${p.pairB}: ${p.correlation} correlation`)
      );
    }
  }

  return lines.join('\n');
}

function formatReviewMessage(pair, signals) {
  if (!signals.length) return `No signals found yet for ${pair}.`;
  const lines = [`*Signal history for ${pair}*`, ''];
  signals.forEach((s) => {
    lines.push(
      `${new Date(s.signalTime).toISOString().slice(0, 16).replace('T', ' ')} - ${s.direction}` +
      (s.grade ? ` (${s.grade})` : '') +
      (s.status === 'CLOSED' ? ` - ${s.result}` : ` - ${s.status}`)
    );
  });
  return lines.join('\n');
}

module.exports = {
  formatSignalMessage,
  formatStatsMessage,
  formatSignalJourney,
  formatExtendedInvalidation,
  formatBinarySignalMessage,
  formatBinaryStatsMessage,
  formatBinarySignalJourney,
  formatPerformanceMessage,
  formatReviewMessage,
  fmtNum,
};
