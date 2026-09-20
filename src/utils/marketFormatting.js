// ---- Discord formatting for the !market research workflow ----
// Two families of output:
//  * the FINAL RESEARCH REPORT the unified workflow produces (one synthesized
//    report - formatSynthesisReport) plus its explicit non-happy-path
//    states (partial/degraded, INSUFFICIENT_DATA, timeout, error), all
//    dispatched from renderWorkflowResult();
//  * the older side-by-side layouts (formatMarketAnalysis full/compact,
//    differences-only, reasoning-only, data-quality-only), still used for
//    the explicit "sirf differences" / "reasoning" / "data quality" views,
//    for follow-ups, and as the honest fallback when the final synthesis
//    couldn't be produced.
// Numbers that matter (bot probabilities, prices, data-quality flags) are
// always printed from the computed data here in code - never taken from
// LLM prose.

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
  lines.push(comparison.bot.available === false
    ? `Bot: unavailable (${comparison.bot.reason || 'did not run'})`
    : `Bot: ${comparison.bot.direction}${comparison.bot.direction !== 'NO_VIEW' ? ` (${comparison.bot.calibratedProbability}%)` : ''}`);
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

// ---------------------------------------------------------------------
// Unified-workflow output
// ---------------------------------------------------------------------

// Discord rejects message content over 2000 characters. Use exactly that as
// the limit so anything that already fit in one message (every existing
// reply) is still sent as one message - only text that would previously have
// been rejected gets split.
const DISCORD_MESSAGE_LIMIT = 2000;

