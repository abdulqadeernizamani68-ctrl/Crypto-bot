const store = require('../services/redisStore');
const accuracySvc = require('../services/accuracy');
const { formatStatsMessage, formatSignalJourney } = require('../utils/formatting');
const logger = require('../utils/logger');

async function handleAccuracyCommand() {
  try {
    const allSignals = await store.getAllSignals();
    const stats = accuracySvc.computeStats(allSignals);
    const insights = accuracySvc.buildInsights(allSignals);
    const recent = await store.getRecentSignals(5);
    const recentClosed = recent.filter((s) => s.status === 'CLOSED');

    const parts = [formatStatsMessage(stats)];

    if (recentClosed.length) {
      parts.push('\n*Recent Signals*');
      recentClosed.forEach((s) => parts.push('\n' + formatSignalJourney(s)));
    } else {
      parts.push('\n_No closed signals yet - recent signals are still open/being tracked._');
    }

    parts.push('\n*Learning Insights*');
    insights.forEach((i) => parts.push(`- ${i}`));

    return parts.join('\n');
  } catch (err) {
    logger.error('accuracy command failed:', err.message);
    return `Could not load accuracy stats: ${err.message}`;
  }
}

module.exports = { handleAccuracyCommand };
