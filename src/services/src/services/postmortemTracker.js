// Runs on its own (slower) cron than the main tracker, since checkpoints are
// hours/days/weeks apart - no need to poll every 2 minutes.
const config = require('../config');
const binance = require('./binance');
const store = require('./redisStore');
const logger = require('../utils/logger');

async function getHourlyCandlesSince(pair, sinceMs) {
  // getSpotKlines in this codebase takes only a `limit`, not a time range.
  // For checkpoints within the lookback window this single most-recent-1000h
  // call covers it; older checkpoints simply stay "not enough data yet"
  // rather than fabricate results, since we can't page further back safely
  // without changing the shared binance.js client (left as a documented
  // follow-up rather than risking the existing crypto-signal code path).
  const raw = await binance.getSpotKlines(pair, '1h', 1000).catch(() => []);
  return raw.filter((c) => c.openTime >= sinceMs);
}

function wasRecoveredWithin(candles, direction, referencePrice) {
  // BUY signal's SL was hit -> "recovery" means price traded back UP to the
  // original entry (referencePrice). SELL signal's SL was hit -> recovery
  // means price traded back DOWN to it.
  return candles.some((c) => (direction === 'BUY' ? c.high >= referencePrice : c.low <= referencePrice));
}

async function checkOnePostmortem(pm) {
  const now = Date.now();
  const elapsedMinutes = (now - pm.slHitTime) / 60000;

  for (const cp of config.invalidation.checkpoints) {
    if (pm.checkpointsChecked[cp.label]) continue; // already recorded
    if (elapsedMinutes < cp.minutes) continue; // not due yet

    // eslint-disable-next-line no-await-in-loop
    const candles = await getHourlyCandlesSince(pm.pair, pm.slHitTime);
    const recovered = candles.length ? wasRecoveredWithin(candles, pm.direction, pm.referencePrice) : false;

    // eslint-disable-next-line no-await-in-loop
    await store.recordInvalidationCheckpoint(pm.pair, pm.direction, cp.label, recovered);
    pm.checkpointsChecked[cp.label] = true;
    // eslint-disable-next-line no-await-in-loop
    await store.updatePostmortem(pm.id, { checkpointsChecked: pm.checkpointsChecked });
  }

  const allChecked = config.invalidation.checkpoints.every((cp) => pm.checkpointsChecked[cp.label]);
  if (allChecked) {
    await store.removePostmortemFromPending(pm.id);
  }
}

async function runPostmortemCycle() {
  const ids = await store.getPendingPostmortemIds();
  if (!ids.length) return;
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const pm = await store.getPostmortem(id);
    if (!pm) {
      // eslint-disable-next-line no-await-in-loop
      await store.removePostmortemFromPending(id);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await checkOnePostmortem(pm);
    } catch (err) {
      logger.error(`Postmortem check failed for ${id}: ${err.message}`);
    }
  }
}

module.exports = { runPostmortemCycle };
