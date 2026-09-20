// ---- AI provider abstraction ----
// A provider is any object shaped like:
//
//   async analyze({ context: object, language: 'en'|'roman-urdu'|'urdu',
//                   kind: 'independent'|'synthesis', signal?: AbortSignal })
//     -> { text: string|null, usage: object|null, finishReason: string|null, blocked: boolean }
//
//   - `kind` selects which prompt the provider builds (prompt.js): the
//     blind 'independent' market analysis (raw candles in), or the 'final
//     synthesis' that compares the two finished analyses. Defaults to
//     'independent'.
//   - `signal` (optional AbortSignal) lets the workflow cancel an in-flight
//     call when its overall deadline is reached; a cancelled call throws an
//     error with `.isTimeout = true`.
//   - Throws on transport/HTTP failure (timeout, network, non-2xx). The
//     thrown error may carry `.isTimeout` and/or `.isRateLimit` booleans
//     so callers can react without string-matching.
//   - Returns normally (does not throw) when the call succeeded at the
//     HTTP level but produced no usable text (e.g. safety-blocked) -
//     `text` is null and `blocked` is true in that case.
//   - `text` is the RAW model output - callers are responsible for
//     extracting/validating JSON from it (see schema.js's extractJson +
//     validateAIAnalysis), a provider never pre-parses or trusts its own
//     output.
//
// Today only Gemini is implemented (geminiProvider.js). Adding a second
// provider means writing one more module with this same shape and adding
// one line to getProvider() below - nothing in analyst.js, comparison.js,
// or the Discord command layer needs to know which provider is active.

const geminiProvider = require('./geminiProvider');
const config = require('../../config');

const PROVIDERS = {
  gemini: geminiProvider,
};

function getProvider(nameOverride) {
  const name = (nameOverride || config.ai.provider || 'gemini').toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown AI_PROVIDER "${name}" - available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

// Returns null when the provider is ready to use, otherwise a short human-
// readable reason (surfaced verbatim in the "AI unavailable" state - so a
// missing GEMINI_MODEL is reported as exactly that instead of turning into
// an opaque 404 from the API).
function getConfigProblem(nameOverride) {
  const name = (nameOverride || config.ai.provider || 'gemini').toLowerCase();
  if (name === 'gemini') {
    if (!config.ai.gemini.apiKey) return 'GEMINI_API_KEY is not set';
    if (!config.ai.gemini.model) return 'GEMINI_MODEL is not set (set it to a currently supported Gemini model id)';
    return null;
  }
  return `unknown AI provider "${name}"`;
}

function isConfigured(nameOverride) {
  return getConfigProblem(nameOverride) === null;
}

module.exports = { getProvider, isConfigured, getConfigProblem, PROVIDERS };
