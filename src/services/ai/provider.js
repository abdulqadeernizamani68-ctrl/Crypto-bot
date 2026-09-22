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
// getProvider()/getConfigProblem()/isConfigured() are the original
// single-provider API and are unchanged - existing callers (and every
// providerOverride-based test) keep working exactly as before.
//
// getProviderChain() is the resilience layer on top of that: it returns an
// ORDERED list of independent provider instances for analyst.js to try in
// turn for one logical AI call, so the market workflow is never hard-
// dependent on exactly one model being reachable (see the header comment
// there for exactly when it moves to the next entry). The chain is built
// from named CONFIG SLICES (config.ai.gemini, config.ai.geminiFallback),
// not a hard-coded vendor branch - adding a genuinely different vendor
// later means writing one more module with the same { analyze() } shape
// and appending it here; analyst.js, comparison.js, and the Discord command
// layer never need to change, since they only ever see the
// { name, analyze, configProblem } shape below, never a vendor name.
//
// Today only Gemini is implemented (geminiProvider.js), instantiated twice
// (primary model + optional fallback model) via geminiProvider.createProvider -
// same request/retry/backoff code, independently configured. A genuinely
// different vendor is NOT shipped here: doing so would mean guessing at
// model ids/response shapes this codebase has no way to verify against a
// live account, which is exactly the "unverified model id" risk the
// GEMINI_MODEL design already avoids elsewhere. See the README's AI
// resilience section for how to add one for real.

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

function getFallbackConfigProblem() {
  if (!config.ai.geminiFallback.apiKey) return 'GEMINI_FALLBACK_API_KEY (or GEMINI_API_KEY) is not set';
  return null; // .model presence is what gates whether this entry exists at all - see below
}

// Ordered list of { name, analyze, configProblem } entries for analyst.js
// to try in turn. The primary entry is always present (even when
// unconfigured, so "nothing at all is configured" still reports exactly as
// it always has via the single-entry path). The fallback entry is appended
// ONLY when GEMINI_FALLBACK_MODEL is actually set - unset (the default),
// the chain always has exactly one entry and behavior is byte-for-byte
// identical to the pre-fallback implementation.
function getProviderChain(nameOverride) {
  const primaryName = (nameOverride || config.ai.provider || 'gemini').toLowerCase();
  if (primaryName !== 'gemini') {
    // An explicitly-requested non-Gemini provider name has no fallback
    // chain concept (yet) - preserve the old single-provider behavior and
    // errors exactly (getProvider() throws on an unrecognized name).
    return [{ name: primaryName, analyze: getProvider(nameOverride).analyze, configProblem: getConfigProblem(nameOverride) }];
  }

  const chain = [{
    name: 'gemini-primary',
    analyze: geminiProvider.analyze,
    configProblem: getConfigProblem(nameOverride),
  }];

  if (config.ai.geminiFallback.model) {
    chain.push({
      name: 'gemini-fallback',
      analyze: geminiProvider.createProvider(() => config.ai.geminiFallback).analyze,
      configProblem: getFallbackConfigProblem(),
    });
  }
  return chain;
}

module.exports = {
  getProvider, isConfigured, getConfigProblem, getProviderChain, PROVIDERS,
};
