const indicators = require('./indicators');
const structureSvc = require('./structure');
const trapSvc = require('./trapDetection');

function clamp(v, min = -1, max = 1) {
  return Math.max(min, Math.min(max, v));
}

// ---- 1 & 2. Multi-timeframe trend (EMA 20/50/100/200 stack across TFs) ----
// timeframeCandles: { '1m': [...], '5m': [...], '15m': [...], '1h': [...], '4h': [...] }
function scoreTrend(timeframeCandles) {
  const tfWeights = { '1m': 0.5, '5m': 0.8, '15m': 1.2, '1h': 1.5, '4h': 1.5 };
  let weightedTotal = 0;
  let weightSum = 0;
  const perTf = {};

  for (const [tf, candles] of Object.entries(timeframeCandles)) {
    if (!candles || candles.length < 210) continue;
    const price = candles[candles.length - 1].close;
    const ema20 = indicators.ema(candles, 20);
    const ema50 = indicators.ema(candles, 50);
    const ema100 = indicators.ema(candles, 100);
    const ema200 = indicators.ema(candles, 200);
    if ([ema20, ema50, ema100, ema200].some((v) => v === null)) continue;

    // Score = how many of the 4 stacking conditions align bullish/bearish.
    let s = 0;
    if (price > ema20) s += 0.25; else s -= 0.25;
    if (ema20 > ema50) s += 0.25; else s -= 0.25;
    if (ema50 > ema100) s += 0.25; else s -= 0.25;
    if (ema100 > ema200) s += 0.25; else s -= 0.25;

    perTf[tf] = { score: Number(s.toFixed(2)), price, ema20, ema50, ema100, ema200 };
    const w = tfWeights[tf] ?? 1;
    weightedTotal += s * w;
    weightSum += w;
  }

  const score = weightSum > 0 ? clamp(weightedTotal / weightSum) : 0;
  return { score, perTf };
}

// ---- 3. Momentum: RSI + MACD on 15m & 1h ----
function scoreMomentum(timeframeCandles) {
  const relevant = ['15m', '1h'];
  let total = 0;
  let count = 0;
  const detail = {};

  for (const tf of relevant) {
    const candles = timeframeCandles[tf];
    if (!candles || candles.length < 40) continue;
    const rsiVal = indicators.rsi(candles, 14);
    const macdVal = indicators.macd(candles);
    if (rsiVal === null || !macdVal) continue;

    let s = 0;
    // RSI: above 55 bullish lean, below 45 bearish lean, extreme zones flagged
    if (rsiVal >= 55) s += 0.5;
    else if (rsiVal <= 45) s -= 0.5;
    if (rsiVal >= 70) s -= 0.15; // overbought caution
    if (rsiVal <= 30) s += 0.15; // oversold caution (bounce potential)

    // MACD: histogram sign + line vs signal
    if (macdVal.MACD !== undefined && macdVal.signal !== undefined) {
      if (macdVal.MACD > macdVal.signal) s += 0.5; else s -= 0.5;
    }

    detail[tf] = { rsi: rsiVal, macd: macdVal, score: Number(clamp(s).toFixed(2)) };
    total += clamp(s);
    count += 1;
  }

  return { score: count > 0 ? clamp(total / count) : 0, detail };
}

// ---- 4. Volatility (ATR) - contextual gating signal, not directional ----
function scoreVolatility(candles15m, regime) {
  const atr = indicators.atr(candles15m, 14);
  if (!atr) return { score: 0, atr: null };
  // Extreme, unconfirmed high volatility slightly reduces confidence rather
  // than pushing direction - represented as a small penalty toward 0.
  let score = 0;
  if (regime.volatility === 'HIGH_VOLATILITY') score = -0.15;
  if (regime.volatility === 'LOW_VOLATILITY') score = -0.05; // low vol = weak follow-through risk
  return { score, atr, atrPercentile: regime.atrPercentile };
}

// ---- 5. Volume (spot & futures vs recent average) ----
function scoreVolume(spotCandles15m, futuresCandles15m) {
  function volumeSignal(candles) {
    if (!candles || candles.length < 21) return null;
    const recent = candles.slice(-21, -1); // prior 20 candles (exclude current)
    const avgVol = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
    const last = candles[candles.length - 1];
    const priceDir = last.close >= last.open ? 1 : -1;
    const ratio = avgVol > 0 ? last.volume / avgVol : 1;
    // Above-average volume amplifies the direction of the current candle;
    // below-average volume dampens conviction toward 0.
    const strength = clamp((ratio - 1) * 0.6);
    return { score: clamp(strength * priceDir), ratio: Number(ratio.toFixed(2)) };
  }

  const spot = volumeSignal(spotCandles15m);
  const futures = volumeSignal(futuresCandles15m);
  const scores = [spot, futures].filter(Boolean);
  const score = scores.length ? clamp(scores.reduce((a, s) => a + s.score, 0) / scores.length) : 0;
  return { score, spot, futures };
}

// ---- 6. Market structure (HH/HL vs LH/LL) ----
function scoreStructure(candles1h) {
  const result = structureSvc.classifyStructure(candles1h);
  return { score: clamp(result.score), pattern: result.pattern };
}