// Splits text into Discord-sized chunks, preferring paragraph, then line,
// then word boundaries. A short text comes back as a single chunk, so
// callers can use this unconditionally.
function splitForDiscord(text, limit = DISCORD_MESSAGE_LIMIT) {
  const str = String(text == null ? '' : text);
  if (str.length <= limit) return [str];
  const chunks = [];
  let rest = str;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function clip(text, max) {
  const t = String(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function bulletList(items, { maxItems = 4, maxChars = 200 } = {}) {
  const shown = items.slice(0, maxItems).map((i) => `- ${clip(i, maxChars)}`);
  if (items.length > maxItems) shown.push(`- (+${items.length - maxItems} more)`);
  return shown;
}

function utcLabel(isoMinute) {
  return `${isoMinute.replace('T', ' ').replace('Z', '')} UTC`;
}

function dataLine(market) {
  const bits = [
    `ref price ${fmtNum(market.referencePrice)} (${market.priceSource})`,
    `last candle ${utcLabel(market.lastCandleUtc)}${market.lastCandleAgeMinutes != null ? ` (${market.lastCandleAgeMinutes} min ago)` : ''}`,
    `data quality: ${market.dataQualityIssues.length ? market.dataQualityIssues.join('; ') : 'clean'}`,
  ];
  if (market.stale) bits.push('⚠️ STALE - market may be closed, treat as a historical read');
  return `Data: ${bits.join(' | ')}`;
}

function botLineFor(bot) {
  return bot && bot.status === 'OK' ? botStatusLine(bot.signal) : `unavailable (${bot ? bot.reason : 'did not run'})`;
}

function historyLineFor(bot) {
  const perf = bot && bot.expiryPerf;
  if (!perf) return null;
  return `Historical accuracy (${perf.label} horizon bucket): ${perf.total ? `${perf.winRatePct}% over ${perf.total} closed trades` : 'no closed trades yet'} - small samples are noisy`;
}

const REPORT_FOOTER = '_Research/analysis only - not financial advice and not a trade instruction. AI output is validated before display and never executed._';

function formatSynthesisReport(result, opts = {}) {
  const {
    market, bot, ai, comparison, synthesis,
  } = result;
  const s = synthesis.synthesis;
  const lines = [];

  if (opts.compact) {
    lines.push(`**${market.symbol}** (${market.horizonLabel}) - Research view: **${s.overallView}** (${s.confidence}) | Bot vs AI: ${comparison.relationship}`);
    lines.push(s.headline);
    lines.push(`Bot: ${botLineFor(bot)}`);
    lines.push(`AI: ${aiStatusLine(ai)}`);
    if (market.stale) lines.push('⚠️ Data is stale - market may be closed.');
    const limitation = s.dataQualityLimitations[0];
    if (limitation) lines.push(`Main limitation: ${clip(limitation, 240)}`);
    if (s.confidenceNote) lines.push(`_${s.confidenceNote}_`);
    return lines.join('\n');
  }

  lines.push(`**MARKET RESEARCH REPORT** - ${market.symbol} | horizon ${market.horizonLabel}`);
  lines.push(dataLine(market));
  lines.push('');
  lines.push(`**Research view: ${s.overallView}** (confidence ${s.confidence}) | Bot vs AI: ${comparison.relationship}`);
  lines.push(s.headline);
  if (s.confidenceNote) lines.push(`_${s.confidenceNote}_`);

  lines.push('');
  lines.push('**How the two analyses compare**');
  lines.push(s.agreementSummary);
  lines.push(`- Bot engine: ${botLineFor(bot)}`);
  const history = historyLineFor(bot);
  if (history) lines.push(`- ${history}`);
  lines.push(`- Independent AI: ${aiStatusLine(ai)}`);
  if (s.whereTheyAgree.length) lines.push('Agree:', ...bulletList(s.whereTheyAgree));
  if (s.whereTheyDisagree.length) lines.push('Differ:', ...bulletList(s.whereTheyDisagree));

  if (s.contradictions.length) {
    lines.push('', '**Contradictions**', ...bulletList(s.contradictions));
  }
  if (s.dataQualityLimitations.length) {
    lines.push('', '**Data-quality limitations**', ...bulletList(s.dataQualityLimitations));
  }
  if (s.whatWouldChangeTheView.length) {
    lines.push('', '**What would change the view**', ...bulletList(s.whatWouldChangeTheView, { maxItems: 3 }));
  }

  lines.push('', '**Research summary**', s.report);
  lines.push('', REPORT_FOOTER);
  return lines.join('\n');
}

function formatAiOnly(ai) {
  const a = ai.analysis;
  return [
    '**AI ANALYST** (independent - Gemini)',
    `Independent conclusion: ${a.conclusion} (${a.confidence})`,
    `Key evidence: ${a.keyEvidence.join('; ') || 'none given'}`,
    `Contradictions noted by AI: ${a.contradictions.length ? a.contradictions.join('; ') : 'none noted'}`,
    `Limitations noted by AI: ${a.limitations.length ? a.limitations.join('; ') : 'none noted'}`,
    '',
    '**AI EXPLANATION**',
    a.reasoningSummary,
  ].join('\n');
}

// Honest fallback: the final synthesis wasn't produced, but at least one
// analysis exists. Nothing that completed is dropped, and whatever failed is
// stated plainly.
function formatDegradedReport(result, opts = {}) {
  const {
    market, bot, ai, comparison,
  } = result;
  const lines = [];
  lines.push(`**MARKET RESEARCH REPORT (partial)** - ${market.symbol} | horizon ${market.horizonLabel}`);
  lines.push(`⚠️ Final AI synthesis not available: ${result.reason}. Showing the completed analyses directly instead.`);
  lines.push(dataLine(market));
  lines.push('');

  if (bot && bot.status === 'OK') {
    lines.push(formatMarketAnalysis(bot.signal, ai, comparison, { compact: opts.compact, expiryPerf: bot.expiryPerf }));
  } else {
    lines.push(`**BOT ANALYST**: unavailable (${bot ? bot.reason : 'did not run'})`, '');
    lines.push(ai && ai.status === 'OK' ? formatAiOnly(ai) : `**AI ANALYST**: unavailable (${ai ? `${ai.status}: ${ai.reason}` : 'did not run'})`);
    lines.push('', '_Analysis only, not financial advice._');
  }
  return lines.join('\n');
}

const DATA_FAILURE_HINT = {
  DATA_FETCH_FAILED: 'the market-data request failed',
  TOO_FEW_CANDLES: 'the data provider returned too few recent candles',
  INVALID_DATA: 'the returned candles failed validation',
  DATA_TIMEOUT: 'the market-data request timed out',
};

function formatInsufficientData(result) {
  const { request } = result;
  return [
    `**INSUFFICIENT_DATA** - ${request.symbol}`,
    `Not enough valid market data to run a research analysis: ${DATA_FAILURE_HINT[result.reasonCode] || 'data unavailable'} (${result.reason}).`,
    'No direction, probability or confidence was generated - nothing is estimated when the data is not there. Check the symbol or try again shortly.',
  ].join('\n');
}

function formatTimeout(result) {
  const { request } = result;
  return `⏱️ **TIMEOUT** - the ${request.symbol} analysis did not finish in time (${Math.round(result.totalMs / 1000)}s). ${result.reason ? `Detail: ${clip(result.reason, 300)}. ` : ''}Please try again.`;
}

function formatWorkflowError(result) {
  const { request } = result;
  return `❌ **ANALYSIS FAILED** - ${request.symbol}: ${clip(result.reason || 'unknown error', 400)}`;
}

// The narrower views (explicit user request or follow-up). Works on any
// result that carries analyses, regardless of its outcome.
function formatAnalysesView(result, intent) {
  const { bot, ai, comparison } = result;
  const botOK = bot && bot.status === 'OK';
  switch (intent) {
    case 'compare':
    case 'differences-only':
      return comparison ? formatDifferencesOnly(comparison) : 'No comparison is available for that analysis.';
    case 'reasoning': {
      if (botOK && ai) return formatReasoningOnly(bot.signal, ai);
      return ai && ai.status === 'OK'
        ? `**Reasoning**\n\nBot analysis unavailable (${bot ? bot.reason : 'did not run'}).\n\nAI reasoning:\n${ai.analysis.reasoningSummary}`
        : `Reasoning is not available for that analysis (bot: ${bot ? bot.reason || bot.status : 'n/a'}; AI: ${ai ? `${ai.status}` : 'n/a'}).`;
    }
    case 'dataquality':
      return botOK ? formatDataQualityOnly(bot.signal) : `Data-quality detail is not available (${bot ? bot.reason : 'bot did not run'}).`;
    default:
      return null;
  }
}

// One entry point: workflow result -> the text the user sees.
function renderWorkflowResult(result, opts = {}) {
  const { intent = 'analyze', compact = false } = opts;
  switch (result.outcome) {
    case 'REPORT':
      return formatSynthesisReport(result, { compact });
    case 'DEGRADED':
      return formatDegradedReport(result, { compact });
    case 'ANALYSES':
      return formatAnalysesView(result, intent) || formatDegradedReport({ ...result, reason: 'a narrower view was requested' }, { compact });
    case 'INSUFFICIENT_DATA':
      return formatInsufficientData(result);
    case 'TIMEOUT':
      return formatTimeout(result);
    default:
      return formatWorkflowError(result);
  }
}

module.exports = {
  renderWorkflowResult,
  formatSynthesisReport,
  formatDegradedReport,
  formatInsufficientData,
  formatTimeout,
  formatWorkflowError,
  formatAnalysesView,
  splitForDiscord,
  formatMarketAnalysis,
  formatDifferencesOnly,
  formatReasoningOnly,
  formatDataQualityOnly,
  botStatusLine,
  aiStatusLine,
};
