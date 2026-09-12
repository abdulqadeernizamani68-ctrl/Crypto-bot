const store = require('../services/redisStore');
const strategyHealth = require('../services/strategyHealth');
const logger = require('../utils/logger');

function formatHealthMessage(h) {
  if (!h.enoughData) {
    return `*Strategy Health*\n\nNot enough closed signals yet (${h.samplesSoFar}/${h.neededForTrend} needed) to measure a real trend. Keep collecting - a trend on too few samples would just be noise.`;
  }
  const lines = [
    '*Strategy Health Monitor*',
    '',
    `Status: ${h.degrading ? '⚠️ DEGRADING' : '✅ Stable'}`,
    `Recent win rate: ${h.recentWinRate}%  (prior window: ${h.priorWinRate}%)`,
    `Recent drawdown: ${h.recentDrawdownR}R  (prior window: ${h.priorDrawdownR}R)`,
  ];
  if (h.alerts.length) {
    lines.push('', 'Alerts:', ...h.alerts.map((a) => `- ${a}`));
  }
  if (h.regimePerformance.length) {
    lines.push('', 'Win rate by regime (5+ samples):');
    h.regimePerformance.forEach((r) => lines.push(`- ${r.regime}: ${r.winRatePct}% (n=${r.samples})`));
  }
  return lines.join('\n');
}

async function handleHealthCommand() {
  try {
    const allSignals = await store.getAllSignals();
    const health = strategyHealth.assessStrategyHealth(allSignals);
    return formatHealthMessage(health);
  } catch (err) {
    logger.error('health command failed:', err.message);
    return `Could not load strategy health: ${err.message}`;
  }
}

module.exports = { handleHealthCommand };
