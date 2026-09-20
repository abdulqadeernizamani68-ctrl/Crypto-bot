// ---- Builds the AI-facing market context ----
// Takes the FULL signal object already produced by
// binaryEngine.generateBinarySignal() (the same one the deterministic bot
// analysis displays) and returns a stripped-down version for the AI
// prompt. Reusing the already-fetched/already-computed signal means the
// AI call costs zero extra market-data API calls (section U: "reuse
// market data when possible").
//
// EXCLUDED ON PURPOSE (this is the actual enforcement of section J's "AI
// must not see the bot's conclusion"):
//   direction, rawDirection, calibratedProbability, rawProbability,
//   calibrationSampleSize/LowConfidence/RecentWinRatePct, qualityLabel,
//   highTrust, noTradeReasons, tilt
// These are the bot's own VERDICT (a directional call + a confidence
// number + why it did or didn't trade) - genuinely independent analysis
// requires the AI not see them before forming its own view.
//
// INCLUDED: the underlying READINGS the bot's own confluence is built
// from (indicator values/group scores, structure pattern, S/R levels,
// breakout facts, volume state, candle quality, divergences, regime,
// session, MTF higher-timeframe tilt+agreement, data-quality notes). This
// is genuinely descriptive market data, not a conclusion - it's exactly
// the category of input section J asks the AI to examine (trend,
// momentum, structure, price action, S/R, volume, volatility, MTF,
// regime, contradictions, data limitations).

function round(n, d = 4) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function buildAIMarketContext(signal) {
  return {
    symbol: signal.symbol,
    entryPrice: signal.entryPrice,
    expiry: { minutes: signal.durationMinutes, bucket: signal.expiryBucket.label },
    dataQuality: {
      issues: signal.dataQualityIssues || [],
    },
    trendAndMomentumReadings: {
      // Group-level confluence scores (not the bot's final tilt/verdict) -
      // each is a descriptive read of one category of indicator, e.g.
      // TREND: +0.5 means "EMA stack + MACD currently lean bullish",
      // not "the bot recommends buying".
      groupScores: signal.confluenceGroupScores,
      individualFactors: (signal.confluenceBreakdown || []).map((f) => ({ factor: f.factor, group: f.group, score: f.score })),
    },
    structure: {
      pattern: signal.structure.pattern,
      supportResistance: signal.supportResistance,
      breakout: signal.breakout,
    },
    volatility: {
      regime: signal.volatilityRegime.regime,
      percentile: signal.volatilityRegime.percentile,
      measuredVolPerMinute: round(signal.volPerMin, 6),
    },
    volume: signal.volume,
    candleQuality: signal.candleQuality,
    divergences: signal.divergences,
    regime: { primary: signal.regime.primary, volatility: signal.regime.volatility, reasons: signal.regime.reasons },
    session: signal.session,
    multiTimeframe: signal.multiTimeframe, // { label, tilt, agreement } of the higher-timeframe read, or null
    // Descriptive only - NOT the bot's decision: whether these known
    // measured drift/vol numbers even indicate a coin-flip environment.
    measuredDriftPerMinute: round(signal.driftPerMin, 6),
  };
}

module.exports = { buildAIMarketContext };
