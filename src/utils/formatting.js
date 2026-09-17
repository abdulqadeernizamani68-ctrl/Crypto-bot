const binaryEngine = require('../services/binaryEngine');

function fmtNum(n, decimals = null) {
  if (n === null || n === undefined) return '-';
  if (decimals !== null) return Number(n).toFixed(decimals);
  // auto precision: more decimals for low-priced assets
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n).toFixed(d);
}

function formatBinarySignalMessage(signal) {
  const durationLabel = binaryEngine.formatMinutes(signal.durationMinutes);
  const finalCp = signal.checkpoints[signal.checkpoints.length - 1];
  const lines = [
    `*${signal.symbol} - Binary/Time-based Signal*`,
    '',
    `Entry Price: ${fmtNum(signal.entryPrice)}`,
    `Duration: ${durationLabel}`,
    `Predicted at expiry: price will be *${signal.direction}* entry, around **${fmtNum(finalCp.predictedPrice)}** (likely range ${fmtNum(finalCp.rangeLow)} - ${fmtNum(finalCp.rangeHigh)})`,
    `Confidence: ${signal.confidence}%${signal.highTrust ? ' 🔥 HIGH-TRUST SETUP' : ''}`,
    '',
    `Market structure: ${signal.structure.pattern}`,
    `Volatility: ${signal.volatilityRegime.regime}${signal.volatilityRegime.percentile != null ? ` (${signal.volatilityRegime.percentile}th percentile vs this pair's recent range)` : ''}`,
  ];

  if (signal.supportResistance.support || signal.supportResistance.resistance) {
    const s = signal.supportResistance.support;
    const r = signal.supportResistance.resistance;
    lines.push(
      `Nearest levels: ${s ? `support ${fmtNum(s.price)} (${s.touches}x touched)` : 'no clear support nearby'} | ` +
      `${r ? `resistance ${fmtNum(r.price)} (${r.touches}x touched)` : 'no clear resistance nearby'}`
    );
  }
  if (signal.breakout) {
    lines.push(`Breakout: ${signal.breakout.type.replace(/_/g, ' ').toLowerCase()}${signal.breakout.retested ? ' (retested)' : ' (not yet retested)'}`);
  }

  lines.push(
    '',
    'Confluence (what actually drove this call, strongest first):',
    ...signal.confluenceBreakdown.slice(0, 6).map((f) => `- ${f.factor}: ${f.score > 0 ? '+' : ''}${f.score} (${f.score > 0 ? 'bullish' : f.score < 0 ? 'bearish' : 'neutral'})`),
    ''
  );

  if (signal.timeframeSuggestion) {
    lines.push(
      `💡 Note: this pair's price action currently looks cleaner on a **${signal.timeframeSuggestion.label}** basis ` +
      `(quality ${signal.timeframeSuggestion.quality} vs ${signal.timeframeSuggestion.nativeQuality} on the requested duration) - ` +
      'consider that range if you have flexibility on duration.',
      ''
    );
  }

  lines.push(
    'Chances + expected price at each checkpoint (from measured recent volatility + drift):',
    ...signal.checkpoints.map((cp) =>
      `- ${cp.label}: ${cp.direction} with ${cp.probabilityPct}% chance - expected ~${fmtNum(cp.predictedPrice)} (range ${fmtNum(cp.rangeLow)}-${fmtNum(cp.rangeHigh)})`
    ),
    ''
  );
  if (signal.durationMinutes < 1) {
    lines.push(
      '_Sub-minute duration: extrapolated below the native 1-minute candle',
      'resolution, so treat this as a rougher estimate than 1min+ signals._'
    );
  }
  lines.push(
    '_Price targets are a point estimate + ~68% range (1 std dev), not a',
    'guarantee - actual price can land outside the range. Liquidity/order-book',
    'data is not available from this data source, so it is not part of this',
    'analysis. Estimate on the real market feed (Twelve Data), not Quotex\'s',
    'own OTC price - see README for why those can differ. Analysis only,',
    'not financial advice._'
  );
  return lines.join('\n');
}

function formatBinaryStatsMessage(stats) {
  const lines = [
    '*Binary Signal Accuracy*',
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

module.exports = {
  formatBinarySignalMessage,
  formatBinaryStatsMessage,
  formatBinarySignalJourney,
};
