const structureSvc = require('./structure');
const config = require('../config');
const store = require('./redisStore');

// Finds the next major structural level beyond the normal (tight) stop loss,
// using the highest timeframe we already have candles for (4h) so this adds
// zero extra Binance calls. This is the level where the trade's underlying
// thesis is considered structurally broken, not just "stopped out on noise".
function computeExtendedLevel(direction, entry, stopLoss, candles4h) {
  if (!candles4h || candles4h.length < 30) return null;
  const levels = structureSvc.findKeyLevels(candles4h, 0.3); // wider tolerance = bigger, more major levels
  const { support, resistance } = structureSvc.nearestLevels(entry, levels);

  if (direction === 'BUY') {
    // Need a support level beyond (below) the normal SL to call it "extended".
    if (support && support.price < stopLoss) return support.price;
    // fall back to a fixed multiple of the SL distance if no clean level exists
    return entry - Math.abs(entry - stopLoss) * 2;
  }
  if (resistance && resistance.price > stopLoss) return resistance.price;
  return entry + Math.abs(entry - stopLoss) * 2;
}

// Reads (never writes) the real historical recovery odds per checkpoint for
// this pair+direction. Any checkpoint short on samples is reported as such
// rather than shown with a number - see config.invalidation.minSamples.
async function getRecoveryOdds(pair, direction) {
  const results = await Promise.all(
    config.invalidation.checkpoints.map(async (cp) => {
      const stats = await store.getInvalidationStats(pair, direction, cp.label);
      const probabilityPct = stats.total > 0 ? Number(((stats.recovered / stats.total) * 100).toFixed(1)) : 0;
      return {
        label: cp.label,
        minutes: cp.minutes,
        samples: stats.total,
        minSamples: config.invalidation.minSamples,
        probabilityPct,
      };
    })
  );
  return results;
}

async function buildExtendedInvalidation({ direction, entry, stopLoss, candles4h, pair }) {
  const level = computeExtendedLevel(direction, entry, stopLoss, candles4h);
  if (level == null) return null;
  const checkpoints = await getRecoveryOdds(pair, direction);
  return { level: Number(level.toFixed(6)), referencePrice: entry, checkpoints };
}

module.exports = { computeExtendedLevel, getRecoveryOdds, buildExtendedInvalidation };
