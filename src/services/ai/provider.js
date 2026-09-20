// ---- AI provider abstraction ----
// A provider is any object shaped like:
//
//   async analyze({ context: object, language: 'en'|'roman-urdu'|'urdu' })
//     -> { text: string|null, usage: object|null, finishReason: string|null, blocked: boolean }
//
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

function isConfigured(nameOverride) {
  const name = (nameOverride || config.ai.provider || 'gemini').toLowerCase();
  if (name === 'gemini') return !!config.ai.gemini.apiKey;
  return false;
}

module.exports = { getProvider, isConfigured, PROVIDERS };
