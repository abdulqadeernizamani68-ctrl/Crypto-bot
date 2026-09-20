// ---- Builds the AI-facing market context (both AI stages) ----
//
// STAGE 1 - buildIndependentContext(inputs)
//   Input is the RAW snapshot from binaryEngine.fetchSignalInputs(): candles,
//   the live quote and fetch bookkeeping. Output is what the INDEPENDENT AI
//   analyst is shown - raw OHLC(V) at three resolutions plus data-freshness
//   facts. Nothing produced by the deterministic bot is reachable from here:
//   this function never receives a bot signal, so it CANNOT leak the bot's
//   direction / probability / confidence / NO_TRADE reasoning / indicator
//   scores / S-R levels / regime label. (The previous design derived the AI's
//   input from the finished bot signal - which forced the AI to wait for the
//   bot and let it see the bot's readings. That is exactly what the unified
//   workflow removes: both stages now start from the same raw snapshot at the
//   same time.)
//
//   The one thing shared with the bot is candle CLEANING/validation
//   (dataQuality.validateCandleSeries) - that is data hygiene (drop corrupt
//   bars, report gaps/duplicates), not analysis, and the AI is told about the
//   issues so it can state its own limitations honestly.
//
// STAGE 2 - buildSynthesisContext({ inputs, bot, ai, comparison })
//   By the time this runs both analyses are finished, and the point of the
//   final stage is to compare them - so THIS context deliberately contains
//   the bot's full verdict, the AI's independent analysis, the deterministic
//   comparison, market facts computed from the raw data, and the merged
//   data-quality limitations.

const config = require('../../config');
const dataQualitySvc = require('../dataQuality');

const CANDLE_ROWS = { '1m': 60, '5m': 48, '15m': 56 };
const MIN_BARS_TO_INCLUDE = 4;

function iso(ms) {
  return new Date(ms).toISOString();
}

function isoMinute(ms) {
  return `${iso(ms).slice(0, 16)}Z`;
}

function roundPrice(n) {
  return Number.isFinite(n) ? Number(n.toPrecision(8)) : null;
}

function round(n, d = 4) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function horizonLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 1) return `${Math.round(minutes * 60)} sec`;
  if (minutes < 60) return `${Number(minutes.toFixed(2))} min`;
  const h = minutes / 60;
  return `${Number(h.toFixed(2))} h (${Number(minutes.toFixed(2))} min)`;
}

// Time-bucketed aggregation of 1-minute candles into `minutes`-minute bars.
// The oldest bar is dropped if the window started mid-bucket (it would
// under-report that bar's range); the newest bar may legitimately still be
// forming, and the prompt says so.
function resample(candles, minutes) {
  const bucketMs = minutes * 60000;
  const bars = [];
  let cur = null;
  for (const c of candles) {
    const bucketStart = Math.floor(c.time / bucketMs) * bucketMs;
    if (!cur || cur.time !== bucketStart) {
      if (cur) bars.push(cur);
      cur = { time: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, n: 1, firstTime: c.time };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      if (c.volume != null) cur.volume = (cur.volume == null ? 0 : cur.volume) + c.volume;
      cur.n += 1;
    }
  }
  if (cur) bars.push(cur);
  if (bars.length > 1 && bars[0].firstTime !== bars[0].time) bars.shift();
  return bars;
}

function toTable(bars, withVolume) {
  const columns = withVolume ? ['t', 'o', 'h', 'l', 'c', 'v'] : ['t', 'o', 'h', 'l', 'c'];
  const rows = bars.map((b) => {
    const row = [isoMinute(b.time), roundPrice(b.open), roundPrice(b.high), roundPrice(b.low), roundPrice(b.close)];
    if (withVolume) row.push(b.volume == null ? null : Math.round(b.volume));
    return row;
  });
  return { columns, rows };
}

function ageMinutes(lastCandle, nowMs) {
  return lastCandle ? Math.max(0, Math.round((nowMs - lastCandle.time) / 60000)) : null;
}

