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

function buildRequestBody(context, language, kind = 'independent') {
  const prompt = kind === 'synthesis'
    ? buildSynthesisPrompt(context, language)
    : buildPrompt(context, language);
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2, // low - this is analysis, not creative writing
      maxOutputTokens: config.ai.gemini.maxOutputTokens,
      responseMimeType: 'application/json', // ask Gemini to constrain to JSON directly where supported
    },
  };
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

async function callOnce(requestBody, timeoutMs, externalSignal) {
  const { apiKey, model, baseUrl } = config.ai.gemini;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set - cannot call the Gemini provider');
  }
  if (!model) {
    throw new Error('GEMINI_MODEL is not set - cannot call the Gemini provider (set it to a currently supported model id)');
  }
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const hint = res.status === 404 ? ' (model not found - check GEMINI_MODEL is a currently supported model id)' : '';
      const err = new Error(`Gemini API error ${res.status}${hint}: ${errBody.slice(0, 300)}`);
      err.status = res.status;
      // Surface rate-limit/quota distinctly so callers can react (e.g. back
      // off, or tell the user to try later) without string-matching later.
      err.isRateLimit = res.status === 429;
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

async function analyze({ context, language = 'en', kind = 'independent', signal }) {
  const { timeoutMs, maxRetries } = config.ai.gemini;
  const requestBody = buildRequestBody(context, language, kind);

  let lastErr;
  // Only retry on transport-ish failures (timeout, 5xx, network) - never
  // retry a rate-limit/quota error into a worse rate-limit problem, and
  // never retry a 4xx that isn't going to change (bad request/auth), and
  // never retry once the caller's own deadline has already passed.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await callOnce(requestBody, timeoutMs, signal);
      return result;
    } catch (err) {
      lastErr = err;
      const retryable = err.isTimeout || (err.status && err.status >= 500) || (!err.status && !err.isRateLimit);
      if (err.isRateLimit || !retryable || err.cancelled || (signal && signal.aborted) || attempt === maxRetries) {
        logger.warn(`Gemini call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
        throw err;
      }
      logger.warn(`Gemini call failed, retrying (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
    }
  }
  throw lastErr;
}

module.exports = { analyze, buildRequestBody, parseGeminiResponseBody };
