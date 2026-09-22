// ---- Gemini provider ----
// Talks to the Gemini REST API (generateContent) directly via fetch (no
// SDK dependency - one fewer package to add/pin, and the request shape is
// simple enough not to need one). Implements the provider interface
// documented in provider.js: `async analyze({ context, language }) ->
// { text, usage }`, throws on transport/HTTP failure (timeout, non-2xx,
// network error) - callers (analyst.js) are responsible for catching that
// and degrading gracefully, this module's job is just "make the call
// correctly or fail clearly".

const config = require('../../config');
const logger = require('../../utils/logger');
const { buildPrompt, buildSynthesisPrompt } = require('./prompt');

// NOTE: deliberately no list of "known good/bad" model ids here (see
// config.js's comment on GEMINI_MODEL). Gemini model ids are retired on a
// rolling basis, so any such list embedded in code would itself go stale
// and start giving false confidence. The API's own 404 (handled below) is
// the source of truth for "this model id no longer exists" - this module's
// job is just to make that failure clear and point at where to look, not to
// pre-judge model ids itself.

function buildRequestBody(cfg, context, language, kind = 'independent') {
  const prompt = kind === 'synthesis'
    ? buildSynthesisPrompt(context, language)
    : buildPrompt(context, language);
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2, // low - this is analysis, not creative writing
      maxOutputTokens: cfg.maxOutputTokens,
      responseMimeType: 'application/json', // ask Gemini to constrain to JSON directly where supported
    },
  };
}

// ---- Retry timing ----
// Per https://ai.google.dev/gemini-api/docs/troubleshooting (checked
// 2026-09-21): "If you receive an error indicating that you should retry
// your request (such as a 429 RESOURCE_EXHAUSTED or 503 UNAVAILABLE), we
// recommend implementing an exponential backoff strategy" - wait ~1s before
// the first retry, double each time, add jitter. Google's own troubleshooting
// page also separately documents 503 (`service_unavailable`) as "The service
// is temporarily overloaded or down" - a capacity problem on Google's side,
// unrelated to which API key is used, so retrying (not rotating keys) is the
// correct response.
//
// This deliberately does NOT extend that same backoff-retry treatment to
// 429: Google's API-errors reference splits 429 into `rate_limit_exceeded`
// (retry with backoff) and `quota_exceeded` (wait for the quota to reset -
// retrying does not help), and the classic generateContent endpoint doesn't
// reliably tell these apart from the HTTP status alone. Retrying every 429
// has a documented failure mode in Google's own developer forum: failed
// retries are themselves counted against the per-minute/per-day quota, so a
// burst of 503s retried aggressively can compound into a 429 quota problem.
// Leaving 429 as immediately-fatal (see the `isRateLimit` branch in
// analyze() below) avoids that trap; RATE_LIMITED is still its own status so
// analyst.js reports it distinctly rather than masking it as a generic error.
function computeBackoffDelayMs(attempt, { baseDelayMs, maxDelayMs, retryAfterMs }) {
  const exponentialCap = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  let delay = Math.random() * exponentialCap; // "full jitter" - spreads out concurrent retries
  if (Number.isFinite(retryAfterMs) && retryAfterMs > delay) delay = retryAfterMs;
  // Bounded no matter what: a server-supplied Retry-After should never turn
  // a "bounded exponential backoff" policy into an effectively unbounded one.
  return Math.min(delay, maxDelayMs);
}

// Retry-After is either a number of seconds or an HTTP-date (RFC 9110). It's
// not confirmed the classic generateContent endpoint ever sends this header,
// but honoring it when present costs nothing and is standard HTTP practice.
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(headerValue);
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : null;
}

// Resolves after `ms`, or immediately if `signal` aborts first - so a
// workflow-deadline cancellation during a backoff wait doesn't sit out the
// full delay pointlessly. Never rejects; the retry loop's own signal/
// cancelled checks decide what happens next.
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); resolve(); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Extracts the plain text + usage metadata from a Gemini generateContent
// response body. Returns null text if the shape isn't what's expected
// (e.g. the prompt was blocked by safety filters) rather than throwing -
// that's a valid "AI produced nothing usable" outcome for the caller to
// handle, not a transport error.
function parseGeminiResponseBody(body) {
  const candidate = body?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || null;
  const usage = body?.usageMetadata
    ? {
      promptTokens: body.usageMetadata.promptTokenCount ?? null,
      responseTokens: body.usageMetadata.candidatesTokenCount ?? null,
      totalTokens: body.usageMetadata.totalTokenCount ?? null,
    }
    : null;
  const finishReason = candidate?.finishReason || null;
  const blocked = body?.promptFeedback?.blockReason || (finishReason === 'SAFETY');
  return { text, usage, finishReason, blocked: !!blocked, blockReason: body?.promptFeedback?.blockReason || null };
}

