// ---- AI analysis response schema + validator ----
// A hand-rolled validator, not a library (ajv etc. isn't in package.json
// and this environment has no network to add one) - but it's a REAL
// schema check, not a shrug: every field is type- and range-checked, and
// an AI response that fails validation is never passed through to the
// user or the comparison engine. Section S ("validate all external AI
// responses before using them", "do not execute arbitrary code/function
// calls returned by AI") is enforced here, in one place, rather than
// trusted ad hoc at each call site.

const VALID_CONCLUSIONS = ['UP', 'DOWN', 'NO_VIEW'];
const VALID_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'];
const VALID_VIEW_BIAS = ['BULLISH', 'BEARISH', 'NEUTRAL', 'UNCLEAR', 'UNAVAILABLE'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isStringArray(v, maxLen = 12) {
  return Array.isArray(v) && v.length <= maxLen && v.every((x) => typeof x === 'string');
}

// A "view" is the small shape used for trend/momentum/structure/
// volatility/volume/regime/mtf below - a bias plus a short plain-text note.
function validateView(view, path, errors) {
  if (view == null || typeof view !== 'object') {
    errors.push(`${path}: missing or not an object`);
    return;
  }
  if (!VALID_VIEW_BIAS.includes(view.bias)) {
    errors.push(`${path}.bias: must be one of ${VALID_VIEW_BIAS.join('/')}, got ${JSON.stringify(view.bias)}`);
  }
  if (view.note != null && typeof view.note !== 'string') {
    errors.push(`${path}.note: must be a string if present`);
  }
  if (view.note && view.note.length > 400) {
    errors.push(`${path}.note: too long (${view.note.length} chars, max 400) - reject rather than truncate silently`);
  }
}

// Validates a parsed (already JSON.parse'd) AI analysis object. Returns
// { ok: true, value } or { ok: false, errors: [...] } - never throws.
function validateAIAnalysis(obj) {
  const errors = [];
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['response is not a JSON object'] };
  }

  if (!VALID_CONCLUSIONS.includes(obj.conclusion)) {
    errors.push(`conclusion: must be one of ${VALID_CONCLUSIONS.join('/')}, got ${JSON.stringify(obj.conclusion)}`);
  }
  if (!VALID_CONFIDENCE.includes(obj.confidence)) {
    errors.push(`confidence: must be one of ${VALID_CONFIDENCE.join('/')}, got ${JSON.stringify(obj.confidence)}`);
  }

  ['trend', 'momentum', 'structure', 'volatility', 'volume', 'regime', 'mtf'].forEach((key) => {
    validateView(obj[key], key, errors);
  });

  if (!isStringArray(obj.keyEvidence, 10)) errors.push('keyEvidence: must be an array of <=10 strings');
  if (!isStringArray(obj.contradictions, 10)) errors.push('contradictions: must be an array of <=10 strings');
  if (!isStringArray(obj.limitations, 10)) errors.push('limitations: must be an array of <=10 strings');

  if (!isNonEmptyString(obj.reasoningSummary)) {
    errors.push('reasoningSummary: must be a non-empty string');
  } else if (obj.reasoningSummary.length > 1500) {
    errors.push(`reasoningSummary: too long (${obj.reasoningSummary.length} chars, max 1500)`);
  }

  // Explicitly reject anything that looks like an attempt to get executed
  // rather than displayed - AI output is data, never code (section S).
  const dangerousKeys = ['function_call', 'functionCall', 'tool_use', 'toolUse', 'code', 'script', 'exec'];
  for (const k of dangerousKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      errors.push(`response contains a disallowed field "${k}" - AI output is never treated as executable`);
    }
  }

  if (errors.length) return { ok: false, errors };

  // Build a clean, whitelisted output object - anything the model added
  // beyond the schema is simply dropped, not carried forward.
  const clean = {
    conclusion: obj.conclusion,
    confidence: obj.confidence,
    trend: { bias: obj.trend.bias, note: obj.trend.note || '' },
    momentum: { bias: obj.momentum.bias, note: obj.momentum.note || '' },
    structure: { bias: obj.structure.bias, note: obj.structure.note || '' },
    volatility: { bias: obj.volatility.bias, note: obj.volatility.note || '' },
    volume: { bias: obj.volume.bias, note: obj.volume.note || '' },
    regime: { bias: obj.regime.bias, note: obj.regime.note || '' },
    mtf: { bias: obj.mtf.bias, note: obj.mtf.note || '' },
    keyEvidence: obj.keyEvidence,
    contradictions: obj.contradictions,
    limitations: obj.limitations,
    reasoningSummary: obj.reasoningSummary,
  };

  return { ok: true, value: clean };
}

module.exports = { validateAIAnalysis, VALID_CONCLUSIONS, VALID_CONFIDENCE, VALID_VIEW_BIAS };

// Pulls a JSON object out of a raw model response - handles the common
// case of the model wrapping it in a ```json ... ``` fence despite being
// asked not to, and otherwise takes the response as-is. Returns
// { parsed, error } - never throws.
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { parsed: null, error: 'empty response text' };
  }
  let candidate = text.trim();
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidate = fenceMatch[1].trim();
  try {
    return { parsed: JSON.parse(candidate), error: null };
  } catch (err) {
    return { parsed: null, error: `JSON parse failed: ${err.message}` };
  }
}

module.exports.extractJson = extractJson;
