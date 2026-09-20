// ---- Fake AI provider ----
// Implements the exact same interface as geminiProvider.js
// (`async analyze({ context, language, kind, signal }) -> { text, usage,
// finishReason, blocked }`) but returns a deterministic, canned response
// instead of calling any network. Used ONLY by tests (see tests/*.test.js)
// so the analyst/comparison/schema/workflow logic can be verified without a
// real GEMINI_API_KEY or network access.
//
// NOT wired into provider.js's live selection (AI_PROVIDER=gemini is the
// only real runtime option today) - tests import this directly and pass it
// to analyst.js / the workflow via the providerOverride option.
//
// Every call is recorded on `provider.calls` ({ kind, context, language,
// startedAt, endedAt, signalAborted }) so tests can assert WHAT the model
// was shown and WHEN each stage started relative to the other.

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

function makeGoodSynthesis({ overallView = 'UP', confidence = 'MEDIUM' } = {}) {
  return JSON.stringify({
    overallView,
    confidence,
    headline: 'Fake synthesized headline.',
    agreementSummary: 'Fake agreement summary comparing the two analyses.',
    whereTheyAgree: ['fake agreement point'],
    whereTheyDisagree: [],
    contradictions: [],
    dataQualityLimitations: ['fake data-quality limitation'],
    whatWouldChangeTheView: ['fake invalidation condition'],
    report: 'This is a canned fake synthesized research report used for testing.',
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `behavior` controls what analyze() does. Either a string (applies to both
// stages) or { independent: '...', synthesis: '...' }:
//   'ok'             -> returns a well-formed response (default)
//   'malformed'      -> returns text that isn't valid JSON
//   'schema-invalid' -> returns valid JSON that fails schema validation
//   'empty'          -> returns empty text (simulates a safety-blocked response)
//   'timeout'        -> throws a timeout-shaped error
//   'rate-limit'     -> throws a rate-limit-shaped error
//   'error'          -> throws a generic transport error
//   'hang'           -> never resolves on its own; rejects with a timeout-
//                       shaped "cancelled" error when the caller's abort
//                       signal fires (exactly what the real provider does)
// opts:
//   conclusion/confidence   -> independent-stage response content
//   synthesis: { overallView, confidence } -> synthesis-stage content
//   delayMs / delayMsByKind -> artificial latency before responding
//   onCall(callRecord)      -> hook invoked synchronously when a call starts
function makeFakeProvider(behavior = 'ok', opts = {}) {
  const calls = [];
  const behaviorFor = (kind) => (typeof behavior === 'string' ? behavior : (behavior[kind] || 'ok'));

  return {
    calls,
    async analyze({ context, language, kind = 'independent', signal }) {
      const record = { kind, context, language, startedAt: Date.now(), endedAt: null, signalAborted: () => !!(signal && signal.aborted) };
      calls.push(record);
      if (opts.onCall) opts.onCall(record);
      const done = (value) => { record.endedAt = Date.now(); return value; };

      const delay = (opts.delayMsByKind && opts.delayMsByKind[kind]) || opts.delayMs || 0;
      const mode = behaviorFor(kind);

      if (mode === 'hang') {
        return new Promise((resolve, reject) => {
          const fail = () => {
            record.endedAt = Date.now();
            const err = new Error('simulated hang cancelled by workflow deadline');
            err.isTimeout = true;
            err.cancelled = true;
            reject(err);
          };
          if (signal) {
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
          }
        });
      }

      if (delay) await sleep(delay);

      if (mode === 'timeout') {
        const err = new Error('simulated timeout');
        err.isTimeout = true;
        record.endedAt = Date.now();
        throw err;
      }
      if (mode === 'rate-limit') {
        const err = new Error('simulated 429');
        err.status = 429;
        err.isRateLimit = true;
        record.endedAt = Date.now();
        throw err;
      }
      if (mode === 'error') {
        record.endedAt = Date.now();
        throw new Error('simulated transport error');
      }
      if (mode === 'empty') {
        return done({ text: null, usage: null, finishReason: 'SAFETY', blocked: true, blockReason: 'SAFETY' });
      }
      if (mode === 'malformed') {
        return done({ text: 'this is not { valid json at all', usage: { promptTokens: 10, responseTokens: 5, totalTokens: 15 }, finishReason: 'STOP', blocked: false });
      }
      if (mode === 'schema-invalid') {
        return done({ text: JSON.stringify({ conclusion: 'MAYBE', confidence: 'SUPER_HIGH', overallView: 'MAYBE' }), usage: null, finishReason: 'STOP', blocked: false });
      }
      return done({
        text: kind === 'synthesis' ? makeGoodSynthesis(opts.synthesis) : makeGoodResponse(opts),
        usage: { promptTokens: 200, responseTokens: 120, totalTokens: 320 },
        finishReason: 'STOP',
        blocked: false,
      });
    },
  };
}

module.exports = { makeFakeProvider, makeGoodResponse, makeGoodSynthesis };
