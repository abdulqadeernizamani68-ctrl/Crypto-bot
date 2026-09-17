// Swing-point based market structure analysis.
// No fixed coin/date assumptions - works purely off the candle array passed in.

function findSwings(candles, lookback = 3) {
  const swingHighs = [];
  const swingLows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const windowSlice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    const isHigh = windowSlice.every((w) => w.high <= c.high);
    const isLow = windowSlice.every((w) => w.low >= c.low);
    if (isHigh) swingHighs.push({ index: i, price: c.high, time: c.time ?? c.openTime });
    if (isLow) swingLows.push({ index: i, price: c.low, time: c.time ?? c.openTime });
  }
  return { swingHighs, swingLows };
}

// Returns: 'HH_HL' (uptrend structure), 'LH_LL' (downtrend structure), 'MIXED'
function classifyStructure(candles) {
  const { swingHighs, swingLows } = findSwings(candles);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { pattern: 'INSUFFICIENT_DATA', score: 0, swingHighs, swingLows };
  }
  const lastHighs = swingHighs.slice(-2);
  const lastLows = swingLows.slice(-2);
  const higherHigh = lastHighs[1].price > lastHighs[0].price;
  const higherLow = lastLows[1].price > lastLows[0].price;
  const lowerHigh = lastHighs[1].price < lastHighs[0].price;
  const lowerLow = lastLows[1].price < lastLows[0].price;

  let pattern = 'MIXED';
  let score = 0;
  if (higherHigh && higherLow) {
    pattern = 'HH_HL';
    score = 1;
  } else if (lowerHigh && lowerLow) {
    pattern = 'LH_LL';
    score = -1;
  } else if (higherHigh || higherLow) {
    pattern = 'MIXED_BULLISH_LEAN';
    score = 0.3;
  } else if (lowerHigh || lowerLow) {
    pattern = 'MIXED_BEARISH_LEAN';
    score = -0.3;
  }
  return { pattern, score, swingHighs, swingLows };
}

// Cluster swing points into support/resistance levels using proximity grouping.
function findKeyLevels(candles, tolerancePct = 0.15) {
  const { swingHighs, swingLows } = findSwings(candles);
  const allPoints = [
    ...swingHighs.map((p) => ({ ...p, type: 'resistance' })),
    ...swingLows.map((p) => ({ ...p, type: 'support' })),
  ];

  const levels = [];
  for (const point of allPoints) {
    const existing = levels.find(
      (lvl) => Math.abs(lvl.price - point.price) / point.price * 100 < tolerancePct * 10
    );
    if (existing) {
      existing.touches += 1;
      existing.price = (existing.price * (existing.touches - 1) + point.price) / existing.touches;
    } else {
      levels.push({ price: point.price, type: point.type, touches: 1 });
    }
  }
  return levels.sort((a, b) => b.touches - a.touches);
}

function nearestLevels(currentPrice, levels) {
  const support = levels
    .filter((l) => l.price < currentPrice)
    .sort((a, b) => b.price - a.price)[0];
  const resistance = levels
    .filter((l) => l.price > currentPrice)
    .sort((a, b) => a.price - b.price)[0];
  return { support, resistance };
}

// Detect a recent breakout of a key level followed by a retest (price returned
// close to the broken level within a few candles).
function detectBreakoutRetest(candles, levels, lookback = 15) {
  const recent = candles.slice(-lookback);
  const currentPrice = candles[candles.length - 1].close;

  for (const level of levels) {
    const breakoutCandle = recent.find((c, idx) => {
      if (idx === 0) return false;
      const prev = recent[idx - 1];
      if (level.type === 'resistance') {
        return prev.close <= level.price && c.close > level.price;
      }
      return prev.close >= level.price && c.close < level.price;
    });
    if (!breakoutCandle) continue;

    const breakoutIdx = recent.indexOf(breakoutCandle);
    const afterBreakout = recent.slice(breakoutIdx + 1);
    const retested = afterBreakout.some(
      (c) => Math.abs(c.low - level.price) / level.price < 0.002 ||
             Math.abs(c.high - level.price) / level.price < 0.002
    );

    if (level.type === 'resistance' && currentPrice > level.price) {
      return {
        type: 'BULLISH_BREAKOUT_RETEST',
        level: level.price,
        retested,
        score: retested ? 1 : 0.5,
      };
    }
    if (level.type === 'support' && currentPrice < level.price) {
      return {
        type: 'BEARISH_BREAKDOWN_RETEST',
        level: level.price,
        retested,
        score: retested ? -1 : -0.5,
      };
    }
  }
  return { type: 'NONE', score: 0 };
}

module.exports = { findSwings, classifyStructure, findKeyLevels, nearestLevels, detectBreakoutRetest };
