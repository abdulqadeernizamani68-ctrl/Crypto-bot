// ---- Blind comparison engine ----
// Normalizes the deterministic bot's signal and the AI's independent
// analysis into a common schema, then classifies their relationship. Both
// analyses are already complete and independent by the time this runs
// (analyst.js never receives the bot's conclusion - see marketContext.js)
// - this module only compares finished outputs, it never influences
// either one.
//
// relationship values: 'AGREEMENT' | 'PARTIAL_AGREEMENT' | 'DISAGREEMENT'
//   | 'INSUFFICIENT_DATA'
// 'INSUFFICIENT_DATA' covers: either side didn't produce an analysis (AI not
// configured/timeout/error/rate-limited, or the deterministic bot failed) -
// there is only one analysis to show, not two to compare, and that is
// reported plainly rather than hidden (section K: "do not hide
// disagreement" applies equally to "do not hide the fact that there's
// nothing to compare against").

const BIAS_SCORE_THRESHOLD = 0.15;

function scoreToBias(score) {
  if (score == null || !Number.isFinite(score)) return 'UNAVAILABLE';
  if (score > BIAS_SCORE_THRESHOLD) return 'BULLISH';
  if (score < -BIAS_SCORE_THRESHOLD) return 'BEARISH';
  return 'NEUTRAL';
}

// Bot categories that have a directly-comparable directional group score,
// mapped to the AI schema's equivalent field name. Volatility/regime/mtf
// are intentionally left out of the per-category diff below - the bot
// doesn't score those two as a bullish/bearish lean (volatility regime is
// LOW/NORMAL/HIGH, not directional), so comparing them as "agree/conflict"
// would be forcing a comparison the data doesn't actually support. Their
// AI notes are still shown in the Discord output directly, just not diffed.
const COMPARABLE_CATEGORIES = [
  { botGroup: 'TREND', aiField: 'trend', label: 'Trend' },
  { botGroup: 'MOMENTUM', aiField: 'momentum', label: 'Momentum' },
  { botGroup: 'PRICE_ACTION', aiField: 'structure', label: 'Structure/Price action' },
  { botGroup: 'VOLUME', aiField: 'volume', label: 'Volume' },
];

function normalizeBotView(signal) {
  const direction = signal.direction === 'NO_TRADE' ? 'NO_VIEW' : signal.direction;
  return {
    available: true,
    direction,
    confidenceLabel: signal.direction === 'NO_TRADE' ? null : signal.qualityLabel,
    calibratedProbability: signal.direction === 'NO_TRADE' ? null : signal.calibratedProbability,
    noTradeReasons: signal.noTradeReasons || [],
  };
}

function normalizeAIView(aiResult) {
  if (aiResult.status !== 'OK') {
    return { available: false, status: aiResult.status, reason: aiResult.reason, direction: null, confidenceLabel: null };
  }
  return {
    available: true,
    status: 'OK',
    direction: aiResult.analysis.conclusion,
    confidenceLabel: aiResult.analysis.confidence,
    reasoningSummary: aiResult.analysis.reasoningSummary,
    limitations: aiResult.analysis.limitations,
    contradictions: aiResult.analysis.contradictions,
  };
}

function compareCategoryViews(signal, aiAnalysis) {
  const common = [];
  const conflicting = [];
  const dataQualityDifferences = [];

  for (const { botGroup, aiField, label } of COMPARABLE_CATEGORIES) {
    const botScore = signal.confluenceGroupScores ? signal.confluenceGroupScores[botGroup] : undefined;
    const botBias = botGroup === 'VOLUME' && !(signal.volume && signal.volume.available)
      ? 'UNAVAILABLE'
      : scoreToBias(botScore);
    const aiBias = aiAnalysis[aiField]?.bias || 'UNAVAILABLE';

    if (botBias === 'UNAVAILABLE' || aiBias === 'UNAVAILABLE') {
      if (botBias !== aiBias) {
        dataQualityDifferences.push(`${label}: bot=${botBias}, AI=${aiBias} - one side had data the other didn't`);
      }
      continue;
    }
    if (botBias === aiBias) {
      common.push(`${label}: both read ${botBias} (bot score ${botScore}, AI: "${aiAnalysis[aiField].note}")`);
    } else if (
      (botBias === 'BULLISH' && aiBias === 'BEARISH') ||
      (botBias === 'BEARISH' && aiBias === 'BULLISH')
    ) {
      conflicting.push(`${label}: bot reads ${botBias} (score ${botScore}) but AI reads ${aiBias} ("${aiAnalysis[aiField].note}")`);
    } else {
      // One NEUTRAL, one directional, or one UNCLEAR - a softer mismatch,
      // not a head-on conflict.
      dataQualityDifferences.push(`${label}: bot=${botBias}, AI=${aiBias} - partial mismatch, not a direct conflict`);
    }
  }

  return { common, conflicting, dataQualityDifferences };
}

// `signal` is null when the deterministic bot analysis failed (the unified
// workflow keeps going with whatever evidence exists); `botFailureReason`
// says why, so the comparison can report the gap instead of hiding it.
function compareAnalyses(signal, aiResult, botFailureReason = null) {
  if (!signal) {
    const aiOnly = normalizeAIView(aiResult);
    return {
      relationship: 'INSUFFICIENT_DATA',
      summary: aiOnly.available
        ? `Bot analysis unavailable (${botFailureReason || 'did not run'}) - only the independent AI analysis is available for this request.`
        : `Neither analysis is available (bot: ${botFailureReason || 'did not run'}; AI: ${aiOnly.status}: ${aiOnly.reason}).`,
      bot: { available: false, direction: null, confidenceLabel: null, calibratedProbability: null, noTradeReasons: [], reason: botFailureReason || 'did not run' },
      ai: aiOnly,
      commonEvidence: [],
      conflictingEvidence: [],
      dataQualityDifferences: [],
    };
  }

  const bot = normalizeBotView(signal);
  const ai = normalizeAIView(aiResult);

  if (!ai.available) {
    return {
      relationship: 'INSUFFICIENT_DATA',
      summary: `AI analysis unavailable (${ai.status}: ${ai.reason}) - only the deterministic bot analysis is available for this request.`,
      bot,
      ai,
      commonEvidence: [],
      conflictingEvidence: [],
      dataQualityDifferences: [],
    };
  }

  const { common, conflicting, dataQualityDifferences } = compareCategoryViews(signal, aiResult.analysis);

  let relationship;
  if (bot.direction === 'NO_VIEW' && ai.direction === 'NO_VIEW') {
    relationship = 'AGREEMENT';
  } else if (bot.direction === 'NO_VIEW' || ai.direction === 'NO_VIEW') {
    relationship = 'PARTIAL_AGREEMENT';
  } else if (bot.direction === ai.direction) {
    relationship = conflicting.length > 0 ? 'PARTIAL_AGREEMENT' : 'AGREEMENT';
  } else {
    relationship = 'DISAGREEMENT';
  }

  const summaryBits = [`Bot: ${bot.direction}${bot.direction !== 'NO_VIEW' ? ` (${bot.calibratedProbability}%, ${bot.confidenceLabel})` : ''}`, `AI: ${ai.direction} (${ai.confidenceLabel})`];
  const summary = `${relationship} - ${summaryBits.join(' | ')}`;

  return {
    relationship,
    summary,
    bot,
    ai,
    commonEvidence: common,
    conflictingEvidence: conflicting,
    dataQualityDifferences,
  };
}

module.exports = { compareAnalyses, scoreToBias, COMPARABLE_CATEGORIES };
