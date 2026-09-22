// ---- AI stage orchestration (independent analysis + final synthesis) ----
// This is the ONLY place that calls an AI provider for market analysis.
// Nothing here ever throws - every outcome (success, timeout, rate limit,
// malformed response, schema failure, not configured) comes back as a plain
// result object with a `status`, so the unified workflow
// (services/marketWorkflow.js) can always carry on with whatever evidence it
// has, and the deterministic bot analysis is never lost because an AI call
// failed.
//
// Resilience: callAndValidate() below doesn't call a single hard-coded
// provider - it walks provider.js's getProviderChain(), normally just the
// one configured Gemini model, but a second, independently-configured model
// (GEMINI_FALLBACK_MODEL) is tried automatically if the first is
// unavailable for ANY reason (persistent 503, timeout, malformed output,
// etc), short of the workflow's own deadline having already passed. This
// means the whole market workflow is not a single point of failure on one
// model being reachable, without either AI stage's caller (marketWorkflow.js)
// needing to know or care how many providers were tried.
//
// status values: 'OK' | 'UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMITED' | 'ERROR'
// - 'UNAVAILABLE': not configured (no key / no GEMINI_MODEL), or the model
//   itself declined/blocked/returned nothing
// - 'TIMEOUT' / 'RATE_LIMITED': transport-level, distinguishable so the
//   caller/UI can say something more specific than "AI analysis failed"
//   (TIMEOUT also covers "cancelled because the workflow deadline passed")
// - 'ERROR': malformed JSON, failed schema validation, or any other
//   transport error
// These reflect the LAST provider tried; when a fallback was configured and
// actually attempted, the result also carries `providerUsed` (on success)
// or `attempts` (the full per-provider trail) - both are additive and only
// appear once more than one provider entry actually exists, so a setup with
// no fallback configured (or a test using providerOverride) gets the exact
// same shape it always has.
//
// Two public entry points, one shared call-and-validate path:
//   runIndependentAnalysis(inputs, opts)  - STAGE 1. `inputs` is the RAW
//     snapshot (candles etc). The bot's result is not a parameter, so it
//     cannot influence this stage even by accident.
//   runFinalSynthesis({ inputs, bot, ai, comparison }, opts) - STAGE 2.

const logger = require('../../utils/logger');
const { getProviderChain } = require('./provider');
const { buildIndependentContext, buildSynthesisContext } = require('./marketContext');
const { extractJson, validateAIAnalysis, validateSynthesis } = require('./schema');

// One attempt against ONE chain entry: call it, then run the exact same
// parse/validate pipeline every provider's raw text has to pass. Never
// throws - every outcome comes back as { ok, status, reason, ... } so the
// chain loop in callAndValidate can decide whether to try the next entry.
async function attemptOneProvider(entry, {
  kind, context, language, validate, signal,
}) {
  const startedAt = Date.now();

  if (entry.configProblem) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      reason: `AI provider is not configured (${entry.configProblem}) - deterministic bot analysis is unaffected`,
      value: null,
      usage: null,
      latencyMs: 0,
    };
  }

  let result;
  try {
    result = await entry.analyze({
      context, language, kind, signal,
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const status = err.isTimeout ? 'TIMEOUT' : err.isRateLimit ? 'RATE_LIMITED' : 'ERROR';
    logger.warn(`AI ${kind} call via ${entry.name} failed (${status}): ${err.message}`);
    return {
      ok: false, status, reason: err.message, value: null, usage: null, latencyMs, cancelled: !!err.cancelled,
    };
  }
  const latencyMs = Date.now() - startedAt;

  if (result.blocked || !result.text) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      reason: result.blockReason ? `model declined to respond (${result.blockReason})` : 'model returned an empty response',
      value: null,
      usage: result.usage || null,
      latencyMs,
    };
  }

  const { parsed, error: parseError } = extractJson(result.text);
  if (parseError) {
    logger.warn(`AI ${kind} response via ${entry.name} was not valid JSON: ${parseError}`);
    const truncated = result.finishReason === 'MAX_TOKENS';
    return {
      ok: false,
      status: 'ERROR',
      reason: truncated
        ? 'response was cut off before the JSON finished (MAX_TOKENS) - raise GEMINI_MAX_OUTPUT_TOKENS'
        : `malformed response: ${parseError}`,
      value: null,
      usage: result.usage || null,
      latencyMs,
      rawTextSample: result.text.slice(0, 300),
    };
  }

  const validation = validate(parsed);
  if (!validation.ok) {
    logger.warn(`AI ${kind} response via ${entry.name} failed schema validation: ${validation.errors.join('; ')}`);
    return {
      ok: false,
      status: 'ERROR',
      reason: `response did not match the expected schema: ${validation.errors.join('; ')}`,
      value: null,
      usage: result.usage || null,
      latencyMs,
    };
  }

  return {
    ok: true, status: 'OK', reason: null, value: validation.value, usage: result.usage || null, latencyMs,
  };
}