// ---- 7. Support & Resistance proximity ----
function scoreSupportResistance(candles1h, currentPrice) {
  const levels = structureSvc.findKeyLevels(candles1h);
  const { support, resistance } = structureSvc.nearestLevels(currentPrice, levels);
  let score = 0;
  const distToSupportPct = support ? ((currentPrice - support.price) / currentPrice) * 100 : null;
  const distToResistancePct = resistance ? ((resistance.price - currentPrice) / currentPrice) * 100 : null;

  // Price hugging support (within ~0.4%) = bullish bounce zone.
  // Price hugging resistance (within ~0.4%) = bearish rejection zone.
  if (distToSupportPct !== null && distToSupportPct >= 0 && distToSupportPct < 0.4) {
    score += 0.5 * Math.min(1, support.touches / 3);
  }
  if (distToResistancePct !== null && distToResistancePct >= 0 && distToResistancePct < 0.4) {
    score -= 0.5 * Math.min(1, resistance.touches / 3);
  }

  return { score: clamp(score), support, resistance, levels: levels.slice(0, 6) };
}

// ---- 8. Breakout & retest ----
function scoreBreakoutRetest(candles1h) {
  const levels = structureSvc.findKeyLevels(candles1h);
  const result = structureSvc.detectBreakoutRetest(candles1h, levels);
  return { score: clamp(result.score), detail: result };
}

// ---- 9 & 10. Liquidity (broad depth) + Order Book (near-price pressure) ----
function scoreLiquidityAndOrderBook(orderBook) {
  if (!orderBook || !orderBook.bids || !orderBook.asks) {
    return { liquidity: { score: 0 }, orderbook: { score: 0 } };
  }
  const bids = orderBook.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
  const asks = orderBook.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

  const totalBidVol = bids.reduce((a, b) => a + b.qty, 0);
  const totalAskVol = asks.reduce((a, b) => a + b.qty, 0);
  const liquidityImbalance = totalBidVol + totalAskVol > 0
    ? (totalBidVol - totalAskVol) / (totalBidVol + totalAskVol)
    : 0;

  const nearBids = bids.slice(0, 10).reduce((a, b) => a + b.qty, 0);
  const nearAsks = asks.slice(0, 10).reduce((a, b) => a + b.qty, 0);
  const nearImbalance = nearBids + nearAsks > 0
    ? (nearBids - nearAsks) / (nearBids + nearAsks)
    : 0;

  return {
    liquidity: { score: clamp(liquidityImbalance), totalBidVol, totalAskVol },
    orderbook: { score: clamp(nearImbalance), nearBids, nearAsks },
  };
}

// ---- 11. Open Interest ----
function scoreOpenInterest(oiData, priceTrendScore) {
  if (!oiData || !oiData.history || oiData.history.length < 2) return { score: 0 };
  const first = parseFloat(oiData.history[0].sumOpenInterest);
  const last = parseFloat(oiData.history[oiData.history.length - 1].sumOpenInterest);
  if (!first) return { score: 0 };
  const oiChangePct = ((last - first) / first) * 100;

  // Rising OI + rising price = fresh longs confirming the move (bullish).
  // Rising OI + falling price = fresh shorts confirming the move (bearish).
  // Falling OI = positions closing, i.e. weaker conviction either way.
  let score = 0;
  if (oiChangePct > 1) score = priceTrendScore >= 0 ? 0.6 : -0.6;
  else if (oiChangePct < -1) score = -0.2 * Math.sign(priceTrendScore || 1);

  return { score: clamp(score), oiChangePct: Number(oiChangePct.toFixed(2)) };
}

// ---- 12. Funding rate (contrarian tilt at extremes) ----
function scoreFunding(fundingData) {
  if (!fundingData) return { score: 0 };
  const rate = fundingData.lastFundingRate * 100; // to %
  let score = 0;
  if (rate > 0.03) score = -0.4; // crowded longs, paying high funding -> squeeze risk
  else if (rate < -0.03) score = 0.4; // crowded shorts -> squeeze risk upward
  return { score: clamp(score), fundingRatePct: Number(rate.toFixed(4)) };
}

// ---- 13. Market trap risk (bull/bear trap, fake breakout/breakdown,
// liquidity grab, stop hunt, false retest) - live pattern detection, not
// hardcoded to any pair or period. A trap found opposing the live direction
// pulls the combined score toward NEUTRAL/NO TRADE rather than amplifying it.
function scoreTrapRisk(candles1h, breakoutRetestDetail, orderBook) {
  const result = trapSvc.detectTraps({ candles1h, breakoutRetestDetail, orderBook });
  return { score: clamp(result.score), findings: result.findings };
}

module.exports = {
  scoreTrend,
  scoreMomentum,
  scoreVolatility,
  scoreVolume,
  scoreStructure,
  scoreSupportResistance,
  scoreBreakoutRetest,
  scoreLiquidityAndOrderBook,
  scoreOpenInterest,
  scoreFunding,
  scoreTrapRisk,
};
