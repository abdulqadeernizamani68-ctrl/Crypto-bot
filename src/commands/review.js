const store = require('../services/redisStore');
const { formatReviewMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

function normalizePair(raw) {
  if (!raw) return null;
  const p = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5,15}$/.test(p) ? p : null;
}

async function handleReviewCommand(argText) {
  const pair = normalizePair(argText);
  if (!pair) {
    return 'Usage: !review BTCUSDT';
  }

  try {
    const all = await store.getAllSignals();
    const forPair = all
      .filter((s) => s.pair === pair)
      .sort((a, b) => b.signalTime - a.signalTime)
      .slice(0, 15);
    return formatReviewMessage(pair, forPair);
  } catch (err) {
    logger.error('review command failed:', err.message);
    return `Could not load review for ${pair}: ${err.message}`;
  }
}

module.exports = { handleReviewCommand };