function buildIndependentContext(inputs, opts = {}) {
  const nowMs = opts.now != null ? opts.now : Date.now();
  const dq = dataQualitySvc.validateCandleSeries(inputs.candles);
  const candles = dq.cleaned;
  const last = candles[candles.length - 1] || null;
  const volumeAvailable = candles.some((c) => c.volume != null && c.volume > 0);

  const tables = {};
  tables['1m'] = toTable(candles.slice(-CANDLE_ROWS['1m']), volumeAvailable);
  [['5m', 5], ['15m', 15]].forEach(([label, minutes]) => {
    const bars = resample(candles, minutes).slice(-CANDLE_ROWS[label]);
    if (bars.length >= MIN_BARS_TO_INCLUDE) tables[label] = toTable(bars, volumeAvailable);
  });

  return {
    request: {
      symbol: inputs.symbol,
      horizonMinutes: inputs.duration,
      horizonLabel: horizonLabel(inputs.duration),
      requestedAtUtc: iso(nowMs),
      note: 'The horizon is how far ahead the UP/DOWN question looks. All data below is candle data (1-minute source candles and their 5m/15m aggregations), not a chart-timeframe request.',
    },
    referencePrice: { price: roundPrice(inputs.entryPrice), source: inputs.priceSource === 'live-quote' ? 'live quote' : 'last candle close' },
    dataQuality: {
      sourceCandleCount: candles.length,
      sourceIntervalMinutes: 1,
      firstCandleUtc: candles.length ? isoMinute(candles[0].time) : null,
      lastCandleUtc: last ? isoMinute(last.time) : null,
      lastCandleAgeMinutes: ageMinutes(last, nowMs),
      stale: !!(inputs.staleness && inputs.staleness.stale),
      volumeAvailable,
      issues: dq.issues || [],
    },
    candles: tables,
  };
}

// ---- Facts computed directly from the raw data (deterministic - the
// synthesizer should never be asked to do arithmetic on candles) ----
function pctChangeOver(candles, minutes) {
  const last = candles[candles.length - 1];
  const target = last.time - minutes * 60000;
  if (candles[0].time > target) return null; // window doesn't reach back that far
  let ref = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time <= target) { ref = candles[i]; break; }
  }
  if (!ref || !(ref.close > 0)) return null;
  return round(((last.close - ref.close) / ref.close) * 100, 3);
}

function summarizeMarket(inputs, opts = {}) {
  const nowMs = opts.now != null ? opts.now : Date.now();
  const dq = dataQualitySvc.validateCandleSeries(inputs.candles);
  const candles = dq.cleaned;
  const last = candles[candles.length - 1];
  const lastHour = candles.filter((c) => c.time > last.time - 60 * 60000);
  return {
    symbol: inputs.symbol,
    horizonMinutes: inputs.duration,
    horizonLabel: horizonLabel(inputs.duration),
    referencePrice: roundPrice(inputs.entryPrice),
    priceSource: inputs.priceSource === 'live-quote' ? 'live quote' : 'last candle close',
    lastCandleUtc: isoMinute(last.time),
    lastCandleAgeMinutes: ageMinutes(last, nowMs),
    stale: !!(inputs.staleness && inputs.staleness.stale),
    window: { candles: candles.length, fromUtc: isoMinute(candles[0].time), toUtc: isoMinute(last.time) },
    windowHigh: roundPrice(Math.max(...candles.map((c) => c.high))),
    windowLow: roundPrice(Math.min(...candles.map((c) => c.low))),
    lastHourHigh: lastHour.length ? roundPrice(Math.max(...lastHour.map((c) => c.high))) : null,
    lastHourLow: lastHour.length ? roundPrice(Math.min(...lastHour.map((c) => c.low))) : null,
    changePct: { '15m': pctChangeOver(candles, 15), '1h': pctChangeOver(candles, 60), '4h': pctChangeOver(candles, 240) },
    volumeAvailable: candles.some((c) => c.volume != null && c.volume > 0),
    dataQualityIssues: dq.issues || [],
  };
}

