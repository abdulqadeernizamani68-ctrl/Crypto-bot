const twelvedata = require('./twelvedata');
const binaryStore = require('./binaryStore');
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
      if (signal.direction === 'ABOVE') {
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

      const actualDirection = priceAt.close >= signal.entryPrice ? 'ABOVE' : 'BELOW';
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
        (signal.direction === 'ABOVE' && worstAgainstEntry < signal.entryPrice && finalOutcome.correct) ||
        (signal.direction === 'BELOW' && worstAgainstEntry > signal.entryPrice && finalOutcome.correct);

      let nearMissNote = null;
      if (wentAgainstThenRecovered && worstAgainstTime) {
        const secondsIn = Math.round((worstAgainstTime - signal.signalTime) / 1000);
        const movePct = pctDiff(worstAgainstEntry, signal.entryPrice);
        nearMissNote =
          `Trade ke ${secondsIn} second baad price ${worstAgainstEntry} tak chali gayi thi ` +
          `(entry se ${movePct}%) - agar us waqt expiry hoti to loss hota, lekin final expiry tak ` +
          `price wapas ${signal.direction === 'ABOVE' ? 'upar' : 'neeche'} aa gayi.`;
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
