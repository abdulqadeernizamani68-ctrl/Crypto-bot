// Next-candle prediction for a specific timeframe. Reuses the same
// state-matching approach as historicalAnalysis.js (trend|RSI|volatility|
// color fingerprint, matched against past occurrences) but scoped to
// exactly one candle ahead, plus - for the candle that's currently still
// forming - blends in the ACTUAL partial move seen so far, since that's
// real evidence and not just a historical tendency.
//
// Honesty note: same as historicalAnalysis.js - this is descriptive
// pattern-frequency, not a guarantee. Small sample sizes are surfaced,
// not hidden.

const hist = require('./historicalAnalysis');
const binance = require('./binance');
const twelvedata = require('./twelvedata');

const TIMEFRAMES = {
  '1m': { binance: '1m', twelvedata: '1min', ms: 60 * 1000, label: '1 minute' },
  '5m': { binance: '5m', twelvedata: '5min', ms: 5 * 60 * 1000, label: '5 minute' },
  '15m': { binance: '15m', twelvedata: '15min', ms: 15 * 60 * 1000, label: '15 minute' },
  '30m': { binance: '30m', twelvedata: '30min', ms: 30 * 60 * 1000, label: '30 minute' },
  '1h': { binance: '1h', twelvedata: '1h', ms: 60 * 60 * 1000, label: '1 hour' },
  '4h': { binance: '4h', twelvedata: '4h', ms: 4 * 60 * 60 * 1000, label: '4 hour' },
  '1d': { binance: '1d', twelvedata: '1day', ms: 24 * 60 * 60 * 1000, label: 'Daily' },
};

function normalizeTimeframe(raw) {
  const key = (raw || '').trim().toLowerCase();
  return TIMEFRAMES[key] ? key : null;
}

// Tries Binance first (crypto), falls back to Twelve Data (forex/binary).
async function fetchCandles(symbolRaw, tfKey) {
  const tf = TIMEFRAMES[tfKey];
  const symbol = symbolRaw.toUpperCase();
  try {
    const raw = await binance.getSpotKlines(symbol, tf.binance, 500);
    if (raw && raw.length) {
      return {
        candles: raw.map((c) => ({ time: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close })),
        market: 'crypto (Binance)',
      };
    }
  } catch (err) {
    // fall through to Twelve Data
  }
  const candles = await twelvedata.getTimeSeries(symbol, tf.twelvedata, 500);
  return { candles, market: 'forex/binary (Twelve Data)' };
}

// Empirical next-candle stats: among all past candles in the same state as
// the last CLOSED candle, what did the candle right after them look like?
function nextCandleStats(closedCandles) {
  const states = hist.buildStateSeries(closedCandles);
  const lastIdx = closedCandles.length - 1;
  const currentState = states[lastIdx];
  if (!currentState) {
    throw new Error('Not enough closed candles yet to classify the current pattern state.');
  }

  const matches = [];
  for (let i = 0; i < lastIdx; i++) {
    if (states[i] === currentState) matches.push(i);
  }

  let green = 0;
  let red = 0;
  let bodySum = 0;
  for (const i of matches) {
    const nc = closedCandles[i + 1];
    if (nc.close >= nc.open) green++; else red++;
    bodySum += Math.abs(nc.close - nc.open) / nc.open;
  }
  const total = green + red;
  return {
    currentState,
    sampleSize: total,
    greenPct: total ? Number(((green / total) * 100).toFixed(1)) : null,
    redPct: total ? Number(((red / total) * 100).toFixed(1)) : null,
    avgBodyPct: total ? Number(((bodySum / total) * 100).toFixed(3)) : null,
  };
}

// Blends the historical green-probability with the ACTUAL partial move of
// the candle that's still forming right now - the further through its time
// window we are, the more weight the real partial move gets over the
// historical tendency.
function predictFormingCandle(formingCandle, intervalMs, historicalGreenPct) {
  const now = Date.now();
  const elapsedFraction = Math.max(0, Math.min(1, (now - formingCandle.time) / intervalMs));
  const partialIsGreen = formingCandle.close >= formingCandle.open ? 1 : 0;
  const historicalGreenProb = historicalGreenPct != null ? historicalGreenPct / 100 : 0.5;
  const blendedGreenProb = elapsedFraction * partialIsGreen + (1 - elapsedFraction) * historicalGreenProb;
  const partialMovePct = Number((((formingCandle.close - formingCandle.open) / formingCandle.open) * 100).toFixed(3));
  return {
    elapsedFraction: Number((elapsedFraction * 100).toFixed(0)),
    partialMovePct,
    likelyColor: blendedGreenProb >= 0.5 ? 'GREEN' : 'RED',
    confidencePct: Number((Math.max(blendedGreenProb, 1 - blendedGreenProb) * 100).toFixed(1)),
  };
}

// Simple one-line-per-candle text "structure" view (monospace table) -
// robust in a Discord code block regardless of message width, unlike a
// full vertical ASCII candlestick plot.
function renderStructure(candles, count = 15) {
  const shown = candles.slice(-count);
  const bodies = shown.map((c) => Math.abs(c.close - c.open));
  const maxBody = Math.max(...bodies, 1e-12);
  const barWidth = 10;
  const lines = shown.map((c, i) => {
    const isLast = i === shown.length - 1;
    const color = c.close >= c.open ? '🟩' : '🟥';
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    const filled = Math.max(1, Math.round((bodies[i] / maxBody) * barWidth));
    const bar = '▮'.repeat(filled) + '▯'.repeat(barWidth - filled);
    const time = new Date(c.time).toISOString().slice(5, 16).replace('T', ' ');
    const tag = isLast ? ' ⏳forming' : '';
    return `${time} ${color} ${bar} O:${c.open.toFixed(5)} H:${c.high.toFixed(5)} L:${c.low.toFixed(5)} C:${c.close.toFixed(5)} (${bodyPct.toFixed(3)}%)${tag}`;
  });
  return lines.join('\n');
}

module.exports = {
  TIMEFRAMES,
  normalizeTimeframe,
  fetchCandles,
  nextCandleStats,
  predictFormingCandle,
  renderStructure,
};