// Tries each provider in the chain in turn (see provider.js's
// getProviderChain - normally just the primary Gemini model; with
// GEMINI_FALLBACK_MODEL set, a second independently-configured model too).
// Moves to the next entry on ANY failure (not configured, transport error,
// blocked/empty response, malformed JSON, or failed schema validation) -
// short of a workflow-deadline cancellation, in which case trying another
// provider would just burn the little time left for nothing, so it stops
// immediately. With no fallback configured (or when a caller passes
// providerOverride, as every existing test does) the chain has exactly one
// entry and this behaves byte-for-byte like the original single-provider
// implementation: same statuses, same reason strings, no extra fields.
async function callAndValidate({
  kind, context, language, validate, providerOverride, providerName, signal,
}) {
  const chain = providerOverride
    ? [{ name: 'override', analyze: providerOverride.analyze, configProblem: null }]
    : getProviderChain(providerName);

  const attempts = [];
  let last = null;
  for (let i = 0; i < chain.length; i += 1) {
    const entry = chain[i];
    // eslint-disable-next-line no-await-in-loop
    const attempt = await attemptOneProvider(entry, {
      kind, context, language, validate, signal,
    });
    if (attempt.ok) {
      const extra = chain.length > 1
        ? { providerUsed: entry.name, attempts: [...attempts, { provider: entry.name, status: 'OK' }] }
        : {};
      return {
        status: 'OK', reason: null, value: attempt.value, usage: attempt.usage, latencyMs: attempt.latencyMs, ...extra,
      };
    }
    attempts.push({ provider: entry.name, status: attempt.status, reason: attempt.reason });
    last = attempt;
    const deadlinePassed = attempt.cancelled || (signal && signal.aborted);
    const isLastEntry = i === chain.length - 1;
    if (deadlinePassed || isLastEntry) break;
    logger.warn(`AI ${kind}: ${entry.name} unavailable (${attempt.status}) - falling back to the next configured provider`);
  }

  const extra = chain.length > 1 ? { attempts, providerUsed: null } : {};
  return {
    status: last.status,
    reason: last.reason,
    value: null,
    usage: last.usage,
    latencyMs: last.latencyMs,
    ...(last.rawTextSample ? { rawTextSample: last.rawTextSample } : {}),
    ...extra,
  };
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
    ...(r.providerUsed !== undefined ? { providerUsed: r.providerUsed } : {}),
    ...(r.attempts ? { attempts: r.attempts } : {}),
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
  return {
    status: r.status, reason: r.reason, synthesis, usage: r.usage, latencyMs: r.latencyMs,
    ...(r.providerUsed !== undefined ? { providerUsed: r.providerUsed } : {}),
    ...(r.attempts ? { attempts: r.attempts } : {}),
  };
}

module.exports = { runIndependentAnalysis, runFinalSynthesis, applyConfidenceGuardrails };
