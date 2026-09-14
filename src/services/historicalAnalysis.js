// Empirical (history-matching) analysis - deliberately separate from
// binaryEngine's statistical (log-normal random-walk) model. Instead of
// assuming a distribution, this looks at what the market actually did
// historically whenever it was in a similar state to right now, and
// reports the measured (empirical) outcome frequencies.
//
// Honesty note: past patterns repeating is not guaranteed - this is
// descriptive statistics on historical data, not a prediction guarantee.
// Small sample sizes (n) are flagged as such rather than hidden.

const axios = require('axios');
const twelvedata = require('./twelvedata');

const binanceHttp = axios.create({ baseURL: 'https://api.binance.com', timeout: 15000 });

// ---- Data fetching --------------------------------------------------------

// Binance klines are paginated 1000-at-a-time and go back to the symbol's
// listing date, so this walks backward in time until it has maxCandles or
// runs out of history.
async function fetchBinanceHistory(symbol, interval = '1h', maxCandles = 5000) {
  const limit = 1000;
  let candles = [];
  let endTime;
  while (candles.length < maxCandles) {
    const params = { symbol: symbol.toUpperCase(), interval, limit };
    if (endTime) params.endTime = endTime;
    const { data } = await binanceHttp.get('/api/v3/klines', { params });
    if (!Array.isArray(data) || data.length === 0) break;
    const batch = data.map((k) => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
    candles = batch.concat(candles);
    if (data.length < limit) break; // hit the start of available history
    endTime = data[0][0] - 1;
  }
  return candles.slice(-maxCandles);
}

// Twelve Data's free plan caps outputsize (and how far back intraday data
// goes) - this pulls whatever it will give in one call and works with
// that. May end up with fewer than maxCandles on the free plan.
async function fetchTwelveDataHistory(symbol, interval = '1h', maxCandles = 5000) {
  return twelvedata.getTimeSeries(symbol, interval, maxCandles);
}

// ---- Rolling indicator series (vectorized, single pass) -------------------

function emaSeries(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let ema = closes[0];
  out[0] = ema;
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function atrSeries(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - candles[i - 1].close),
      Math.abs(c.low - candles[i - 1].close)
    );
  });
  const out = new Array(candles.length).fill(null);
  if (trs.length < period) return out;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

function median(arr) {
  const clean = arr.filter((v) => v != null).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

// ---- State classification --------------------------------------------------

// One "state" per candle: trend (EMA9 vs EMA21) + RSI zone + volatility
// zone (vs the series' own median ATR) + candle color. This is the
// "similar market moment" fingerprint used for matching.
function buildStateSeries(candles) {
  const closes = candles.map((c) => c.close);
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const rsi14 = rsiSeries(closes, 14);
  const atr14 = atrSeries(candles, 14);
  const atrMedian = median(atr14);

  return candles.map((c, i) => {
    if (ema9[i] == null || ema21[i] == null || rsi14[i] == null || atr14[i] == null) return null;
    const trend = ema9[i] > ema21[i] ? 'UP' : 'DOWN';
    const rsiBucket = rsi14[i] >= 70 ? 'OB' : rsi14[i] <= 30 ? 'OS' : 'MID';
    const volBucket = atrMedian ? (atr14[i] >= atrMedian ? 'HIVOL' : 'LOVOL') : 'MID';
    const color = c.close >= c.open ? 'GREEN' : 'RED';
    return `${trend}|${rsiBucket}|${volBucket}|${color}`;
  });
}

// ---- Empirical forward-outcome stats ---------------------------------------

// checkpointCandleCounts: e.g. [1,2,4,8,12,24,48,96] (candles ahead - hours,
// if interval is '1h').
function analyzeHistory(candles, checkpointCandleCounts) {
  const states = buildStateSeries(candles);
  const currentIdx = candles.length - 1;
  const currentState = states[currentIdx];
  if (!currentState) {
    throw new Error('Not enough data yet to classify the current market state.');
  }

  // Overall unconditional candle stats - simple descriptive counts over
  // everything fetched, not filtered by current state.
  let greenCount = 0;
  let redCount = 0;
  let bodySum = 0;
  for (const c of candles) {
    if (c.close >= c.open) greenCount++; else redCount++;
    bodySum += Math.abs(c.close - c.open) / c.open;
  }
  const overall = {
    totalCandles: candles.length,
    greenPct: Number(((greenCount / candles.length) * 100).toFixed(1)),
    redPct: Number(((redCount / candles.length) * 100).toFixed(1)),
    avgBodyPct: Number(((bodySum / candles.length) * 100).toFixed(3)),
  };

  // Every past index in the same state as right now (excluding the most
  // recent chunk, which doesn't have enough forward data to check yet).
  const maxLookAhead = Math.max(...checkpointCandleCounts);
  const matchIdxs = [];
  for (let i = 0; i < currentIdx - maxLookAhead; i++) {
    if (states[i] === currentState) matchIdxs.push(i);
  }

  const checkpoints = checkpointCandleCounts.map((n) => {
    let above = 0;
    let below = 0;
    for (const i of matchIdxs) {
      const base = candles[i].close;
      const future = candles[i + n].close;
      if (future >= base) above++; else below++;
    }
    const total = above + below;
    const abovePct = total ? Number(((above / total) * 100).toFixed(1)) : null;
    const belowPct = total ? Number(((below / total) * 100).toFixed(1)) : null;
    return { candlesAhead: n, sampleSize: total, abovePct, belowPct };
  });

  return { currentState, overall, sampleSize: matchIdxs.length, checkpoints };
}

// Picks the checkpoint with the strongest historical edge, requiring a
// minimum sample size to trust it. Falls back to the largest available
// sample if nothing meets the minimum (flagged by the caller via n).
function recommendCheckpoint(checkpoints, minSample = 30) {
  const eligible = checkpoints.filter((c) => c.sampleSize >= minSample);
  const pool = eligible.length ? eligible : checkpoints.filter((c) => c.sampleSize > 0);
  let best = null;
  for (const c of pool) {
    const edge = Math.max(c.abovePct, c.belowPct);
    if (!best || edge > Math.max(best.abovePct, best.belowPct)) best = c;
  }
  return best;
}

module.exports = {
  fetchBinanceHistory,
  fetchTwelveDataHistory,
  buildStateSeries,
  analyzeHistory,
  recommendCheckpoint,
};
