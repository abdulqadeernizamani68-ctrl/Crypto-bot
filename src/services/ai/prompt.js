// ---- The prompts sent to the AI ----
// Kept in their own file (not inlined in geminiProvider.js) so they're
// provider-agnostic - any future provider (see provider.js) reuses the exact
// same prompt-building logic, and a prompt change is one diff, not N.
//
// Two prompts, two different jobs:
//
//   buildPrompt(context, language)          - STAGE 1, the INDEPENDENT
//     analysis. `context` is built by marketContext.buildIndependentContext
//     from RAW candles only. It must never contain the deterministic bot's
//     conclusion, probability, confidence, direction, NO_TRADE reasoning or
//     any of its computed scores - the AI is meant to reach its own view
//     from the same raw data the bot started from, and it starts at the same
//     time as the bot rather than after it.
//
//   buildSynthesisPrompt(context, language) - STAGE 2, the FINAL SYNTHESIS.
//     By now both analyses exist and the whole point is to compare them, so
//     this prompt is DELIBERATELY given the bot's full output, the AI's
//     independent output, the deterministic comparison and the data-quality
//     limitations. (marketContext.buildSynthesisContext builds it.)

function languageInstructionFor(language, fieldsDescription) {
  if (language === 'roman-urdu') {
    return `Write ${fieldsDescription} in Roman Urdu (Urdu written in Latin/English script, casual and clear). All enum/bias fields must stay in English exactly as specified.`;
  }
  if (language === 'urdu') {
    return `Write ${fieldsDescription} in Urdu script. All enum/bias fields must stay in English exactly as specified.`;
  }
  return `Write ${fieldsDescription} in plain English.`;
}

function buildPrompt(context, language = 'en') {
  const languageInstruction = languageInstructionFor(language, 'reasoningSummary');
  const horizon = context && context.request ? context.request.horizonMinutes : null;

  return `You are an independent market analyst. You are given RAW market data for one instrument: OHLC candles (plus volume where the provider supplied it) at several resolutions, and a few facts about when the data was fetched. You are NOT given any indicator values, signals, probabilities or conclusions from any other system. Analyze the price action yourself and form your own independent view.

Look at whatever the data genuinely supports: trend, momentum, volatility, candle/price-action behaviour, market structure (swings, higher-highs/lower-lows), support/resistance, breakout/retest behaviour, volume (only if present), divergence you can genuinely identify, market regime, multi-timeframe alignment across the resolutions provided, and session/time-of-day context from the timestamps.

The question: over the next ${horizon != null ? `${horizon} minute(s)` : 'requested horizon'}, is price more likely to finish ABOVE ("UP") or BELOW ("DOWN") the reference price given in the data?

Rules:
- Base your analysis ONLY on the data given below. Do not invent, assume, or hallucinate any price, indicator value, level, news event or fact not present in the data.
- Do not state precise indicator values (e.g. an exact RSI or EMA number) unless you actually computed them from the candles given; prefer observations you can see directly in the candles.
- If the data says volume is unavailable or a field is null, treat that data as genuinely unavailable - say so and use bias "UNAVAILABLE", do not guess.
- If dataQuality.stale is true, the market data is not live (e.g. the market may be closed): say so in limitations and do not present the analysis as live.
- The last bar at each resolution may still be forming.
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

MARKET DATA (JSON):
${JSON.stringify(context)}`;
}

function buildSynthesisPrompt(context, language = 'en') {
  const languageInstruction = languageInstructionFor(language, 'headline, agreementSummary, report and every list item');

  return `You are the final research synthesizer of a market-analysis system. Two analyses of the same market data were produced independently and in parallel:
  1. "botAnalysis" - a deterministic, rules-based analytics engine (indicators, structure, support/resistance, breakout, volume, divergence, regime, multi-timeframe, session, data quality, historical calibration).
  2. "independentAiAnalysis" - a separate AI pass that saw ONLY the raw candles and never saw the bot's output.
You also receive "comparison" (a deterministic agreement/disagreement check between the two), "marketContext" (facts computed directly from the raw data) and "dataQualityLimitations".

Your job: compare the two analyses and write ONE clear research report for the reader. The reader will not see the two analyses separately, so carry over what matters from each.

Rules:
- Use ONLY facts and numbers present in the JSON below. Never invent prices, levels, indicator values, probabilities, statistics or news.
- If an analysis has a status other than "OK", say plainly that it was unavailable and why. Do not guess what it would have concluded; base the report only on the evidence that exists and state that limitation.
- Do not hide disagreement. If the analyses disagree, say exactly where and why, weigh the evidence on each side, or state that it cannot be resolved from this data.
- Carry through every data-quality limitation that matters (stale or gapped data, missing volume, thin calibration sample, market possibly closed, etc.).
- "overallView" is your synthesized research view for the requested horizon: "UP", "DOWN" or "NO_VIEW". Use "NO_VIEW" when the analyses conflict without a clearly stronger side, when the evidence or data is weak, or when only a NO_TRADE / NO_VIEW conclusion is supported.
- "confidence": "HIGH" only if both analyses agree on direction and the data is clean and fresh; "LOW" when they disagree or data is limited or stale.
- This is research only, not financial advice. Do NOT give entry, stop-loss, take-profit or position-size instructions and do NOT tell the reader to buy, sell or place a trade.
- Respond with ONLY a single JSON object, no markdown fences, no commentary outside the JSON, matching EXACTLY this shape:

{
  "overallView": "UP" | "DOWN" | "NO_VIEW",
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "headline": "one sentence stating the overall research conclusion",
  "agreementSummary": "1-3 sentences on how the bot analysis and the independent AI analysis relate",
  "whereTheyAgree": ["short bullet", "..."],
  "whereTheyDisagree": ["short bullet", "..."],
  "contradictions": ["short bullet describing an internal or cross-analysis contradiction", "..."],
  "dataQualityLimitations": ["short bullet", "..."],
  "whatWouldChangeTheView": ["short bullet describing an observable development that would weaken or reverse this view", "..."],
  "report": "4-8 sentence research narrative tying the evidence together"
}

Keep every list to at most 6 short items (empty list if nothing applies). ${languageInstruction} Enum fields (overallView, confidence) stay in English exactly as specified.

INPUT (JSON):
${JSON.stringify(context)}`;
}

module.exports = { buildPrompt, buildSynthesisPrompt };
