const { ADX, ATR, EMA } = require('technicalindicators');

// Determines the current market regime purely from the candle data supplied -
// no hardcoded coin/date assumptions. Regime is recomputed on every request.
function detectRegime(candles1h) {
  const high = candles1h.map((c) => c.high);
  const low = candles1h.map((c) => c.low);
  const close = candles1h.map((c) => c.close);

  const adxSeries = ADX.calculate({ period: 14, high, low, close });
  const atrSeries = ATR.calculate({ period: 14, high, low, close });

  if (!adxSeries.length || !atrSeries.length) {
    return { trend: 'UNKNOWN', volatility: 'UNKNOWN', adx: null, atrPercentile: null };
  }

  const lastADX = adxSeries[adxSeries.length - 1].adx;
  const trend = lastADX >= 25 ? 'TRENDING' : 'RANGING';

  // Directional label (Bull/Bear/Sideways) - additive, doesn't change any
  // existing weight logic that keys off `trend` (TRENDING/RANGING).
  const ema50Series = EMA.calculate({ period: 50, values: close });
  const lastClose = close[close.length - 1];
  const lastEma50 = ema50Series.length ? ema50Series[ema50Series.length - 1] : null;
  let directionalTrend = 'SIDEWAYS';
  if (trend === 'TRENDING' && lastEma50 != null) {
    directionalTrend = lastClose > lastEma50 ? 'BULL_TREND' : 'BEAR_TREND';
  }

  // ATR percentile relative to its own recent history (adaptive, not a fixed
  // absolute threshold, so it works across coins with very different prices).
  const atrValues = atrSeries.map((a) => a);
  const lastATR = atrValues[atrValues.length - 1];
  const sorted = [...atrValues].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= lastATR);
  const atrPercentile = rank / sorted.length;
  const volatility = atrPercentile >= 0.7 ? 'HIGH_VOLATILITY' : atrPercentile <= 0.3 ? 'LOW_VOLATILITY' : 'NORMAL_VOLATILITY';

  return { trend, directionalTrend, volatility, adx: lastADX, atrPercentile };
}

// Regime-specific category weight multipliers. These bias the scoring engine
// toward the confirmations that matter most in each regime, rather than
// treating every market condition the same way.
function getRegimeWeights(regime) {
  const base = {
    trend: 1.0,
    momentum: 1.0,
    volume: 1.0,
    structure: 1.0,
    supportResistance: 1.0,
    breakoutRetest: 1.0,
    liquidity: 1.0,
    orderbook: 1.0,
    openInterest: 1.0,
    funding: 1.0,
    trapRisk: 1.0,
  };

  if (regime.trend === 'TRENDING') {
    return { ...base, trend: 1.4, structure: 1.3, momentum: 1.1, supportResistance: 0.7 };
  }
  if (regime.trend === 'RANGING') {
    return { ...base, trend: 0.6, supportResistance: 1.4, breakoutRetest: 0.6, momentum: 1.2 };
  }
  return base;
}

module.exports = { detectRegime, getRegimeWeights };
