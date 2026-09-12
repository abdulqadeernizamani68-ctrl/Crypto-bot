// All flags below are computed fresh from the candles/regime already fetched
// for this request - nothing stored or assumed in advance.

function detectFlashMove(candles15m, atrValue) {
  if (!candles15m || candles15m.length < 5 || !atrValue) return null;
  const last = candles15m[candles15m.length - 1];
  const body = Math.abs(last.close - last.open);
  // A single 15m candle moving >4x the recent average true range is well
  // outside normal behaviour for that timeframe.
  if (body > atrValue * 4) {
    return {
      type: 'FLASH_MOVE',
      severity: body > atrValue * 6 ? 'EXTREME' : 'HIGH',
      note: `Single 15m candle moved ${body.toFixed(6)} vs typical ATR ${atrValue.toFixed(6)} (${(body / atrValue).toFixed(1)}x)`,
    };
  }
  return null;
}

function detectExtremeVolatility(regime) {
  if (regime?.volatility === 'HIGH_VOLATILITY' && regime.atrPercentile >= 0.9) {
    return {
      type: 'EXTREME_VOLATILITY',
      severity: 'HIGH',
      note: `ATR at ${(regime.atrPercentile * 100).toFixed(0)}th percentile of its own recent history`,
    };
  }
  return null;
}

// A long wick candle that fully reverses (closes near the open after a big
// wick in one direction) on unusually high volume is a common footprint of
// a stop-hunt / manipulation-style move, not necessarily proof of one.
function detectPossibleManipulation(candles15m) {
  if (!candles15m || candles15m.length < 21) return null;
  const last = candles15m[candles15m.length - 1];
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  if (range === 0) return null;
  const wickRatio = 1 - body / range;

  const recentVolumes = candles15m.slice(-21, -1).map((c) => c.volume);
  const avgVol = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

  if (wickRatio > 0.7 && last.volume > avgVol * 2) {
    return {
      type: 'POSSIBLE_MANIPULATION',
      severity: 'MEDIUM',
      note: `Large wick (${(wickRatio * 100).toFixed(0)}% of range) on ${(last.volume / avgVol).toFixed(1)}x average volume - stop-hunt style footprint`,
    };
  }
  return null;
}

function detectAnomalies({ candles15m, atrValue, regime }) {
  const flags = [detectFlashMove(candles15m, atrValue), detectExtremeVolatility(regime), detectPossibleManipulation(candles15m)]
    .filter(Boolean);
  return { anomalyDetected: flags.length > 0, flags };
}

module.exports = { detectAnomalies };
