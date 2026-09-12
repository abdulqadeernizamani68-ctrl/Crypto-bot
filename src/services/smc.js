const { findSwings } = require('./structure');

function clamp(v, min = -1, max = 1) {
  return Math.max(min, Math.min(max, v));
}

// ---- Break of Structure (continuation) / Change of Character (reversal) ----
// BOS: price breaks the most recent swing high in an uptrend (or swing low in
// a downtrend) - confirms the existing trend continuing.
// CHoCH: price breaks a swing point AGAINST the prevailing structure - first
// sign of a potential reversal.
function detectBosChoch(candles) {
  const { swingHighs, swingLows } = findSwings(candles, 3);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { type: 'NONE', score: 0 };
  }
  const lastHigh = swingHighs[swingHighs.length - 1];
  const lastLow = swingLows[swingLows.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const prevLow = swingLows[swingLows.length - 2];
  const current = candles[candles.length - 1];

  const priorTrendBullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
  const priorTrendBearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

  // Break of the most recent swing high/low by a closing price (not just a wick).
  const brokeAboveLastHigh = current.close > lastHigh.price;
  const brokeBelowLastLow = current.close < lastLow.price;

  if (priorTrendBullish && brokeAboveLastHigh) return { type: 'BOS_BULLISH', score: 0.7 };
  if (priorTrendBearish && brokeBelowLastLow) return { type: 'BOS_BEARISH', score: -0.7 };
  if (priorTrendBearish && brokeAboveLastHigh) return { type: 'CHOCH_BULLISH_REVERSAL', score: 0.9 };
  if (priorTrendBullish && brokeBelowLastLow) return { type: 'CHOCH_BEARISH_REVERSAL', score: -0.9 };
  return { type: 'NONE', score: 0 };
}

// ---- Equal Highs / Equal Lows (liquidity pools resting just beyond them) ----
function detectEqualHighsLows(candles, tolerancePct = 0.1) {
  const { swingHighs, swingLows } = findSwings(candles, 2);
  const equalHighs = [];
  const equalLows = [];

  for (let i = 0; i < swingHighs.length - 1; i++) {
    for (let j = i + 1; j < swingHighs.length; j++) {
      const diffPct = (Math.abs(swingHighs[i].price - swingHighs[j].price) / swingHighs[i].price) * 100;
      if (diffPct < tolerancePct) equalHighs.push([swingHighs[i], swingHighs[j]]);
    }
  }
  for (let i = 0; i < swingLows.length - 1; i++) {
    for (let j = i + 1; j < swingLows.length; j++) {
      const diffPct = (Math.abs(swingLows[i].price - swingLows[j].price) / swingLows[i].price) * 100;
      if (diffPct < tolerancePct) equalLows.push([swingLows[i], swingLows[j]]);
    }
  }
  return { equalHighs, equalLows };
}

// ---- Liquidity sweep: wick clears an equal-high/low liquidity pool then
// closes back inside - classic stop-hunt before reversal. ----
function detectLiquiditySweep(candles, eqHL) {
  const last = candles[candles.length - 1];
  for (const pair of eqHL.equalHighs) {
    const level = Math.max(pair[0].price, pair[1].price);
    if (last.high > level && last.close < level) {
      return { type: 'LIQUIDITY_SWEEP_HIGH', score: -0.7, level };
    }
  }
  for (const pair of eqHL.equalLows) {
    const level = Math.min(pair[0].price, pair[1].price);
    if (last.low < level && last.close > level) {
      return { type: 'LIQUIDITY_SWEEP_LOW', score: 0.7, level };
    }
  }
  return { type: 'NONE', score: 0 };
}

// ---- Fair Value Gap: 3-candle imbalance where candle 2 leaves a gap between
// candle 1 and candle 3 that price hasn't traded back into yet. ----
function detectFVG(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  const gaps = [];
  for (let i = 2; i < recent.length; i++) {
    const c1 = recent[i - 2];
    const c3 = recent[i];
    if (c3.low > c1.high) {
      gaps.push({ type: 'BULLISH_FVG', top: c3.low, bottom: c1.high, index: i });
    } else if (c3.high < c1.low) {
      gaps.push({ type: 'BEARISH_FVG', top: c1.low, bottom: c3.high, index: i });
    }
  }
  const currentPrice = candles[candles.length - 1].close;
  // Keep only gaps price hasn't fully closed back through yet.
  const unfilled = gaps.filter((g) => (g.type === 'BULLISH_FVG' ? currentPrice > g.bottom : currentPrice < g.top));
  return unfilled.slice(-3);
}

