const store = require('../services/redisStore');
const riskEngine = require('../services/riskEngine');
const portfolioRisk = require('../services/portfolioRisk');
const { formatPerformanceMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

async function handlePerformanceCommand() {
  try {
    const allSignals = await store.getAllSignals();
    const risk = riskEngine.assessRisk(allSignals);
    const portfolio = await portfolioRisk.assessPortfolioRisk().catch((err) => {
      logger.warn('portfolio risk check failed:', err.message);
      return null;
    });
    return formatPerformanceMessage(risk, portfolio);
  } catch (err) {
    logger.error('performance command failed:', err.message);
    return `Could not load performance/risk dashboard: ${err.message}`;
  }
}

module.exports = { handlePerformanceCommand };