// ---- Bot analysis, as shown to the FINAL synthesizer only ----
function summarizeBot(bot) {
  if (!bot || bot.status !== 'OK' || !bot.signal) {
    return { status: (bot && bot.status) || 'UNAVAILABLE', reason: (bot && bot.reason) || 'deterministic analysis did not run' };
  }
  const s = bot.signal;
  const perf = bot.expiryPerf;
  return {
    status: 'OK',
    analyticsVersion: config.analyticsVersion,
    direction: s.direction, // UP | DOWN | NO_TRADE
    rawDirection: s.rawDirection,
    rawProbabilityPct: s.rawProbability,
    calibratedProbabilityPct: s.calibratedProbability,
    calibration: {
      sampleSize: s.calibrationSampleSize,
      lowConfidence: s.calibrationLowConfidence,
      recentWinRatePct: s.calibrationRecentWinRatePct,
      recentSampleSize: s.calibrationRecentSampleSize,
    },
    qualityLabel: s.qualityLabel,
    noTradeReasons: s.noTradeReasons || [],
    confluence: {
      groupScores: s.confluenceGroupScores,
      topFactors: (s.confluenceBreakdown || []).slice(0, 8).map((f) => ({ factor: f.factor, group: f.group, score: f.score })),
    },
    structure: s.structure,
    supportResistance: s.supportResistance,
    breakout: s.breakout,
    volatilityRegime: s.volatilityRegime,
    regime: s.regime ? { primary: s.regime.primary, volatility: s.regime.volatility, label: s.regime.label, reliable: s.regime.reliable, reasons: s.regime.reasons } : null,
    session: s.session,
    multiTimeframe: s.multiTimeframe,
    divergences: (s.divergences || []).slice(0, 4).map((d) => ({ type: d.type, direction: d.direction, kind: d.kind, strength: d.strength, confirmed: d.confirmed })),
    volume: s.volume,
    candleQuality: s.candleQuality,
    dataQualityIssues: s.dataQualityIssues || [],
    historicalPerformanceForHorizonBucket: perf
      ? { bucket: perf.label, completedTrades: perf.total, winRatePct: perf.winRatePct }
      : null,
  };
}

function summarizeAI(ai) {
  if (!ai || ai.status !== 'OK' || !ai.analysis) {
    return { status: (ai && ai.status) || 'UNAVAILABLE', reason: (ai && ai.reason) || 'independent AI analysis did not run' };
  }
  return { status: 'OK', analysis: ai.analysis };
}

// Merged, de-duplicated list of everything that limits how far the report
// can be trusted. Built in code (not by the LLM) so it can't be forgotten.
function collectLimitations({ inputs, bot, ai, skipAI = false, opts = {} }) {
  const out = [];
  const add = (x) => { if (x && !out.includes(x)) out.push(x); };
  const market = inputs ? summarizeMarket(inputs, opts) : null;

  if (market) {
    market.dataQualityIssues.forEach((i) => add(`Data: ${i}`));
    if (market.stale) add(`Market data looks stale (last candle ~${market.lastCandleAgeMinutes} min old) - the market may be closed; treat this as a historical read, not a live one.`);
    if (!market.volumeAvailable) add('No usable volume data for this instrument - volume-based evidence is unavailable.');
    add('Analyses are built from 1-minute candles; the requested horizon is a forward-looking window, not a higher-timeframe chart study.');
  }
  if (!bot || bot.status !== 'OK') add(`Bot analysis unavailable: ${(bot && bot.reason) || 'did not run'}`);
  else {
    if (bot.signal.calibrationLowConfidence) add(`Bot calibration is provisional (only ${bot.signal.calibrationSampleSize} closed trades in this bucket).`);
    if (!bot.expiryPerf) add('Historical performance for this horizon bucket could not be loaded.');
  }
  if (!skipAI) {
    if (!ai || ai.status !== 'OK') add(`Independent AI analysis unavailable: ${(ai && ai.reason) || 'did not run'}`);
    else (ai.analysis.limitations || []).forEach((l) => add(`AI-noted: ${l}`));
  }
  return out;
}

function buildSynthesisContext({ inputs, bot, ai, comparison }, opts = {}) {
  return {
    request: {
      symbol: inputs.symbol,
      horizonMinutes: inputs.duration,
      horizonLabel: horizonLabel(inputs.duration),
      requestedAtUtc: iso(opts.now != null ? opts.now : Date.now()),
      note: 'Both analyses were computed from 1-minute candles; the horizon is how far ahead the UP/DOWN question looks, not a chart-timeframe request.',
    },
    marketContext: summarizeMarket(inputs, opts),
    botAnalysis: summarizeBot(bot),
    independentAiAnalysis: summarizeAI(ai),
    comparison: {
      relationship: comparison.relationship,
      summary: comparison.summary,
      commonEvidence: comparison.commonEvidence,
      conflictingEvidence: comparison.conflictingEvidence,
      dataQualityDifferences: comparison.dataQualityDifferences,
    },
    dataQualityLimitations: collectLimitations({ inputs, bot, ai, opts }),
  };
}

module.exports = {
  buildIndependentContext,
  buildSynthesisContext,
  summarizeMarket,
  summarizeBot,
  collectLimitations,
  resample,
  horizonLabel,
};
