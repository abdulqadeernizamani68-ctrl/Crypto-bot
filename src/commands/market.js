// ---- !market command: bot + independent AI analyst + blind comparison ----
// Orchestration only - every real piece of logic lives in its own module
// (binaryEngine for the deterministic analysis, services/ai/* for the AI
// analyst, services/ai/comparison.js for the blind comparison,
// marketFormatting.js for Discord output). This file wires them together
// and handles the natural-language entry point.
//
// Flow (matches the pipeline diagram in section J of the spec):
//   MARKET DATA -> BOT ANALYSIS -\
//                                  -> COMPARISON -> FINAL EXPLANATION
//                  AI ANALYSIS  -/
// Bot and AI analyses run from the SAME already-fetched market data
// (binaryEngine.generateBinarySignal fetches once; marketContext.js
// derives the AI's input from that same signal, with the bot's own
// conclusion stripped out - see that file's header for exactly what's
// excluded and why). Comparison only runs once both are finished.

const binaryEngine = require('../services/binaryEngine');
const calibrationSvc = require('../services/calibration');
const { runIndependentAnalysis } = require('../services/ai/analyst');
const { compareAnalyses } = require('../services/ai/comparison');
const { parseMarketRequest } = require('../services/nlu');
const analysisMemory = require('../services/analysisMemory');
const analysisLog = require('../services/analysisLog');
const marketFormatting = require('../utils/marketFormatting');
const logger = require('../utils/logger');

const DEFAULT_HORIZON_MINUTES = 5;

function formatFromMemory(record, parsed) {
  const { signal, aiResult, comparison } = record;
  switch (parsed.intent) {
    case 'compare':
    case 'differences-only':
      return marketFormatting.formatDifferencesOnly(comparison);
    case 'reasoning':
      return marketFormatting.formatReasoningOnly(signal, aiResult);
    case 'dataquality':
      return marketFormatting.formatDataQualityOnly(signal);
    default: {
      let note = '';
      if (parsed.language !== record.language) {
        note = "\n\n_(Note: AI summary yahan usi language mein hai jo pehli dafa generate hui thi - naya language ke liye symbol ke saath dubara pucho, e.g. '!market EURUSD analyse karo Roman Urdu mein'.)_";
      }
      return marketFormatting.formatMarketAnalysis(signal, aiResult, comparison, { compact: parsed.compact }) + note;
    }
  }
}

async function handleMarketCommand(scopeId, text) {
  const parsed = parseMarketRequest(text);
  const requestTimestamp = Date.now();

  // No symbol found -> this is a follow-up on a previous analysis (or an
  // invalid request with nothing to go on). Never invent a symbol; never
  // let memory alter any calculation - it only re-formats what was
  // already computed and stored (section O).
  if (!parsed.symbol) {
    let last;
    try {
      last = await analysisMemory.getLastAnalysis(scopeId);
    } catch (err) {
      logger.error(`Memory lookup failed: ${err.message}`);
      last = null;
    }
    if (!last) {
      return "Symbol samajh nahi aaya aur is channel ke liye koi pichli analysis bhi nahi mili.\nExample: `!market EURUSD analyse karo` ya `!market BTCUSD 15m analysis`.";
    }
    return formatFromMemory(last, parsed);
  }

  const horizonMinutes = parsed.horizonMinutes || DEFAULT_HORIZON_MINUTES;

  let signal;
  try {
    signal = await binaryEngine.generateBinarySignal(parsed.symbol, horizonMinutes);
  } catch (err) {
    logger.error(`Market analysis data fetch failed for ${parsed.symbol}: ${err.message}`);
    return `${parsed.symbol} ke liye market data fetch nahi ho saka: ${err.message}`;
  }

  const aiResult = await runIndependentAnalysis(signal, { language: parsed.language });
  const comparison = compareAnalyses(signal, aiResult);

  // Best-effort side effects - a failure here must never block the reply
  // the user is waiting on.
  const record = { signal, aiResult, comparison, language: parsed.language };
  try {
    await analysisMemory.saveLastAnalysis(scopeId, record);
  } catch (err) {
    logger.error(`Failed to save analysis memory: ${err.message}`);
  }
  try {
    await analysisLog.logAnalysis({ signal, aiResult, comparison, language: parsed.language, mode: parsed.intent, requestTimestamp });
  } catch (err) {
    logger.error(`Failed to write analysis log: ${err.message}`);
  }

  switch (parsed.intent) {
    case 'compare':
    case 'differences-only':
      return marketFormatting.formatDifferencesOnly(comparison);
    case 'reasoning':
      return marketFormatting.formatReasoningOnly(signal, aiResult);
    case 'dataquality':
      return marketFormatting.formatDataQualityOnly(signal);
    default: {
      let expiryPerf = null;
      try {
        expiryPerf = await calibrationSvc.getExpiryPerf(signal.expiryBucket.key);
      } catch (err) {
        logger.error(`Failed to load expiry perf for research summary: ${err.message}`);
      }
      return marketFormatting.formatMarketAnalysis(signal, aiResult, comparison, { compact: parsed.compact, expiryPerf });
    }
  }
}

module.exports = { handleMarketCommand };