async function callOnce(cfg, requestBody, timeoutMs, externalSignal) {
  const { apiKey, model, baseUrl } = cfg;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set - cannot call the Gemini provider');
  }
  if (!model) {
    throw new Error('GEMINI_MODEL is not set - cannot call the Gemini provider (set it to a currently supported model id)');
  }
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let cancelledByCaller = false;
  const onExternalAbort = () => {
    cancelledByCaller = true;
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      // Auth via the x-goog-api-key header, per Google's current guidance
      // (the older `?key=` query-string form still works, but puts the key
      // in URLs/access logs/error messages - the header keeps it out of
      // all of those). See https://ai.google.dev/gemini-api/docs/api-key
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const hints = {
        404: ' (model not found or retired - check GEMINI_MODEL against https://ai.google.dev/gemini-api/docs/models)',
        // Per Google's docs, 503 is Google-side capacity, never a key/config
        // problem - worth saying explicitly so nobody "fixes" it by rotating
        // GEMINI_API_KEY, which cannot change a Google-side capacity issue.
        503: ' (Gemini\'s service is temporarily overloaded/down - transient, not an API key or config problem; retrying with backoff)',
      };
      const err = new Error(`Gemini API error ${res.status}${hints[res.status] || ''}: ${errBody.slice(0, 300)}`);
      err.status = res.status;
      // Surface rate-limit/quota distinctly so callers can react (e.g. back
      // off, or tell the user to try later) without string-matching later.
      err.isRateLimit = res.status === 429;
      err.retryAfterMs = parseRetryAfterMs(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null);
      throw err;
    }
    const body = await res.json();
    return parseGeminiResponseBody(body);
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(cancelledByCaller
        ? 'Gemini request cancelled (workflow deadline reached)'
        : `Gemini request timed out after ${timeoutMs}ms`);
      timeoutErr.isTimeout = true;
      timeoutErr.cancelled = cancelledByCaller;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// ---- Config-parametrized core ----
// Everything above this point is stateless given a cfg object; this is the
// one function that actually knows how to run the full call+retry cycle for
// a given { apiKey, model, baseUrl, timeoutMs, maxRetries, retryBaseDelayMs,
// retryMaxDelayMs } slice. `analyze()` below binds it to config.ai.gemini
// (the primary provider, unchanged from before this file supported more
// than one slice); createProvider() binds it to any other slice - this is
// how a second, independently-configured Gemini call (e.g. a fallback
// model) is built without duplicating any request/retry/backoff logic, and
// without this module needing to know how many callers exist.
async function analyzeWithConfig(cfg, { context, language = 'en', kind = 'independent', signal }) {
  const {
    timeoutMs, maxRetries, retryBaseDelayMs, retryMaxDelayMs,
  } = cfg;
  const requestBody = buildRequestBody(cfg, context, language, kind);

  let lastErr;
  // Only retry on transport-ish failures (timeout, 5xx, network) - never
  // retry a rate-limit/quota error into a worse rate-limit problem, and
  // never retry a 4xx that isn't going to change (bad request/auth), and
  // never retry once the caller's own deadline has already passed. Between
  // retries, wait a bounded, jittered, exponentially increasing delay (see
  // computeBackoffDelayMs above) rather than hammering an already-overloaded
  // service again immediately.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await callOnce(cfg, requestBody, timeoutMs, signal);
      return result;
    } catch (err) {
      lastErr = err;
      const retryable = err.isTimeout || (err.status && err.status >= 500) || (!err.status && !err.isRateLimit);
      const doneRetrying = err.isRateLimit || !retryable || err.cancelled || (signal && signal.aborted) || attempt === maxRetries;
      if (doneRetrying) {
        logger.warn(`Gemini call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
        throw err;
      }
      const delayMs = computeBackoffDelayMs(attempt, {
        baseDelayMs: retryBaseDelayMs,
        maxDelayMs: retryMaxDelayMs,
        retryAfterMs: err.retryAfterMs,
      });
      logger.warn(`Gemini call failed, retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs, signal);
      if (signal && signal.aborted) {
        // The workflow deadline passed while we were backing off - don't
        // spend another attempt (and another API call) just to confirm
        // what we already know.
        logger.warn(`Gemini call abandoned: workflow deadline passed during backoff (attempt ${attempt + 1}/${maxRetries + 1})`);
        throw err;
      }
    }
  }
  throw lastErr;
}

// Default provider instance: the primary Gemini call, reading config.ai.gemini
// FRESH on every call (so live env/config changes and test overrides are
// always picked up) - byte-for-byte the same behavior this function had
// before this module supported more than one configured Gemini slice.
function analyze(args) {
  return analyzeWithConfig(config.ai.gemini, args);
}

// Builds an independent provider instance bound to another config slice
// (e.g. config.ai.geminiFallback) - same request building, same bounded
// retry+backoff, same error handling, just pointed at a different
// model/key/baseUrl. `getCfg` is called fresh on every analyze() so runtime
// config changes (and test overrides) are honored the same way the default
// export already honors them for the primary slice.
function createProvider(getCfg) {
  return { analyze: (args) => analyzeWithConfig(getCfg(), args) };
}

module.exports = {
  analyze, createProvider, buildRequestBody, parseGeminiResponseBody, computeBackoffDelayMs, parseRetryAfterMs,
};
