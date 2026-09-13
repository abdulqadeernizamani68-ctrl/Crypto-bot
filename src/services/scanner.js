const config = require('../config');
const signalEngine = require('./signalEngine');
const { formatSignalMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs the exact same generateSignal() path as a manual !signal - a
// scanner-found signal is held to the identical bar (confidence, grade, EV,
// risk engine, everything). This only changes WHO checks each pair and WHEN
// the result gets shown, not the decision logic itself.
async function runScanCycle(discordClient) {
  if (!config.scanner.enabled) return;
  if (!config.scanner.channelId) {
    logger.warn('Scanner is enabled but SCANNER_CHANNEL_ID is not set - skipping this cycle.');
    return;
  }

  let channel;
  try {
    channel = await discordClient.channels.fetch(config.scanner.channelId);
  } catch (err) {
    logger.error(`Scanner: could not fetch channel ${config.scanner.channelId}: ${err.message}`);
    return;
  }

  logger.info(`Scanner: checking ${config.scanner.pairs.length} pairs...`);
  const found = [];

  for (const pair of config.scanner.pairs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const signal = await signalEngine.generateSignal(pair);
      if (signal.direction === 'BUY' || signal.direction === 'SELL') {
        found.push(pair);
        // eslint-disable-next-line no-await-in-loop
        await channel.send(`🔔 Auto-scan found a setup:\n\n${formatSignalMessage(signal, { detailed: true })}`);
      }
    } catch (err) {
      logger.error(`Scanner: error checking ${pair}: ${err.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(config.scanner.perPairDelayMs);
  }

  logger.info(`Scanner cycle done. ${found.length}/${config.scanner.pairs.length} pairs had a qualifying setup.`);
}

module.exports = { runScanCycle };
