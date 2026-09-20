// ---- The prompt sent to the AI analyst ----
// Kept in its own file (not inlined in geminiProvider.js) so it's provider-
// agnostic - any future provider (see provider.js) reuses the exact same
// prompt-building logic, and a prompt change is one diff, not N.
//
// CRITICAL: the context object passed in must NOT include the
// deterministic bot's conclusion/direction/probability/quality-label/
// NO_TRADE reasoning - only the underlying feature READINGS (trend
// values, RSI, structure pattern, regime label, etc.), which is data, not
// a verdict. See services/ai/marketContext.js for exactly what gets
// stripped before this is called. This is what makes the AI's analysis
// independent rather than a rubber stamp of the bot's own conclusion.

function buildPrompt(context, language = 'en') {
  const languageInstruction = language === 'roman-urdu'
    ? 'Write reasoningSummary in Roman Urdu (Urdu written in Latin/English script, casual and clear). All other fields (bias values, enums) must stay in English exactly as specified.'
    : language === 'urdu'
      ? 'Write reasoningSummary in Urdu script. All other fields (bias values, enums) must stay in English exactly as specified.'
      : 'Write reasoningSummary in plain English.';

  return `You are an independent market analyst. You are given a STRUCTURED snapshot of technical readings for one instrument - NOT a conclusion, NOT a recommendation from any other system. Analyze it yourself and form your own independent view.

Rules:
- Base your analysis ONLY on the data given below. Do not invent, assume, or hallucinate any price, indicator value, or fact not present in this snapshot.
- If a field says unavailable or null, treat that data as genuinely unavailable - say so, do not guess a value for it.
- This is analysis/research only, not financial advice, and not an instruction to place any trade.
- Respond with ONLY a single JSON object, no markdown fences, no commentary outside the JSON, matching EXACTLY this shape:

{
  "conclusion": "UP" | "DOWN" | "NO_VIEW",
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "trend": { "bias": "BULLISH"|"BEARISH"|"NEUTRAL"|"UNCLEAR"|"UNAVAILABLE", "note": "short plain-text note" },
  "momentum": { "bias": "...", "note": "..." },
  "structure": { "bias": "...", "note": "..." },
  "volatility": { "bias": "...", "note": "..." },
  "volume": { "bias": "...", "note": "..." },
  "regime": { "bias": "...", "note": "..." },
  "mtf": { "bias": "...", "note": "..." },
  "keyEvidence": ["short bullet", "..."],
  "contradictions": ["short bullet describing any internal conflict you notice", "..."],
  "limitations": ["short bullet describing what you could NOT assess from this data", "..."],
  "reasoningSummary": "2-4 sentence plain-language explanation of your conclusion"
}

Use "NO_VIEW" for conclusion when the evidence is weak, conflicting, or insufficient - do not force a directional call. ${languageInstruction}

MARKET DATA SNAPSHOT (JSON):
${JSON.stringify(context, null, 2)}`;
}

module.exports = { buildPrompt };
