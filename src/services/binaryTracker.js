const twelvedata = require('./twelvedata');
const binaryStore = require('./binaryStore');
const calibrationSvc = require('./calibration');
const expiryBucketsSvc = require('./expiryBuckets');
const logger = require('../utils/logger');

function pctDiff(a, b) {
  return Number((((a - b) / b) * 100).toFixed(4));
}

function findPriceNear(candles, targetTime) {
  if (!candles.length) return null;
  let best = candles[0];
  let bestDiff = Math.abs(candles[0].time - targetTime);
  for (const c of candles) {
    const diff = Math.abs(c.time - targetTime);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best;
}

async function checkOpenBinary(signal) {
  try {
    const now = Date.now();
    const elapsedMinutes = (now - signal.signalTime) / 60000;
    const outputsize = Math.min(500, Math.ceil(elapsedMinutes) + 10);
    const candles = await twelvedata.getTimeSeries(signal.symbol, '1min', outputsize);
    const relevant = candles.filter((c) => c.time >= signal.signalTime);
    if (!relevant.length) return;

    // Track the running extreme against the predicted final direction, for
    // the "price got close to flipping but didn't" narrative.
    let worstAgainstEntry = signal.worstAgainstEntry ?? signal.entryPrice;
    let worstAgainstTime = signal.worstAgainstTime ?? null;
    relevant.forEach((c) => {
      if (signal.direction === 'UP') {
        if (c.low < worstAgainstEntry) {
          worstAgainstEntry = c.low;
          worstAgainstTime = c.time;
        }
      } else if (c.high > worstAgainstEntry) {
        worstAgainstEntry = c.high;
        worstAgainstTime = c.time;
      }
    });

    const resolvedCheckpoints = { ...(signal.resolvedCheckpoints || {}) };
    let changed = false;

    for (const cp of signal.checkpoints) {
      if (resolvedCheckpoints[cp.fraction]) continue;
      if (elapsedMinutes < cp.minutes) continue;

      const targetTime = signal.signalTime + cp.minutes * 60000;
      const priceAt = findPriceNear(relevant, targetTime);
      if (!priceAt) continue;

      const actualDirection = priceAt.close >= signal.entryPrice ? 'UP' : 'DOWN';
      const correct = actualDirection === cp.direction;
      // eslint-disable-next-line no-await-in-loop
      await binaryStore.recordCheckpointOutcome(cp.fraction, correct);
      resolvedCheckpoints[cp.fraction] = { correct, priceAt: priceAt.close, actualDirection };
      changed = true;
    }

    const finalCp = signal.checkpoints[signal.checkpoints.length - 1];
    const expired = elapsedMinutes >= finalCp.minutes && resolvedCheckpoints[finalCp.fraction];

    if (expired) {
      const finalOutcome = resolvedCheckpoints[finalCp.fraction];
      const wentAgainstThenRecovered =
        (signal.direction === 'UP' && worstAgainstEntry < signal.entryPrice && finalOutcome.correct) ||
        (signal.direction === 'DOWN' && worstAgainstEntry > signal.entryPrice && finalOutcome.correct);

      let nearMissNote = null;
      if (wentAgainstThenRecovered && worstAgainstTime) {
        const secondsIn = Math.round((worstAgainstTime - signal.signalTime) / 1000);
        const movePct = pctDiff(worstAgainstEntry, signal.entryPrice);
        nearMissNote =
          `Trade ke ${secondsIn} second baad price ${worstAgainstEntry} tak chali gayi thi ` +
          `(entry se ${movePct}%) - agar us waqt expiry hoti to loss hota, lekin final expiry tak ` +
          `price wapas ${signal.direction === 'UP' ? 'upar' : 'neeche'} aa gayi.`;
      }

      await binaryStore.close(signal.id, {
        status: 'CLOSED',
        result: finalOutcome.correct ? 'WIN' : 'LOSS',
        closePrice: finalOutcome.priceAt,
        closedAt: now,
        worstAgainstEntry,
        worstAgainstTime,
        nearMissNote,
        resolvedCheckpoints,
      });

      // ---- Feed the real outcome back into calibration + performance
      // tracking. This is what turns "raw model probability" into
      // something that gets checked against reality over time, and what
      // powers the per-expiry / per-regime accuracy reporting. Every
      // closed trade updates exactly one calibration bucket (its own
      // expiry bucket x its own raw-probability bin) - never mixed with
      // other expiries or other probability ranges.
      try {
        const expiryBucketKey = signal.expiryBucket?.key
          || expiryBucketsSvc.getExpiryBucket(signal.durationMinutes).key;
        const regimeLabel = signal.regime?.label;
        const correct = finalOutcome.correct;
        if (Number.isFinite(signal.rawProbability)) {
          await calibrationSvc.recordCalibrationOutcome(expiryBucketKey, signal.rawProbability, correct);
        }
        await calibrationSvc.recordExpiryPerf(expiryBucketKey, correct);
        if (regimeLabel) {
          await calibrationSvc.recordRegimePerf(regimeLabel, correct);
          await calibrationSvc.recordExpiryRegimePerf(expiryBucketKey, regimeLabel, correct);
        }
        if (signal.session?.session) {
          await calibrationSvc.recordSessionPerf(signal.session.session, correct);
        }
        // Feature-importance tracking (#16): each known boolean feature
        // flag gets its OWN outcome key ("<flag>:true" / "<flag>:false"),
        // so getAllFeaturePerf() can later show real win rate WITH vs.
        // WITHOUT each feature - e.g. was a volume-confirmed breakout
        // actually better than an unconfirmed one, in this bot's own
        // history, not by theoretical assumption.
        if (signal.featureFlags) {
          for (const [flag, value] of Object.entries(signal.featureFlags)) {
            if (typeof value === 'boolean') {
              // eslint-disable-next-line no-await-in-loop
              await calibrationSvc.recordFeatureOutcome(`${flag}:${value}`, correct);
            }
          }
        }
      } catch (calibErr) {
        // Never let calibration bookkeeping failures block closing the
        // trade itself - the WIN/LOSS record above is the source of
        // truth; calibration just re-derives from it.
        logger.error(`Calibration update failed for ${signal.id}: ${calibErr.message}`);
      }

      logger.info(`Binary signal ${signal.id} closed: ${finalOutcome.correct ? 'WIN' : 'LOSS'}`);
      return;
    }

    if (changed || worstAgainstEntry !== signal.worstAgainstEntry) {
      await binaryStore.update(signal.id, { resolvedCheckpoints, worstAgainstEntry, worstAgainstTime });
    }
  } catch (err) {
    logger.error(`Binary tracker error for ${signal.id} (${signal.symbol}): ${err.message}`);
  }
}

async function runBinaryTrackerCycle() {
  const open = await binaryStore.getOpen();
  if (!open.length) return;
  for (const signal of open) {
    // eslint-disable-next-line no-await-in-loop
    await checkOpenBinary(signal);
  }
}

module.exports = { runBinaryTrackerCycle };
