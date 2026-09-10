const binance = require('./binance');
const store = require('./redisStore');
const logger = require('../utils/logger');

function pctDiff(a, b) {
  return Number((((a - b) / b) * 100).toFixed(3));
}

async function processCandlesForSignal(signal, candles) {
  let { highestPriceAfter, lowestPriceAfter } = signal;
  let hitResult = null;
  let hitPrice = null;

  for (const c of candles) {
    highestPriceAfter = Math.max(highestPriceAfter, c.high);
    lowestPriceAfter = Math.min(lowestPriceAfter, c.low);

    if (signal.direction === 'BUY') {
      const slHit = c.low <= signal.stopLoss;
      const tpHit = c.high >= signal.takeProfit;
      if (slHit && tpHit) {
        // Both touched within the same candle - assume the closer level (by
        // distance from open) was hit first as a conservative approximation.
        const distToSL = Math.abs(c.open - signal.stopLoss);
        const distToTP = Math.abs(c.open - signal.takeProfit);
        hitResult = distToSL <= distToTP ? 'SL_HIT' : 'TP_HIT';
        hitPrice = hitResult === 'SL_HIT' ? signal.stopLoss : signal.takeProfit;
        break;
      }
      if (slHit) { hitResult = 'SL_HIT'; hitPrice = signal.stopLoss; break; }
      if (tpHit) { hitResult = 'TP_HIT'; hitPrice = signal.takeProfit; break; }
    } else {
      const slHit = c.high >= signal.stopLoss;
      const tpHit = c.low <= signal.takeProfit;
      if (slHit && tpHit) {
        const distToSL = Math.abs(c.open - signal.stopLoss);
        const distToTP = Math.abs(c.open - signal.takeProfit);
        hitResult = distToSL <= distToTP ? 'SL_HIT' : 'TP_HIT';
        hitPrice = hitResult === 'SL_HIT' ? signal.stopLoss : signal.takeProfit;
        break;
      }
      if (slHit) { hitResult = 'SL_HIT'; hitPrice = signal.stopLoss; break; }
      if (tpHit) { hitResult = 'TP_HIT'; hitPrice = signal.takeProfit; break; }
    }
  }

  return { highestPriceAfter, lowestPriceAfter, hitResult, hitPrice };
}

async function recordAdaptiveLearning(signal, won) {
  const categories = Object.keys(signal.categoryScores || {});
  const tradeSign = signal.direction === 'BUY' ? 1 : -1;
  await Promise.all(
    categories.map(async (cat) => {
      const catScore = signal.categoryScores[cat].score;
      // Only attribute credit/blame to categories that actually agreed with
      // the direction taken - a category that disagreed or was neutral
      // wasn't "responsible" for this particular trade's outcome.
      if (Math.sign(catScore) === tradeSign && Math.abs(catScore) > 0.1) {
        await store.recordFilterOutcome(cat, won);
      }
    })
  );
}

async function checkOpenSignal(signal) {
  try {
    const now = Date.now();
    const elapsedMs = now - signal.signalTime;
    const sinceCandles = Math.min(200, Math.max(5, Math.ceil(elapsedMs / (60 * 1000)) + 2));
    const candles = await binance.getSpotKlines(signal.pair, '1m', sinceCandles);
    const relevant = candles.filter((c) => c.openTime >= signal.signalTime);
    if (!relevant.length) return;

    const { highestPriceAfter, lowestPriceAfter, hitResult, hitPrice } =
      await processCandlesForSignal(signal, relevant);

    const mfe = signal.direction === 'BUY'
      ? pctDiff(highestPriceAfter, signal.entry)
      : pctDiff(signal.entry, lowestPriceAfter);
    const mae = signal.direction === 'BUY'
      ? pctDiff(lowestPriceAfter, signal.entry)
      : pctDiff(signal.entry, highestPriceAfter);

    const expired = elapsedMs > signal.validityMinutes * 60 * 1000;

    if (hitResult) {
      const won = hitResult === 'TP_HIT';
      const closed = await store.closeSignal(signal.id, {
        highestPriceAfter,
        lowestPriceAfter,
        mfe,
        mae,
        status: 'CLOSED',
        result: won ? 'WIN' : 'LOSS',
        closeReason: hitResult,
        closePrice: hitPrice,
        closedAt: now,
      });
      await recordAdaptiveLearning(closed, won);
      logger.info(`Signal ${signal.id} closed: ${hitResult}`);
      return;
    }

    if (expired) {
      const lastPrice = relevant[relevant.length - 1].close;
      const favorable = signal.direction === 'BUY'
        ? lastPrice > signal.entry
        : lastPrice < signal.entry;
      const closed = await store.closeSignal(signal.id, {
        highestPriceAfter,
        lowestPriceAfter,
        mfe,
        mae,
        status: 'CLOSED',
        result: favorable ? 'WIN' : 'LOSS',
        closeReason: 'EXPIRED',
        closePrice: lastPrice,
        closedAt: now,
      });
      await recordAdaptiveLearning(closed, favorable);
      logger.info(`Signal ${signal.id} closed: EXPIRED (${favorable ? 'WIN' : 'LOSS'})`);
      return;
    }

    await store.updateSignal(signal.id, { highestPriceAfter, lowestPriceAfter, mfe, mae });
  } catch (err) {
    logger.error(`Tracker error for signal ${signal.id} (${signal.pair}):`, err.message);
  }
}

async function runTrackerCycle() {
  const openSignals = await store.getOpenSignals();
  if (!openSignals.length) return;
  logger.debug(`Tracking ${openSignals.length} open signal(s)...`);
  for (const signal of openSignals) {
    // eslint-disable-next-line no-await-in-loop
    await checkOpenSignal(signal);
  }
}

module.exports = { runTrackerCycle };