// ---- Order Blocks: last opposite-direction candle before a strong
// directional move (the origin of "smart money" positioning). ----
function detectOrderBlocks(candles, lookback = 30, strongMoveMultiplier = 2) {
  const recent = candles.slice(-lookback);
  const avgBody = mean(recent.map((c) => Math.abs(c.close - c.open)));
  const blocks = [];

  for (let i = 1; i < recent.length; i++) {
    const move = recent[i];
    const prev = recent[i - 1];
    const moveBody = Math.abs(move.close - move.open);
    if (moveBody < avgBody * strongMoveMultiplier) continue;

    if (move.close > move.open && prev.close < prev.open) {
      blocks.push({ type: 'BULLISH_OB', high: prev.high, low: prev.low, index: i });
    } else if (move.close < move.open && prev.close > prev.open) {
      blocks.push({ type: 'BEARISH_OB', high: prev.high, low: prev.low, index: i });
    }
  }
  return blocks.slice(-3);
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// ---- Premium / Discount zone relative to the most recent significant
// swing range - the core "buy discount, sell premium" SMC principle. ----
function premiumDiscountZone(candles) {
  const { swingHighs, swingLows } = findSwings(candles, 3);
  if (!swingHighs.length || !swingLows.length) return { zone: 'UNKNOWN', score: 0 };

  const rangeHigh = Math.max(...swingHighs.slice(-5).map((s) => s.price));
  const rangeLow = Math.min(...swingLows.slice(-5).map((s) => s.price));
  const price = candles[candles.length - 1].close;
  if (rangeHigh === rangeLow) return { zone: 'UNKNOWN', score: 0 };

  const position = (price - rangeLow) / (rangeHigh - rangeLow); // 0..1
  let zone;
  let score;
  if (position < 0.3) { zone = 'DEEP_DISCOUNT'; score = 0.6; }
  else if (position < 0.45) { zone = 'DISCOUNT'; score = 0.3; }
  else if (position <= 0.55) { zone = 'EQUILIBRIUM'; score = 0; }
  else if (position <= 0.7) { zone = 'PREMIUM'; score = -0.3; }
  else { zone = 'DEEP_PREMIUM'; score = -0.6; }

  return { zone, score, position: Number(position.toFixed(2)), rangeHigh, rangeLow };
}

// ---- Combined SMC score, -1..1, for use as one category alongside the rest. ----
function scoreSMC(candles) {
  if (!candles || candles.length < 40) return { score: 0, findings: [] };

  const bosChoch = detectBosChoch(candles);
  const eqHL = detectEqualHighsLows(candles);
  const sweep = detectLiquiditySweep(candles, eqHL);
  const fvgs = detectFVG(candles);
  const obs = detectOrderBlocks(candles);
  const pdZone = premiumDiscountZone(candles);

  const findings = [];
  if (bosChoch.type !== 'NONE') findings.push({ type: bosChoch.type, note: `Structure: ${bosChoch.type}` });
  if (sweep.type !== 'NONE') findings.push({ type: sweep.type, note: `Liquidity swept at ${sweep.level}` });
  fvgs.forEach((g) => findings.push({ type: g.type, note: `Unfilled FVG ${g.bottom}-${g.top}` }));
  obs.forEach((o) => findings.push({ type: o.type, note: `${o.type} zone ${o.low}-${o.high}` }));
  findings.push({ type: pdZone.zone, note: `Price in ${pdZone.zone} zone of recent range` });

  // Weighted combination: BOS/CHoCH is the strongest structural signal,
  // liquidity sweep next, premium/discount is a milder bias.
  const score = clamp(bosChoch.score * 0.5 + sweep.score * 0.3 + pdZone.score * 0.2);

  return { score, bosChoch, sweep, fvgs, orderBlocks: obs, premiumDiscount: pdZone, findings };
}

module.exports = {
  detectBosChoch,
  detectEqualHighsLows,
  detectLiquiditySweep,
  detectFVG,
  detectOrderBlocks,
  premiumDiscountZone,
  scoreSMC,
};
