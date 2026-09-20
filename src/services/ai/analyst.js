// ---- AI stage orchestration (independent analysis + final synthesis) ----
// This is the ONLY place that calls an AI provider for market analysis.
// Nothing here ever throws - every outcome (success, timeout, rate limit,
// malformed response, schema failure, not configured) comes back as a plain
// result object with a `status`, so the unified workflow
// (services/marketWorkflow.js) can always carry on with whatever evidence it
// has, and the deterministic bot analysis is never lost because an AI call
// failed.
//
// status values: 'OK' | 'UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMITED' | 'ERROR'
// - 'UNAVAILABLE': not configured (no key / no GEMINI_MODEL), or the model
//   itself declined/blocked/returned nothing
// - 'TIMEOUT' / 'RATE_LIMITED': transport-level, distinguishable so the
//   caller/UI can say something more specific than "AI analysis failed"
//   (TIMEOUT also covers "cancelled because the workflow deadline passed")
// - 'ERROR': malformed JSON, failed schema validation, or any other
//   transport error
//
// Two public entry points, one shared call-and-validate path:
//   runIndependentAnalysis(inputs, opts)  - STAGE 1. `inputs` is the RAW
//     snapshot (candles etc). The bot's result is not a parameter, so it
//     cannot influence this stage even by accident.
//   runFinalSynthesis({ inputs, bot, ai, comparison }, opts) - STAGE 2.

const logger = require('../../utils/logger');
const { getProvider, getConfigProblem } = require('./provider');
const { buildIndependentContext, buildSynthesisContext } = require('./marketContext');
const { extractJson, validateAIAnalysis, validateSynthesis } = require('./schema');

async function callAndValidate({ kind, context, language, validate, providerOverride, providerName, signal }) {
  const startedAt = Date.now();

  if (!providerOverride) {
    const problem = getConfigProblem(providerName);
    if (problem) {
      return {
        status: 'UNAVAILABLE',
        reason: `AI provider is not configured (${problem}) - deterministic bot analysis is unaffected`,
        value: null, usage: null, latencyMs: 0,
      };
    }
  }

  const provider = providerOverride || getProvider(providerName);

  let result;
  try {
    result = await provider.analyze({ context, language, kind, signal });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const status = err.isTimeout ? 'TIMEOUT' : err.isRateLimit ? 'RATE_LIMITED' : 'ERROR';
    logger.warn(`AI ${kind} call failed (${status}): ${err.message}`);
    return { status, reason: err.message, value: null, usage: null, latencyMs };
  }
  const latencyMs = Date.now() - startedAt;

  if (result.blocked || !result.text) {
    return {
      status: 'UNAVAILABLE',
      reason: result.blockReason ? `model declined to respond (${result.blockReason})` : 'model returned an empty response',
      value: null, usage: result.usage || null, latencyMs,
    };
  }

  const { parsed, error: parseError } = extractJson(result.text);
  if (parseError) {
    logger.warn(`AI ${kind} response was not valid JSON: ${parseError}`);
    const truncated = result.finishReason === 'MAX_TOKENS';
    return {
      status: 'ERROR',
      reason: truncated
        ? 'response was cut off before the JSON finished (MAX_TOKENS) - raise GEMINI_MAX_OUTPUT_TOKENS'
        : `malformed response: ${parseError}`,
      value: null, usage: result.usage || null, latencyMs,
      rawTextSample: result.text.slice(0, 300),
    };
  }

  const validation = validate(parsed);
  if (!validation.ok) {
    logger.warn(`AI ${kind} response failed schema validation: ${validation.errors.join('; ')}`);
    return {
      status: 'ERROR', reason: `response did not match the expected schema: ${validation.errors.join('; ')}`,
      value: null, usage: result.usage || null, latencyMs,
    };
  }

  return { status: 'OK', reason: null, value: validation.value, usage: result.usage || null, latencyMs };
}

// ---- STAGE 1 ----
async function runIndependentAnalysis(inputs, opts = {}) {
  const { language = 'en', providerOverride, providerName, signal, now } = opts;

  let context;
  try {
    context = buildIndependentContext(inputs, { now });
  } catch (err) {
    logger.warn(`Could not build the independent AI context: ${err.message}`);
    return { status: 'ERROR', reason: `could not prepare market data for the AI: ${err.message}`, analysis: null, usage: null, latencyMs: 0 };
  }

  const r = await callAndValidate({ kind: 'independent', context, language, validate: validateAIAnalysis, providerOverride, providerName, signal });
  return {
    status: r.status, reason: r.reason, analysis: r.value, usage: r.usage, latencyMs: r.latencyMs,
    ...(r.rawTextSample ? { rawTextSample: r.rawTextSample } : {}),
  };
}

// ---- Confidence guardrails (deterministic) ----
// The synthesizer is an LLM; how confident it is allowed to SOUND is capped
// by facts the code already knows. Only ever lowers confidence.
const CONFIDENCE_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const RANK_TO_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'];

function applyConfidenceGuardrails(synthesis, facts) {
  let cap = CONFIDENCE_RANK.HIGH;
  const reasons = [];
  const limit = (level, why) => {
    cap = Math.min(cap, CONFIDENCE_RANK[level]);
    reasons.push(why);
  };
  if (facts.relationship === 'DISAGREEMENT') limit('LOW', 'the bot and the independent AI disagree on direction');
  else if (facts.relationship === 'PARTIAL_AGREEMENT') limit('MEDIUM', 'the two analyses only partly agree');
  else if (facts.relationship === 'INSUFFICIENT_DATA') limit('MEDIUM', 'only one of the two analyses was available');
  if (facts.stale) limit('LOW', 'the market data is stale');

  if (CONFIDENCE_RANK[synthesis.confidence] > cap) {
    return {
      ...synthesis,
      confidence: RANK_TO_CONFIDENCE[cap],
      confidenceNote: `Confidence capped at ${RANK_TO_CONFIDENCE[cap]}: ${reasons.join('; ')}.`,
    };
  }
  return synthesis;
}

// ---- STAGE 2 ----
async function runFinalSynthesis({ inputs, bot, ai, comparison }, opts = {}) {
  const { language = 'en', providerOverride, providerName, signal, now } = opts;

  let context;
  try {
    context = buildSynthesisContext({ inputs, bot, ai, comparison }, { now });
  } catch (err) {
    logger.warn(`Could not build the synthesis context: ${err.message}`);
    return { status: 'ERROR', reason: `could not assemble the synthesis input: ${err.message}`, synthesis: null, usage: null, latencyMs: 0 };
  }

  const r = await callAndValidate({ kind: 'synthesis', context, language, validate: validateSynthesis, providerOverride, providerName, signal });
  const synthesis = r.status === 'OK'
    ? applyConfidenceGuardrails(r.value, { relationship: comparison.relationship, stale: context.marketContext.stale })
    : null;
  return { status: r.status, reason: r.reason, synthesis, usage: r.usage, latencyMs: r.latencyMs };
}

module.exports = { runIndependentAnalysis, runFinalSynthesis, applyConfidenceGuardrails };
