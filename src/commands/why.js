const signalEngine = require('../services/signalEngine');
const { formatSignalMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

function normalizePair(raw) {
  if (!raw) return null;
  const p = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5,15}$/.test(p) ? p : null;
}

async function handleWhyCommand(argText) {
  const pair = normalizePair(argText);
  if (!pair) {
    return 'Usage: !why BTCUSDT\n(Runs the same analysis as !signal but shows the full breakdown)';
  }

  try {
    const signal = await signalEngine.generateSignal(pair, { persist: false });
    return formatSignalMessage(signal, { detailed: true });
  } catch (err) {
    logger.error('why command failed:', err.message);
    return `Could not analyze ${pair}: ${err.message}`;
  }
}

module.exports = { handleWhyCommand };
