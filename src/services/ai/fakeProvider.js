// ---- Fake AI provider ----
// Implements the exact same interface as geminiProvider.js
// (`async analyze({ context, language }) -> { text, usage, finishReason,
// blocked }`) but returns a deterministic, canned response instead of
// calling any network. Used ONLY by tests (see tests/ai-*.test.js) so the
// analyst/comparison/schema/end-to-end logic can be verified without a
// real GEMINI_API_KEY or network access - this is what section T's
// "malformed AI response", "Gemini timeout", "missing AI response" tests
// inject in place of the real provider.
//
// NOT wired into provider.js's live selection (AI_PROVIDER=gemini is the
// only real runtime option today) - tests import this directly and pass
// it to analyst.js via its providerOverride parameter.

function makeGoodResponse({ conclusion = 'UP', confidence = 'MEDIUM' } = {}) {
  return JSON.stringify({
    conclusion,
    confidence,
    trend: { bias: conclusion === 'UP' ? 'BULLISH' : conclusion === 'DOWN' ? 'BEARISH' : 'NEUTRAL', note: 'fake trend note' },
    momentum: { bias: 'NEUTRAL', note: 'fake momentum note' },
    structure: { bias: 'NEUTRAL', note: 'fake structure note' },
    volatility: { bias: 'NEUTRAL', note: 'fake volatility note' },
    volume: { bias: 'UNAVAILABLE', note: 'no volume data in snapshot' },
    regime: { bias: 'NEUTRAL', note: 'fake regime note' },
    mtf: { bias: 'NEUTRAL', note: 'fake mtf note' },
    keyEvidence: ['fake evidence 1', 'fake evidence 2'],
    contradictions: [],
    limitations: ['synthetic test response, not a real analysis'],
    reasoningSummary: 'This is a canned fake reasoning summary used for testing.',
  });
}

// `behavior` controls what analyze() does - set per-test:
//   'ok'        -> returns a well-formed response (default)
//   'malformed' -> returns text that isn't valid JSON
//   'schema-invalid' -> returns valid JSON that fails schema validation
//   'empty'     -> returns empty text (simulates a safety-blocked response)
//   'timeout'   -> throws a timeout-shaped error
//   'rate-limit'-> throws a rate-limit-shaped error
//   'error'     -> throws a generic transport error
function makeFakeProvider(behavior = 'ok', opts = {}) {
  return {
    async analyze({ context, language }) { // eslint-disable-line no-unused-vars
      if (behavior === 'timeout') {
        const err = new Error('simulated timeout');
        err.isTimeout = true;
        throw err;
      }
      if (behavior === 'rate-limit') {
        const err = new Error('simulated 429');
        err.status = 429;
        err.isRateLimit = true;
        throw err;
      }
      if (behavior === 'error') {
        throw new Error('simulated transport error');
      }
      if (behavior === 'empty') {
        return { text: null, usage: null, finishReason: 'SAFETY', blocked: true, blockReason: 'SAFETY' };
      }
      if (behavior === 'malformed') {
        return { text: 'this is not { valid json at all', usage: { promptTokens: 10, responseTokens: 5, totalTokens: 15 }, finishReason: 'STOP', blocked: false };
      }
      if (behavior === 'schema-invalid') {
        return { text: JSON.stringify({ conclusion: 'MAYBE', confidence: 'SUPER_HIGH' }), usage: null, finishReason: 'STOP', blocked: false };
      }
      return {
        text: makeGoodResponse(opts),
        usage: { promptTokens: 200, responseTokens: 120, totalTokens: 320 },
        finishReason: 'STOP',
        blocked: false,
      };
    },
  };
}

module.exports = { makeFakeProvider, makeGoodResponse };
