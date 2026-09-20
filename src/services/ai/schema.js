// ---- AI response schema validation ----
// Hand-rolled validators (no ajv dependency - not in package.json, see
// README) for the two JSON shapes the model is asked to return (see
// prompt.js for the exact prompts that describe these shapes to it):
//   validateAIAnalysis  - STAGE 1, the independent analysis (buildPrompt)
//   validateSynthesis   - STAGE 2, the final synthesis (buildSynthesisPrompt)
//
// Both validators:
//   - reject anything that isn't a plain object (null, arrays, primitives)
//   - build a NEW object containing only the fields they recognize, so the
//     returned `value` is always a clean whitelist copy - unexpected/extra
//     keys in the model's response are silently dropped, never passed
//     through
//   - reject any object (at any depth) that carries a key shaped like a
//     function-call / tool-call / executable-code field, since the model's
//     JSON answer is data to display, never instructions or code to run
//     (see the README's "rejects anything resembling a function-call/code
//     field outright" note)
//   - bound every string/list length so one runaway field can't blow up a
//     Discord message or smuggle an oversized payload through a
//     short-looking reply
//
// Returns { ok: true, value } on success, { ok: false, errors: [...] } on
// failure. Neither validator ever throws - a bad response is just another
// status for analyst.js to report, not a crash.

const MAX_SHORT_STRING = 300; // headline / note / bullet-item length
const MAX_LONG_STRING = 1500; // report / reasoningSummary / agreementSummary
const MAX_LIST_ITEMS = 8; // prompts ask the model for <=6; a little headroom, still bounded

// Keys with no legitimate place in an analysis/report JSON object - the
// shape a prompt-injection or function/tool-calling attempt would take.
// Checked recursively (not just at the top level) since the same trick
// could be nested one level down inside a note/bullet field.
const BANNED_KEYS = new Set([
  'function_call', 'functioncall', 'function_calls', 'tool_call', 'tool_calls',
  'toolcall', 'toolcalls', 'code', 'script', 'exec', 'eval', 'shell', 'command',
  'system_instruction', 'systeminstruction', '__proto__', 'constructor', 'prototype',
]);

function hasBannedKey(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasBannedKey(v, depth + 1));
  return Object.keys(value).some((k) => BANNED_KEYS.has(k.toLowerCase()) || hasBannedKey(value[k], depth + 1));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

function isBoundedString(value, { max = MAX_SHORT_STRING, min = 1 } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isBoundedStringArray(value, { maxItems = MAX_LIST_ITEMS, maxLen = MAX_SHORT_STRING } = {}) {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => isBoundedString(item, { max: maxLen, min: 1 }));
}

const BIAS_VALUES = ['BULLISH', 'BEARISH', 'NEUTRAL', 'UNCLEAR', 'UNAVAILABLE'];

function isBiasNote(value) {
  return isPlainObject(value) && isEnum(value.bias, BIAS_VALUES) && isBoundedString(value.note);
}

function fail(errors) {
  return { ok: false, errors };
}

// ---- STAGE 1: independent analysis (see prompt.js buildPrompt) ----
const STAGE1_GROUPS = ['trend', 'momentum', 'structure', 'volatility', 'volume', 'regime', 'mtf'];
const STAGE1_LISTS = ['keyEvidence', 'contradictions', 'limitations'];

function validateAIAnalysis(raw) {
  if (!isPlainObject(raw)) return fail(['response is not a JSON object']);
  if (hasBannedKey(raw)) return fail(['response contains a function-call/code-like field']);

  const errors = [];
  if (!isEnum(raw.conclusion, ['UP', 'DOWN', 'NO_VIEW'])) errors.push('conclusion must be UP, DOWN or NO_VIEW');
  if (!isEnum(raw.confidence, ['LOW', 'MEDIUM', 'HIGH'])) errors.push('confidence must be LOW, MEDIUM or HIGH');
  STAGE1_GROUPS.forEach((g) => { if (!isBiasNote(raw[g])) errors.push(`${g} must be a { bias, note } object`); });
  STAGE1_LISTS.forEach((f) => {
    if (!isBoundedStringArray(raw[f])) errors.push(`${f} must be a list of at most ${MAX_LIST_ITEMS} short strings`);
  });
  if (!isBoundedString(raw.reasoningSummary, { max: MAX_LONG_STRING })) errors.push('reasoningSummary must be a non-empty string');

  if (errors.length) return fail(errors);

  const value = {
    conclusion: raw.conclusion,
    confidence: raw.confidence,
    reasoningSummary: raw.reasoningSummary,
  };
  STAGE1_GROUPS.forEach((g) => { value[g] = { bias: raw[g].bias, note: raw[g].note }; });
  STAGE1_LISTS.forEach((f) => { value[f] = raw[f]; });
  return { ok: true, value };
}

// ---- STAGE 2: final synthesis (see prompt.js buildSynthesisPrompt) ----
const STAGE2_LISTS = ['whereTheyAgree', 'whereTheyDisagree', 'contradictions', 'dataQualityLimitations', 'whatWouldChangeTheView'];

function validateSynthesis(raw) {
  if (!isPlainObject(raw)) return fail(['response is not a JSON object']);
  if (hasBannedKey(raw)) return fail(['response contains a function-call/code-like field']);

  const errors = [];
  if (!isEnum(raw.overallView, ['UP', 'DOWN', 'NO_VIEW'])) errors.push('overallView must be UP, DOWN or NO_VIEW');
  if (!isEnum(raw.confidence, ['LOW', 'MEDIUM', 'HIGH'])) errors.push('confidence must be LOW, MEDIUM or HIGH');
  if (!isBoundedString(raw.headline)) errors.push(`headline must be 1-${MAX_SHORT_STRING} characters`);
  if (!isBoundedString(raw.agreementSummary, { max: MAX_LONG_STRING })) errors.push('agreementSummary must be a non-empty string');
  if (!isBoundedString(raw.report, { max: MAX_LONG_STRING })) errors.push(`report must be 1-${MAX_LONG_STRING} characters`);
  STAGE2_LISTS.forEach((f) => {
    if (!isBoundedStringArray(raw[f])) errors.push(`${f} must be a list of at most ${MAX_LIST_ITEMS} short strings`);
  });

  if (errors.length) return fail(errors);

  const value = {
    overallView: raw.overallView,
    confidence: raw.confidence,
    headline: raw.headline,
    agreementSummary: raw.agreementSummary,
    report: raw.report,
  };
  STAGE2_LISTS.forEach((f) => { value[f] = raw[f]; });
  return { ok: true, value };
}

// ---- Extracting a JSON object out of raw model text ----
// The prompts ask for "ONLY a JSON object, no markdown fences", but models
// sometimes wrap the answer in ```json ... ``` anyway, or add stray text
// around it. This recovers the JSON object in that case instead of failing
// on cosmetic wrapping - it does not relax anything validateAIAnalysis/
// validateSynthesis check afterwards. Never throws.
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return { parsed: null, error: 'empty response text' };

  const attempts = [text.trim()];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) attempts.push(fenced[1].trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));

  let lastErr = 'no JSON object found in response';
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const parsed = JSON.parse(attempts[i]);
      if (isPlainObject(parsed)) return { parsed, error: null };
      lastErr = 'response was valid JSON but not an object';
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { parsed: null, error: lastErr };
}

module.exports = { extractJson, validateAIAnalysis, validateSynthesis };
