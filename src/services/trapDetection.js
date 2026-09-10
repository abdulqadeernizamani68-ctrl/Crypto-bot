// Live market-trap detection - entirely derived from the candles/order book
// passed in for the current request/pair. No hardcoded coin, level, or date
// assumptions; nothing here is "if pair === X" - it all operates on generic
// price-action, volume, and order-book shape.

const structureSvc = require('./structure');

function clamp(v, min = -1, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function wickRatio(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return { upper: 0, lower: 0, body: 0 };
  const body = Math.abs(candle.close - candle.open);
  const upper = candle.high - Math.max(candle.close, candle.open);
  const lower = Math.min(candle.close, candle.open) - candle.low;
  return { upper: upper / range, lower: lower / range, body: body / range };
}

function avgVolume(candles) {
  if (!candles.length) return 0;
  return candles.reduce((a, c) => a + c.volume, 0) / candles.length;
}

// Bull/Bear trap: price closed beyond a key level, then the very next candle
// closes back on the original side - especially when the breakout candle had
// a long opposing wick or volume faded rather than confirmed the move.
function detectBreakoutTrap(candles1h, levels) {
  if (candles1h.length < 6) return null;
  const last = candles1h[candles1h.length - 1];
  const prev = candles1h[candles1h.length - 2];
  const recentAvgVol = avgVolume(candles1h.slice(-11, -1));

  for (const level of levels) {
    if (level.type === 'resistance' && prev.close > level.price && last.close < level.price) {
      const w = wickRatio(prev);
      const volFaded = recentAvgVol > 0 && last.volume < recentAvgVol;
      if (w.upper > 0.4 || volFaded) {
        return {
          type: 'BULL_TRAP', level: level.price, score: -0.6,
          note: 'Breakout above resistance reversed back below within a candle or two',
        };
      }
    }
    if (level.type === 'support' && prev.close < level.price && last.close > level.price) {
      const w = wickRatio(prev);
      const volFaded = recentAvgVol > 0 && last.volume < recentAvgVol;
      if (w.lower > 0.4 || volFaded) {
        return {
          type: 'BEAR_TRAP', level: level.price, score: 0.6,
          note: 'Breakdown below support reversed back above within a candle or two',
        };
      }
    }
  }
  return null;
}

// Stop hunt / liquidity grab: a wick sweeps through a key level on above-
// average volume but the candle closes back on the original side - reads as
// resting stops/liquidity being taken rather than a genuine break.
function detectLiquidityGrab(candles1h, levels) {
  if (candles1h.length < 3) return null;
  const last = candles1h[candles1h.length - 1];
  const recentAvgVol = avgVolume(candles1h.slice(-11, -1));
  const volSpike = recentAvgVol > 0 && last.volume > recentAvgVol * 1.6;

  for (const level of levels) {
    if (level.type === 'resistance' && last.high > level.price && last.close < level.price) {
      const w = wickRatio(last);
      if (w.upper > 0.5 && volSpike) {
        return {
          type: 'STOP_HUNT_LIQUIDITY_GRAB', direction: 'BEARISH', level: level.price, score: -0.5,
          note: 'Wick swept liquidity above resistance on a volume spike, then rejected',
        };
      }
    }
    if (level.type === 'support' && last.low < level.price && last.close > level.price) {
      const w = wickRatio(last);
      if (w.lower > 0.5 && volSpike) {
        return {
          type: 'STOP_HUNT_LIQUIDITY_GRAB', direction: 'BULLISH', level: level.price, score: 0.5,
          note: 'Wick swept liquidity below support on a volume spike, then reclaimed',
        };
      }
    }
  }
  return null;
}

// False retest: the breakout/retest module already found a retest of a
// broken level - flag it here if the most recent candle failed to hold that
// retest (closed back through the level), since that invalidates the
// otherwise-bullish/bearish reading from that module.
function detectFalseRetest(breakoutRetestDetail, candles1h) {
  if (!breakoutRetestDetail || breakoutRetestDetail.type === 'NONE' || !breakoutRetestDetail.retested) return null;
  const last = candles1h[candles1h.length - 1];
  if (breakoutRetestDetail.type === 'BULLISH_BREAKOUT_RETEST' && last.close < breakoutRetestDetail.level) {
    return {
      type: 'FALSE_RETEST', direction: 'BEARISH', level: breakoutRetestDetail.level, score: -0.4,
      note: 'Retest of broken resistance failed to hold, price closed back below it',
    };
  }
  if (breakoutRetestDetail.type === 'BEARISH_BREAKDOWN_RETEST' && last.close > breakoutRetestDetail.level) {
    return {
      type: 'FALSE_RETEST', direction: 'BULLISH', level: breakoutRetestDetail.level, score: 0.4,
      note: 'Retest of broken support failed to hold, price closed back above it',
    };
  }
  return null;
}

// Thin/one-sided book at the touch: flagged as a caution only (not scored
// directionally) since a single depth snapshot can't confirm spoofing.
function detectThinBookCaution(orderBook) {
  if (!orderBook || !orderBook.bids?.length || !orderBook.asks?.length) return null;
  const topBid = parseFloat(orderBook.bids[0][1]);
  const topAsk = parseFloat(orderBook.asks[0][1]);
  const sampleBids = orderBook.bids.slice(1, 11);
  const sampleAsks = orderBook.asks.slice(1, 11);
  const avgBid = sampleBids.length ? sampleBids.reduce((a, [, q]) => a + parseFloat(q), 0) / sampleBids.length : 0;
  const avgAsk = sampleAsks.length ? sampleAsks.reduce((a, [, q]) => a + parseFloat(q), 0) / sampleAsks.length : 0;
  if (avgBid > 0 && topBid > avgBid * 4) {
    return { type: 'THIN_BOOK_CAUTION', side: 'BID', note: 'Unusually large single bid at touch vs nearby depth - possible spoof/liquidity grab setup' };
  }
  if (avgAsk > 0 && topAsk > avgAsk * 4) {
    return { type: 'THIN_BOOK_CAUTION', side: 'ASK', note: 'Unusually large single ask at touch vs nearby depth - possible spoof/liquidity grab setup' };
  }
  return null;
}

function detectTraps({ candles1h, breakoutRetestDetail, orderBook }) {
  const levels = structureSvc.findKeyLevels(candles1h);
  const findings = [
    detectBreakoutTrap(candles1h, levels),
    detectLiquidityGrab(candles1h, levels),
    detectFalseRetest(breakoutRetestDetail, candles1h),
    detectThinBookCaution(orderBook),
  ].filter(Boolean);

  const directionalScores = findings.filter((f) => typeof f.score === 'number').map((f) => f.score);
  const score = directionalScores.length
    ? clamp(directionalScores.reduce((a, b) => a + b, 0) / directionalScores.length)
    : 0;

  return { score, findings };
}

module.exports = { detectTraps };
