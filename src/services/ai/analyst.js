// ---- Independent AI analyst orchestration ----
// This is the ONLY place that calls an AI provider for market analysis.
// It NEVER throws - every outcome (success, timeout, rate limit, malformed
// response, schema failure, not configured) comes back as a plain result
// object with a `status`, so the deterministic bot analysis can always
// proceed even when this fails entirely (section Q/U: "If Gemini fails,
// the existing deterministic bot must continue working").
//
// status values: 'OK' | 'UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMITED' | 'ERROR'
// - 'UNAVAILABLE': not configured, or the model itself declined/blocked
// - 'TIMEOUT' / 'RATE_LIMITED': transport-level, distinguishable so the
//   caller/UI can say something more specific than "AI analysis failed"
// - 'ERROR': malformed JSON, failed schema validation, or any other
//   transport error

const logger = require('../../utils/logger');
const { getProvider, isConfigured } = require('./provider');
const { buildAIMarketContext } = require('./marketContext');
const { extractJson, validateAIAnalysis } = require('./schema');

async function runIndependentAnalysis(signal, opts = {}) {
  const { language = 'en', providerOverride, providerName } = opts;
  const startedAt = Date.now();

  if (!providerOverride && !isConfigured(providerName)) {
    return {
      status: 'UNAVAILABLE', reason: 'AI provider is not configured (missing API key) - deterministic bot analysis continues without it',
      analysis: null, usage: null, latencyMs: 0,
    };
  }

  const provider = providerOverride || getProvider(providerName);
  const context = buildAIMarketContext(signal);

  let result;
  try {
    result = await provider.analyze({ context, language });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const status = err.isTimeout ? 'TIMEOUT' : err.isRateLimit ? 'RATE_LIMITED' : 'ERROR';
    logger.warn(`AI analyst call failed (${status}): ${err.message}`);
    return { status, reason: err.message, analysis: null, usage: null, latencyMs };
  }
  const latencyMs = Date.now() - startedAt;

  if (result.blocked || !result.text) {
    return {
      status: 'UNAVAILABLE',
      reason: result.blockReason ? `model declined to respond (${result.blockReason})` : 'model returned an empty response',
      analysis: null, usage: result.usage || null, latencyMs,
    };
  }

  const { parsed, error: parseError } = extractJson(result.text);
  if (parseError) {
    logger.warn(`AI analyst response was not valid JSON: ${parseError}`);
    return {
      status: 'ERROR', reason: `malformed response: ${parseError}`,
      analysis: null, usage: result.usage || null, latencyMs,
      rawTextSample: result.text.slice(0, 300),
    };
  }

  const validation = validateAIAnalysis(parsed);
  if (!validation.ok) {
    logger.warn(`AI analyst response failed schema validation: ${validation.errors.join('; ')}`);
    return {
      status: 'ERROR', reason: `response did not match the expected schema: ${validation.errors.join('; ')}`,
      analysis: null, usage: result.usage || null, latencyMs,
    };
  }

  return { status: 'OK', reason: null, analysis: validation.value, usage: result.usage || null, latencyMs, context };
}

module.exports = { runIndependentAnalysis };
