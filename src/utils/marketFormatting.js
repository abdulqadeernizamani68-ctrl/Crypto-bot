// ---- Discord formatting for the !market (bot + AI) analysis ----
// Two modes: full (the structured multi-section layout from spec section
// M) and compact (a few lines, for when the full layout would be too
// long for a Discord message or the user explicitly asked for brief).

function fmtNum(n, decimals = null) {
  if (n === null || n === undefined) return '-';
  if (decimals !== null) return Number(n).toFixed(decimals);
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n).toFixed(d);
}

function botStatusLine(signal) {
  if (signal.direction === 'NO_TRADE') {
    return `NO_TRADE (${signal.noTradeReasons[0] || 'insufficient evidence'}${signal.noTradeReasons.length > 1 ? ` + ${signal.noTradeReasons.length - 1} more` : ''})`;
  }
  return `${signal.direction} - raw ${signal.rawProbability}%, calibrated ${signal.calibratedProbability}% (${signal.qualityLabel})`;
}

function aiStatusLine(aiResult) {
  if (aiResult.status !== 'OK') {
    return `unavailable (${aiResult.status}: ${aiResult.reason})`;
  }
  return `${aiResult.analysis.conclusion} (${aiResult.analysis.confidence} confidence)`;
}

function formatFull(signal, aiResult, comparison, opts = {}) {
  const lines = [];
  lines.push('**MARKET ANALYSIS**');
  lines.push(`Symbol: ${signal.symbol}`);
  lines.push(`Timestamp: ${new Date(signal.signalTime).toISOString()}`);
  lines.push(`Data Quality: ${signal.dataQualityIssues?.length ? signal.dataQualityIssues.join('; ') : 'clean'}`);
  lines.push(`Analysis timeframe: 1-minute candles | Horizon: ${signal.durationMinutes} min (${signal.expiryBucket.label})`);

  lines.push('');
  lines.push('**BOT ANALYST** (deterministic engine)');
  lines.push(`Status: ${botStatusLine(signal)}`);
  lines.push(`Key factors: ${(signal.confluenceBreakdown || []).slice(0, 5).map((f) => `${f.factor} ${f.score > 0 ? '+' : ''}${f.score}`).join(', ') || 'none'}`);
  lines.push(`MTF: ${signal.multiTimeframe ? `${signal.multiTimeframe.label} tilt ${signal.multiTimeframe.tilt}, agreement=${signal.multiTimeframe.agreement}` : 'not applicable at this horizon'}`);
  lines.push(`Regime: ${signal.regime.label}${signal.regime.reasons?.length ? ` (${signal.regime.reasons.join('; ')})` : ''}`);
  lines.push(`Session: ${signal.session.session}`);

  lines.push('');
  lines.push('**AI ANALYST** (independent - Gemini)');
  if (aiResult.status === 'OK') {
    const a = aiResult.analysis;
    lines.push(`Independent conclusion: ${a.conclusion} (${a.confidence})`);
    lines.push(`Key evidence: ${a.keyEvidence.join('; ') || 'none given'}`);
    lines.push(`Contradictions noted by AI: ${a.contradictions.length ? a.contradictions.join('; ') : 'none noted'}`);
    lines.push(`Limitations noted by AI: ${a.limitations.length ? a.limitations.join('; ') : 'none noted'}`);
  } else {
    lines.push(`Independent conclusion: unavailable`);
    lines.push(`Reason: ${aiResult.status} - ${aiResult.reason}`);
  }

  lines.push('');
  lines.push('**COMPARISON**');
  lines.push(`Agreement: ${comparison.relationship}`);
  lines.push(`Common evidence: ${comparison.commonEvidence.length ? comparison.commonEvidence.join(' | ') : 'none identified'}`);
  lines.push(`Differences: ${comparison.conflictingEvidence.length ? comparison.conflictingEvidence.join(' | ') : 'none identified'}`);
  if (comparison.dataQualityDifferences.length) {
    lines.push(`Data-quality differences: ${comparison.dataQualityDifferences.join(' | ')}`);
  }

  if (opts.expiryPerf || opts.regimePerf) {
    lines.push('');
    lines.push('**RESEARCH SUMMARY**');
    lines.push(`Horizon: ${signal.expiryBucket.label}`);
    if (opts.expiryPerf) {
      lines.push(`Sample information: ${opts.expiryPerf.total} completed trades in this expiry bucket historically`);
      lines.push(`Historical/out-of-sample accuracy: ${opts.expiryPerf.total ? `${opts.expiryPerf.winRatePct}%` : 'no completed trades yet'}`);
    }
    lines.push('Relevant limitations: small samples are noisy; this is not a guarantee of future performance.');
  }

  lines.push('');
  lines.push('**AI EXPLANATION**');
  if (aiResult.status === 'OK') {
    lines.push(aiResult.analysis.reasoningSummary);
  } else {
    lines.push('AI explanation unavailable for this request - showing the deterministic bot analysis only.');
  }

  lines.push('');
  lines.push('_Analysis only, not financial advice. AI output is independently generated and validated before display - never executed as code or treated as a trade instruction._');

  return lines.join('\n');
}

