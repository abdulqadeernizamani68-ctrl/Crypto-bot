// ---- Research database for market-analysis requests ----
// Every completed !market request gets one record here - this is
// deliberately separate from binaryStore.js (which tracks actual binary
// TRADE signals through to WIN/LOSS) because a market-analysis request is
// a research/explanation event, not a trade being opened. Same underlying
// mechanism (Redis via redisStore.js), same "list of ids + hash per id"
// pattern as binaryStore, kept as its own namespace so the two don't mix.
//
// Fields recorded (per the logging requirement): symbol, data timestamp,
// request timestamp, a version tag for the market-data snapshot (the
// signal's own signalTime, which IS the data snapshot's identity),
// analytics engine version, AI provider/model, bot output (the full
// signal), AI output (status + analysis + usage + latency), comparison
// result, final formatted response mode, data-quality status, horizon,
// regime, session, and errors if any.

const store = require('./redisStore');
const config = require('../config');

const LIST_KEY = 'market:analysislog:ids';
const MAX_LOGGED = 2000; // cap the list so it doesn't grow forever; oldest entries fall off

function recordKey(id) {
  return `market:analysislog:${id}`;
}

function newId(symbol) {
  return `mkt_${symbol}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function logAnalysis({ signal, aiResult, comparison, language, mode, requestTimestamp }) {
  const id = newId(signal.symbol);
  const record = {
    id,
    symbol: signal.symbol,
    requestTimestamp,
    dataTimestamp: signal.signalTime,
    analyticsVersion: config.analyticsVersion,
    aiProvider: config.ai.provider,
    aiModel: config.ai.provider === 'gemini' ? config.ai.gemini.model : null,
    language,
    mode,
    horizonMinutes: signal.durationMinutes,
    expiryBucket: signal.expiryBucket.key,
    regime: signal.regime.label,
    session: signal.session.session,
    dataQualityIssues: signal.dataQualityIssues || [],
    botOutput: {
      direction: signal.direction,
      rawProbability: signal.rawProbability,
      calibratedProbability: signal.calibratedProbability,
      qualityLabel: signal.qualityLabel,
      noTradeReasons: signal.noTradeReasons,
    },
    aiOutput: {
      status: aiResult.status,
      reason: aiResult.reason || null,
      analysis: aiResult.analysis,
      usage: aiResult.usage,
      latencyMs: aiResult.latencyMs,
    },
    comparison: comparison ? { relationship: comparison.relationship, summary: comparison.summary } : null,
    loggedAt: Date.now(),
  };

  await store.redis.set(recordKey(id), JSON.stringify(record));
  await store.redis.zadd(LIST_KEY, { score: record.loggedAt, member: id });

  // Trim: keep only the most recent MAX_LOGGED ids. Best-effort - a
  // failure here should never break the logging call itself.
  try {
    const allIds = await store.redis.zrange(LIST_KEY, 0, -1);
    if (allIds.length > MAX_LOGGED) {
      const excess = allIds.length - MAX_LOGGED;
      const toDrop = allIds.slice(0, excess); // zrange ascending by score = oldest first
      for (const oldId of toDrop) {
        // eslint-disable-next-line no-await-in-loop
        await store.redis.srem?.(LIST_KEY, oldId); // no-op guard if srem unavailable on a zset
      }
    }
  } catch (_) {
    // trimming is best-effort housekeeping, never fatal
  }

  return id;
}

async function getRecentAnalyses(limit = 10) {
  const ids = await store.redis.zrange(LIST_KEY, -limit, -1, { rev: false });
  if (!ids || !ids.length) return [];
  const records = await Promise.all(ids.map(async (id) => {
    const raw = await store.redis.get(recordKey(id));
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  }));
  return records.filter(Boolean).reverse();
}

module.exports = { logAnalysis, getRecentAnalyses };