function formatCompact(signal, aiResult, comparison) {
  const lines = [
    `**${signal.symbol}** (${signal.durationMinutes}min) - Bot: ${botStatusLine(signal)}`,
    `AI: ${aiStatusLine(aiResult)}`,
    `${comparison.relationship}${comparison.conflictingEvidence.length ? ` - ${comparison.conflictingEvidence.length} conflict(s)` : ''}`,
  ];
  if (aiResult.status === 'OK') lines.push(aiResult.analysis.reasoningSummary);
  return lines.join('\n');
}

function formatMarketAnalysis(signal, aiResult, comparison, opts = {}) {
  return opts.compact ? formatCompact(signal, aiResult, comparison) : formatFull(signal, aiResult, comparison, opts);
}

function formatDifferencesOnly(comparison) {
  const lines = [`**Comparison: ${comparison.relationship}**`];
  lines.push(`Bot: ${comparison.bot.direction}${comparison.bot.direction !== 'NO_VIEW' ? ` (${comparison.bot.calibratedProbability}%)` : ''}`);
  lines.push(`AI: ${comparison.ai.available ? comparison.ai.direction : `unavailable (${comparison.ai.status})`}`);
  if (comparison.conflictingEvidence.length) {
    lines.push('', 'Conflicts:', ...comparison.conflictingEvidence.map((c) => `- ${c}`));
  } else {
    lines.push('', 'No direct conflicts identified between the two analyses.');
  }
  if (comparison.dataQualityDifferences.length) {
    lines.push('', 'Data-quality differences:', ...comparison.dataQualityDifferences.map((c) => `- ${c}`));
  }
  return lines.join('\n');
}

function formatReasoningOnly(signal, aiResult) {
  const lines = ['**Reasoning**', '', 'Bot factors (grouped confluence, strongest first):'];
  lines.push(...(signal.confluenceBreakdown || []).slice(0, 8).map((f) => `- [${f.group}] ${f.factor}: ${f.score > 0 ? '+' : ''}${f.score}`));
  if (signal.direction === 'NO_TRADE') {
    lines.push('', 'Bot NO_TRADE reasons:', ...signal.noTradeReasons.map((r) => `- ${r}`));
  }
  lines.push('', 'AI reasoning:');
  lines.push(aiResult.status === 'OK' ? aiResult.analysis.reasoningSummary : `unavailable (${aiResult.status}: ${aiResult.reason})`);
  return lines.join('\n');
}

function formatDataQualityOnly(signal) {
  const lines = [
    `**Data Quality - ${signal.symbol}**`,
    `Issues: ${signal.dataQualityIssues?.length ? signal.dataQualityIssues.join('; ') : 'none - clean candle series'}`,
    `Volume data: ${signal.volume?.available ? 'available' : `unavailable${signal.volume?.reason ? ` (${signal.volume.reason})` : ''}`}`,
  ];
  return lines.join('\n');
}

module.exports = {
  formatMarketAnalysis,
  formatDifferencesOnly,
  formatReasoningOnly,
  formatDataQualityOnly,
  botStatusLine,
  aiStatusLine,
};
